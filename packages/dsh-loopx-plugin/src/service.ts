import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  coldRestoreBinding,
  createBinding,
  fenceMatches,
  fenceOf,
  sameSessionIdentity,
  schedulerBinding,
  snapshotBinding,
  transitionBinding,
} from './binding.ts'
import { LoopXCliClient, LoopXCliError } from './cli-client.ts'
import { failure, rejected, success } from './errors.ts'
import {
  bootstrapCommandPackSchema,
  heartbeatPromptSchema,
  loopxBindingDomainSpec,
  quotaShouldRunSchema,
  registerAgentSchema,
  startGoalGuidedSchema,
  statusSchema,
  threadBindingCommandSchema,
  todoCommandSchema,
} from './schemas.ts'
import type {
  BootstrapCommandPackPayload,
  HeartbeatPromptPayload,
  QuotaShouldRunPayload,
  StartGoalGuidedPayload,
  TodoCommandPayload,
} from './schemas.ts'
import type {
  LoopXAttachRequest,
  LoopXAttachValue,
  LoopXBindingFence,
  LoopXBindingReason,
  LoopXBindingRow,
  LoopXFailure,
  LoopXHostStatus,
  LoopXIdentitySelection,
  LoopXQuotaDecision,
  LoopXResult,
  LoopXSchedulerHint,
  LoopXServiceApi,
  LoopXSessionRef,
  LoopXStartValue,
  LoopXStatusValue,
  LoopXTaskBody,
  LoopXTodoClaimRequest,
  LoopXTodoCompleteRequest,
  LoopXTodoMutationValue,
  LoopXTodoUpdateRequest,
} from './types.ts'

const HOST_SURFACE = 'deepseek-harness-native'
const RUNTIME_PROFILE = 'generic_cli'
const AGENT_SCOPE = 'DeepSeek Harness same-session LoopX plugin gated by LoopX'
const PUBLIC_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const FORBIDDEN_ACTIVATION_ARGUMENTS = new Set([
  'sessionId',
  'registryPath',
  'taskBody',
  'argv',
])

export interface Config {
  /** Explicit locally installed LoopX executable. Falls back to LOOPX_BIN, then PATH. */
  readonly loopxBin?: string
  /** Project locator used when a Session header has no cwd. */
  readonly project?: string
  /** Optional LoopX global runtime locator. */
  readonly runtimeRoot?: string
  readonly readTimeoutMs?: number
  readonly writeTimeoutMs?: number
  readonly stdoutCapBytes?: number
  readonly stderrCapBytes?: number
  /** Explicit child-only variables. The ambient environment is not inherited. */
  readonly environment?: Readonly<Record<string, string>>
}

interface ResolvedConfig extends Config {
  readonly readTimeoutMs: number
  readonly writeTimeoutMs: number
  readonly stdoutCapBytes: number
  readonly stderrCapBytes: number
  readonly environment: Readonly<Record<string, string>>
}

interface TaskBodyCacheEntry {
  readonly generation: number
  readonly body: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    loopx: LoopXService
  }
}

function present(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function optional<T extends object>(condition: boolean, value: T): T | Record<never, never> {
  return condition ? value : {}
}

function argsWhen(condition: boolean, ...values: string[]): string[] {
  return condition ? values : []
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeFailure(error: unknown, operation: string): LoopXFailure {
  if (error instanceof LoopXCliError) return error.failure
  return failure(
    'LOOPX_CLI_FAILED',
    'The LoopX operation could not be completed.',
    { operation },
  )
}

function readbackFailure(operation: string, message: string): LoopXFailure {
  return failure('LOOPX_READBACK_FAILED', message, { operation })
}

function driverFenceFailure(operation: string): LoopXFailure {
  return failure(
    'LOOPX_DRIVER_NOT_ARMED',
    'The requested Host transition no longer matches the armed binding.',
    { operation },
  )
}

function fenceMatchesSession(
  sessionId: string,
  row: LoopXBindingRow | undefined,
  fence: LoopXBindingFence,
): boolean {
  return fence.sessionId === sessionId && fenceMatches(row, fence)
}

function validateSession(session: LoopXSessionRef): LoopXFailure | undefined {
  if (!present(session.id) || session.id.length > 512 || session.id.includes('\0')) {
    return failure('LOOPX_INVALID_REQUEST', 'The current DSH Session identity is invalid.')
  }
  if (!Number.isSafeInteger(session.identity.createdAt) || session.identity.createdAt < 0) {
    return failure('LOOPX_INVALID_REQUEST', 'The current DSH Session lifecycle is invalid.')
  }
  if (session.identity.cwd?.includes('\0')) {
    return failure('LOOPX_INVALID_REQUEST', 'The current DSH Session working directory is invalid.')
  }
  return undefined
}

function identitySelection(gate: {
  readonly default_action: string
  readonly reason?: string | undefined
  readonly choices: readonly { readonly agent_id: string; readonly label?: string | undefined }[]
  readonly fresh_agent_registration?: { readonly agent_id?: string | undefined } | undefined
}): LoopXIdentitySelection {
  const suggested = present(gate.fresh_agent_registration?.agent_id)
  return Object.freeze({
    kind: 'agent',
    defaultAction: gate.default_action,
    ...optional(gate.reason !== undefined, { reason: gate.reason as string }),
    choices: Object.freeze(gate.choices.map(choice => Object.freeze({
      agentId: choice.agent_id,
      ...optional(choice.label !== undefined, { label: choice.label as string }),
    }))),
    ...optional(suggested !== undefined && PUBLIC_AGENT_ID.test(suggested), {
      freshAgentSuggestedId: suggested as string,
    }),
  })
}

function goalSelection(gate: {
  readonly reason: string
  readonly choices: readonly { readonly goal_id: string }[]
}): LoopXIdentitySelection {
  return Object.freeze({
    kind: 'goal',
    defaultAction: 'select_goal',
    reason: gate.reason,
    choices: Object.freeze(gate.choices.map(choice => Object.freeze({
      goalId: choice.goal_id,
    }))),
  })
}

function modelCheckpoint(payload: StartGoalGuidedPayload): string | undefined {
  const checkpoints = (payload.guided_transaction?.ordered_steps ?? [])
    .filter(step => step.kind === 'model_checkpoint' && present(step.prompt) !== undefined)
  return checkpoints.length === 1 ? present(checkpoints[0]?.prompt) : undefined
}

function activationReadbackMatches(
  payload: BootstrapCommandPackPayload,
  session: LoopXSessionRef,
  goalId: string,
  agentId: string,
): boolean {
  const activation = payload.host_loop_activation
  const input = activation.activation_input
  const forbidden = activation.host_mutation.forbidden_tool_arguments
  const inputKeys = Object.keys(input.arguments)
  return payload.ok
    && payload.goal_id === goalId
    && payload.agent_id === agentId
    && payload.thread_id === session.id
    && payload.thread_agent_binding?.status === 'bound'
    && payload.thread_agent_binding.agent_id === agentId
    && activation.activation_allowed
    && activation.agent_id === agentId
    && activation.goal_id === goalId
    && input.arguments.goalId === goalId
    && input.arguments.agentId === agentId
    && [...FORBIDDEN_ACTIVATION_ARGUMENTS].every(field => forbidden.includes(field))
    && inputKeys.every(field => !FORBIDDEN_ACTIVATION_ARGUMENTS.has(field))
}

function terminalClosureIsComplete(payload: QuotaShouldRunPayload): boolean {
  if (payload.should_run || payload.effective_action !== 'terminal_no_followup') return false
  const projection = payload.goal_frontier_projection
  if (projection === undefined) return false
  const normalized = isRecord(projection.normalized_progress)
    ? projection.normalized_progress
    : undefined
  const frontier = isRecord(projection.remaining_advancement_frontier)
    ? projection.remaining_advancement_frontier
    : undefined
  const monitors = isRecord(projection.monitor_only_lanes)
    ? projection.monitor_only_lanes
    : undefined
  const successors = isRecord(projection.deferred_successors)
    ? projection.deferred_successors
    : undefined
  if (normalized === undefined || frontier === undefined
    || monitors === undefined || successors === undefined) return false
  const zeroValues = [
    normalized.user_open_count,
    normalized.agent_open_count,
    normalized.agent_advancement_open_count,
    normalized.agent_monitor_open_count,
    normalized.agent_monitor_due_count,
    frontier.current_agent_claimed_advancement_count,
    frontier.unclaimed_advancement_count,
    frontier.other_agent_claimed_advancement_count,
    successors.ready_count,
    successors.blocked_count,
    successors.current_agent_ready_count,
  ]
  return projection.terminal_state?.kind === 'no_followup'
    && projection.terminal_state.derived === true
    && projection.terminal_state.source === 'validated_goal_closure'
    && projection.source_completeness?.user_todos === 'valid'
    && projection.source_completeness.agent_todos === 'valid'
    && Array.isArray(projection.acceptance_gaps)
    && projection.acceptance_gaps.length === 0
    && Array.isArray(projection.autonomy_blockers)
    && projection.autonomy_blockers.length === 0
    && projection.replan_required === false
    && zeroValues.every(value => value === 0)
    && monitors.present === false
    && monitors.quiet_until_material_transition === false
}

function schedulerHint(payload: QuotaShouldRunPayload): LoopXSchedulerHint {
  const source = payload.scheduler_hint
  const detail = source.cold_path_detail.local_scheduler
  const resetToken = source.reset_policy.reset_token
  return Object.freeze({
    action: source.action,
    cadenceClass: source.cadence_class,
    resetToken,
    recommendedIntervalMinutes: detail.recommended_interval_minutes,
    ...optional(detail.unchanged_poll_limit !== null, {
      unchangedPollLimit: detail.unchanged_poll_limit as number,
    }),
    afterLimit: detail.after_limit,
  })
}

function boundedStatusProjection(payload: Readonly<Record<string, unknown>>, goalId: string) {
  const queue = isRecord(payload.attention_queue) ? payload.attention_queue : undefined
  const rawItems = Array.isArray(queue?.items) ? queue.items : []
  const items = rawItems.flatMap((value) => {
    if (!isRecord(value) || String(value.goal_id ?? '') !== goalId) return []
    const projected: Record<string, unknown> = { goal_id: goalId }
    for (const key of [
      'status',
      'waiting_on',
      'severity',
      'lifecycle_phase',
      'recommended_action',
    ] as const) {
      if (typeof value[key] === 'string') projected[key] = value[key]
    }
    return [Object.freeze(projected)]
  })
  return Object.freeze({
    schema_version: payload.schema_version,
    ok: payload.ok,
    goal_filter: payload.goal_filter,
    attention_queue: Object.freeze({ items: Object.freeze(items) }),
  })
}

function boundedTodoProjection(payload: TodoCommandPayload): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {
    schema_version: payload.schema_version,
    ok: payload.ok,
    goal_id: payload.goal_id,
  }
  for (const key of [
    'todo_id',
    'status',
    'changed',
    'dry_run',
    'claimed_by',
    'task_class',
    'settlement_result',
  ] as const) {
    if (payload[key] !== undefined) projected[key] = payload[key]
  }
  return Object.freeze(projected)
}

function boundedQuotaProjection(payload: QuotaShouldRunPayload): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = {
    schema_version: payload.schema_version,
    ok: payload.ok,
    mode: payload.mode,
    goal_id: payload.goal_id,
    should_run: payload.should_run,
    effective_action: payload.effective_action,
  }
  for (const key of ['decision', 'state', 'reason'] as const) {
    if (typeof payload[key] === 'string') projected[key] = payload[key]
  }
  return Object.freeze(projected)
}

/** Host-only service. LoopX remains authoritative for all Goal and Todo state. */
export class LoopXService extends Service implements LoopXServiceApi {
  static inject = ['storageDomain']

  static Config: s<Config> = s.object({
    loopxBin: s.string(),
    project: s.string(),
    runtimeRoot: s.string(),
    readTimeoutMs: s.number().step(1).min(1).default(15_000),
    writeTimeoutMs: s.number().step(1).min(1).default(30_000),
    stdoutCapBytes: s.number().step(1).min(1).default(1_048_576),
    stderrCapBytes: s.number().step(1).min(1).default(262_144),
    environment: s.dict(s.string()).default({}),
  })

  private readonly config: ResolvedConfig
  private readonly cli: LoopXCliClient
  private table: KvTable<string, LoopXBindingRow> | undefined
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly taskBodies = new Map<string, TaskBodyCacheEntry>()
  private mutationAdmissionOpen = true

  constructor(ctx: Context, config: Config) {
    super(ctx, 'loopx')
    const resolved = config as ResolvedConfig
    this.config = resolved
    this.cli = new LoopXCliClient({
      ...optional(present(config.loopxBin) !== undefined, {
        loopxBin: present(config.loopxBin) as string,
      }),
      readTimeoutMs: resolved.readTimeoutMs,
      writeTimeoutMs: resolved.writeTimeoutMs,
      stdoutCapBytes: resolved.stdoutCapBytes,
      stderrCapBytes: resolved.stderrCapBytes,
      environment: resolved.environment,
    })
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(loopxBindingDomainSpec)
    this.table = domain.table('sessions')
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await this.cli.close()
      await Promise.all(this.operationTails.values())
      this.taskBodies.clear()
      await domain.close()
      this.table = undefined
    }, 'dsh-loopx-plugin.domainClose')

    const now = Date.now()
    for (const [sessionId, stored] of this.table.entries()) {
      const restored = coldRestoreBinding(stored, now)
      if (restored !== stored && restored.generation !== stored.generation) {
        await this.table.put(sessionId, restored)
      }
    }
  }

  getBinding(session: LoopXSessionRef): LoopXResult<LoopXBindingRow | undefined> {
    const invalid = validateSession(session)
    if (invalid !== undefined) return rejected(invalid)
    const row = this.requireTable().get(session.id)
    if (row === undefined || !sameSessionIdentity(row.session, session.identity)) {
      return success(undefined)
    }
    return success(snapshotBinding(row))
  }

  start(
    session: LoopXSessionRef,
    goalText: string,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStartValue>> {
    const normalizedGoal = present(goalText)
    if (normalizedGoal === undefined) {
      return Promise.resolve(rejected(failure(
        'LOOPX_INVALID_REQUEST',
        'A non-empty Goal description is required.',
        { operation: 'start' },
      )))
    }
    return this.queued(session, 'start', async () => {
      if (this.currentRow(session) !== undefined) {
        return rejected(failure(
          'LOOPX_INVALID_REQUEST',
          'This DSH Session already has a LoopX binding or planning transaction.',
          { operation: 'start' },
        ))
      }
      const project = this.projectFor(session)
      if (project === undefined) return rejected(this.projectRequired('start'))

      let packet: StartGoalGuidedPayload
      try {
        packet = await this.readStartPacket(session, project, normalizedGoal, undefined, signal)
      } catch (error) {
        return rejected(safeFailure(error, 'start'))
      }
      if (!packet.ok) return rejected(readbackFailure('start', 'LoopX rejected the guided Goal start.'))
      if (packet.goal_selection_gate !== undefined) {
        return success({
          kind: 'selection_required',
          selection: goalSelection(packet.goal_selection_gate),
        })
      }

      const gate = packet.guided_transaction?.identity_selection_gate
      if (gate?.default_action === 'register_fresh_agent' && present(packet.goal_id) !== undefined) {
        const agentId = this.freshAgentId()
        const registered = await this.registerFreshAgent(
          session,
          project,
          packet.goal_id as string,
          agentId,
          signal,
        )
        if (!registered.ok) return registered
        try {
          packet = await this.readStartPacket(
            session,
            project,
            normalizedGoal,
            agentId,
            signal,
          )
        } catch (error) {
          return rejected(safeFailure(error, 'start-readback'))
        }
      }
      const remainingGate = packet.guided_transaction?.identity_selection_gate
      if (remainingGate !== undefined) {
        return success({
          kind: 'selection_required',
          ...optional(packet.goal_id !== undefined, { goalId: packet.goal_id as string }),
          selection: identitySelection(remainingGate),
        })
      }
      const goalId = present(packet.goal_id)
      const agentId = present(packet.agent_id ?? undefined)
      const checkpoint = modelCheckpoint(packet)
      if (goalId === undefined || agentId === undefined || checkpoint === undefined
        || packet.host_surface !== HOST_SURFACE
        || packet.thread_id !== session.id
        || packet.thread_agent_binding?.status !== 'bound'
        || packet.thread_agent_binding.agent_id !== agentId) {
        return rejected(readbackFailure(
          'start',
          'LoopX did not return one exact bound identity and model checkpoint.',
        ))
      }
      if (this.currentRow(session) !== undefined) {
        return rejected(readbackFailure('start', 'The Session binding changed during Goal start.'))
      }
      const row = createBinding({
        session,
        goalId,
        agentId,
        projectLocator: packet.project ?? project,
        ...optional(packet.project_connection?.registry !== undefined, {
          registryLocator: packet.project_connection?.registry as string,
        }),
        ...optional(present(this.config.runtimeRoot) !== undefined, {
          runtimeRootLocator: present(this.config.runtimeRoot) as string,
        }),
        phase: 'planning',
        now: Date.now(),
      })
      await this.requireTable().put(session.id, row)
      return success({ kind: 'planning', binding: row, modelCheckpoint: checkpoint })
    })
  }

  attach(
    session: LoopXSessionRef,
    request: LoopXAttachRequest,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXAttachValue>> {
    const goalId = present(request.goalId)
    const requestedAgent = present(request.agentId)
    if (goalId === undefined || (request.newPeer === true && requestedAgent !== undefined)
      || (requestedAgent !== undefined && !PUBLIC_AGENT_ID.test(requestedAgent))) {
      return Promise.resolve(rejected(failure(
        'LOOPX_INVALID_REQUEST',
        'Attach requires a Goal id and either one public-safe agent id or --new-peer.',
        { operation: 'attach' },
      )))
    }
    this.cli.abortScope(session.id)
    return this.queued(session, 'attach', async () => {
      if (this.currentRow(session) !== undefined) {
        return rejected(failure(
          'LOOPX_INVALID_REQUEST',
          'Detach the current LoopX binding before attaching another one.',
          { operation: 'attach' },
        ))
      }
      const project = this.projectFor(session)
      if (project === undefined) return rejected(this.projectRequired('attach'))
      let packet: BootstrapCommandPackPayload
      try {
        packet = await this.readCommandPack(
          session,
          project,
          goalId,
          requestedAgent,
          request.newPeer === true,
          signal,
        )
      } catch (error) {
        return rejected(safeFailure(error, 'attach'))
      }
      if (!packet.ok) return rejected(readbackFailure('attach', 'LoopX rejected the attach readback.'))

      if (requestedAgent === undefined && request.newPeer !== true) {
        const gate = packet.host_loop_activation.identity_selection_gate
        if (gate !== null && gate !== undefined) {
          return success({
            kind: 'selection_required',
            goalId,
            selection: identitySelection(gate),
          })
        }
        if (packet.thread_agent_binding?.status !== 'bound') {
          return success({
            kind: 'selection_required',
            goalId,
            selection: Object.freeze({
              kind: 'agent',
              defaultAction: 'select_agent_identity',
              reason: 'This exact DSH Session has no LoopX thread binding.',
              choices: Object.freeze(
                packet.host_loop_activation.identity_contract.registered_agents
                  .map(value => Object.freeze({ agentId: value })),
              ),
            }),
          })
        }
      }

      let agentId = requestedAgent
      if (request.newPeer === true) {
        agentId = this.freshAgentId()
        const registered = await this.registerFreshAgent(
          session,
          project,
          goalId,
          agentId,
          signal,
          false,
        )
        if (!registered.ok) {
          return registered.error.outcomeUncertain
            ? await this.persistAttachFailure(
                session,
                project,
                packet.project_connection?.registry,
                goalId,
                agentId,
                registered.error,
              )
            : registered
        }
        try {
          packet = await this.readCommandPack(
            session,
            project,
            goalId,
            agentId,
            false,
            signal,
          )
        } catch (error) {
          return rejected(safeFailure(error, 'attach-registration-readback'))
        }
      }
      agentId ??= present(packet.agent_id ?? undefined)
      if (agentId === undefined || !PUBLIC_AGENT_ID.test(agentId)) {
        return rejected(readbackFailure('attach', 'LoopX did not resolve an exact agent identity.'))
      }
      if (!packet.host_loop_activation.identity_contract.registered_agents.includes(agentId)
        || !packet.host_loop_activation.activation_allowed
        || packet.agent_id !== agentId) {
        return rejected(failure(
          'LOOPX_IDENTITY_CONFLICT',
          'The requested LoopX agent is not an authoritative registered lane.',
          { operation: 'attach' },
        ))
      }
      const priorAgent = packet.thread_agent_binding?.status === 'bound'
        ? present(packet.thread_agent_binding.agent_id)
        : undefined
      if (packet.thread_agent_binding?.status === 'conflict') {
        return rejected(failure(
          'LOOPX_IDENTITY_CONFLICT',
          'The LoopX thread binding is conflicted and must be repaired before attach.',
          { operation: 'attach' },
        ))
      }
      if (priorAgent !== undefined && priorAgent !== agentId) {
        const unbound = await this.writeThreadBinding(
          session,
          project,
          goalId,
          priorAgent,
          false,
          signal,
        )
        if (!unbound.ok) {
          return unbound.error.outcomeUncertain
            ? await this.persistAttachFailure(
                session,
                project,
                packet.project_connection?.registry,
                goalId,
                agentId,
                unbound.error,
              )
            : unbound
        }
      }
      if (priorAgent !== agentId) {
        const bound = await this.writeThreadBinding(
          session,
          project,
          goalId,
          agentId,
          true,
          signal,
        )
        if (!bound.ok) {
          return bound.error.outcomeUncertain
            ? await this.persistAttachFailure(
                session,
                project,
                packet.project_connection?.registry,
                goalId,
                agentId,
                bound.error,
              )
            : bound
        }
      }
      try {
        packet = await this.readCommandPack(session, project, goalId, agentId, false, signal)
      } catch (error) {
        return await this.persistAttachFailure(
          session,
          project,
          packet.project_connection?.registry,
          goalId,
          agentId,
          safeFailure(error, 'attach-readback'),
        )
      }
      if (!activationReadbackMatches(packet, session, goalId, agentId)) {
        return await this.persistAttachFailure(
          session,
          project,
          packet.project_connection?.registry,
          goalId,
          agentId,
          readbackFailure(
            'attach-readback',
            'The authoritative LoopX thread and activation readback did not match.',
          ),
          'identity_conflict',
        )
      }
      let body: string
      try {
        body = await this.readTaskBody(
          session.id,
          project,
          packet.project_connection?.registry,
          goalId,
          agentId,
          signal,
        )
      } catch (error) {
        return await this.persistAttachFailure(
          session,
          packet.project,
          packet.project_connection?.registry,
          goalId,
          agentId,
          safeFailure(error, 'attach-task-body'),
        )
      }
      if (this.currentRow(session) !== undefined) {
        return rejected(readbackFailure('attach', 'The Session binding changed during attach.'))
      }
      const row = createBinding({
        session,
        goalId,
        agentId,
        projectLocator: packet.project,
        ...optional(packet.project_connection?.registry !== undefined, {
          registryLocator: packet.project_connection?.registry as string,
        }),
        ...optional(present(this.config.runtimeRoot) !== undefined, {
          runtimeRootLocator: present(this.config.runtimeRoot) as string,
        }),
        phase: 'active_armed',
        now: Date.now(),
      })
      await this.requireTable().put(session.id, row)
      this.taskBodies.set(session.id, { generation: row.generation, body })
      return success({ kind: 'attached', binding: row })
    })
  }

  activate(
    session: LoopXSessionRef,
    goalId: string,
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    return this.queued(session, 'activate', async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound('activate'))
      if (row.phase !== 'planning' || row.goalId !== present(goalId)
        || (present(agentId) !== undefined && row.agentId !== present(agentId))) {
        return rejected(failure(
          'LOOPX_IDENTITY_CONFLICT',
          'Activation must match the exact pending Goal and agent identity.',
          { operation: 'activate' },
        ))
      }
      const before = fenceOf(session.id, row)
      let packet: BootstrapCommandPackPayload
      let body: string
      try {
        packet = await this.readCommandPack(
          session,
          row.projectLocator,
          row.goalId,
          row.agentId,
          false,
          signal,
        )
        if (!activationReadbackMatches(packet, session, row.goalId, row.agentId)) {
          return await this.disarmInsideQueue(
            session,
            row,
            readbackFailure('activate', 'LoopX activation readback did not match the pending binding.'),
          )
        }
        body = await this.readTaskBody(
          session.id,
          row.projectLocator,
          row.registryLocator ?? packet.project_connection?.registry,
          row.goalId,
          row.agentId,
          signal,
        )
      } catch (error) {
        return await this.disarmInsideQueue(session, row, safeFailure(error, 'activate'))
      }
      if (!this.fenceIsCurrent(before)) {
        return rejected(readbackFailure('activate', 'The pending binding changed during activation.'))
      }
      const armed = transitionBinding(row, 'active_armed', undefined, Date.now())
      await this.requireTable().put(session.id, armed)
      this.taskBodies.set(session.id, { generation: armed.generation, body })
      return success(armed)
    })
  }

  async status(
    session: LoopXSessionRef,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStatusValue>> {
    const binding = this.getBinding(session)
    if (!binding.ok) return binding
    const host: LoopXHostStatus = Object.freeze({
      binarySource: this.cli.binarySource,
      ...optional(binding.value !== undefined, { binding: binding.value as LoopXBindingRow }),
    })
    if (binding.value === undefined) return success({ host })
    const row = binding.value
    const before = fenceOf(session.id, row)
    try {
      const payload = await this.cli.runJson({
        operation: 'status',
        kind: 'read',
        args: [
          ...this.locatorArgs(row),
          'status',
          '--goal-id', row.goalId,
          '--agent-id', row.agentId,
        ],
        cwd: row.projectLocator,
        schema: statusSchema,
        signal,
        scopeKey: session.id,
      })
      if (!payload.ok || (payload.goal_filter !== null && payload.goal_filter !== row.goalId)) {
        await this.pauseAfterReadFailure(session, before)
        return rejected(readbackFailure('status', 'LoopX status did not match the current binding.'))
      }
      if (!this.fenceIsCurrent(before)) {
        return rejected(readbackFailure('status', 'The binding changed during status readback.'))
      }
      return success({
        host,
        authority: boundedStatusProjection(payload, row.goalId),
      })
    } catch (error) {
      await this.pauseAfterReadFailure(session, before)
      return rejected(safeFailure(error, 'status'))
    }
  }

  pause(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'user_pause',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    if (expectedFence === undefined) {
      this.cli.abortScope(session.id)
      this.taskBodies.delete(session.id)
    }
    return this.queued(session, 'pause', async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound('pause'))
      if (expectedFence !== undefined
        && !fenceMatchesSession(session.id, row, expectedFence)) {
        return rejected(driverFenceFailure('pause'))
      }
      if (expectedFence !== undefined) {
        this.cli.abortScope(session.id)
        this.taskBodies.delete(session.id)
      }
      const phase = row.phase === 'planning' ? 'planning' : 'active_paused'
      const paused = transitionBinding(row, phase, reason, Date.now())
      await this.requireTable().put(session.id, paused)
      return success(paused)
    })
  }

  resume(
    session: LoopXSessionRef,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    return this.queued(session, 'resume', async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound('resume'))
      if (row.phase === 'planning') {
        return rejected(failure(
          'LOOPX_DRIVER_NOT_ARMED',
          'The pending Goal must be activated before the driver can resume.',
          { operation: 'resume' },
        ))
      }
      let packet: BootstrapCommandPackPayload
      let body: string
      try {
        packet = await this.readCommandPack(
          session,
          row.projectLocator,
          row.goalId,
          row.agentId,
          false,
          signal,
        )
        if (!activationReadbackMatches(packet, session, row.goalId, row.agentId)) {
          return await this.disarmInsideQueue(
            session,
            row,
            readbackFailure('resume', 'LoopX binding readback did not match the paused driver.'),
          )
        }
        body = await this.readTaskBody(
          session.id,
          row.projectLocator,
          row.registryLocator ?? packet.project_connection?.registry,
          row.goalId,
          row.agentId,
          signal,
        )
      } catch (error) {
        return await this.disarmInsideQueue(session, row, safeFailure(error, 'resume'))
      }
      const armed = transitionBinding(row, 'active_armed', undefined, Date.now())
      await this.requireTable().put(session.id, armed)
      this.taskBodies.set(session.id, { generation: armed.generation, body })
      return success(armed)
    })
  }

  detach(
    session: LoopXSessionRef,
    signal?: AbortSignal,
  ): Promise<LoopXResult<{ readonly detached: true }>> {
    this.cli.abortScope(session.id)
    this.taskBodies.delete(session.id)
    return this.queued(session, 'detach', async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound('detach'))
      const result = await this.writeThreadBinding(
        session,
        row.projectLocator,
        row.goalId,
        row.agentId,
        false,
        signal,
      )
      if (!result.ok) {
        return await this.disarmInsideQueue(session, row, result.error)
      }
      await this.requireTable().delete(session.id)
      return success(Object.freeze({ detached: true as const }))
    })
  }

  todoClaim(
    session: LoopXSessionRef,
    request: LoopXTodoClaimRequest,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    const todoId = present(request.todoId)
    if (todoId === undefined) return Promise.resolve(rejected(this.invalidTodo('todo-claim')))
    return this.todoMutation(session, 'todo-claim', [
      'todo', 'claim',
      '--todo-id', todoId,
      '--claimed-by', '__BOUND_AGENT__',
      ...argsWhen(request.role !== undefined, '--role', request.role ?? ''),
    ], todoId, signal)
  }

  todoUpdate(
    session: LoopXSessionRef,
    request: LoopXTodoUpdateRequest,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    const todoId = present(request.todoId)
    const args = ['todo', 'update', '--todo-id', todoId ?? '']
    const fields: readonly [string, string | undefined][] = [
      ['--status', request.status],
      ['--note', present(request.note)],
      ['--evidence', present(request.evidence)],
      ['--reason', present(request.reason)],
      ['--task-class', request.taskClass],
    ]
    for (const [flag, value] of fields) if (value !== undefined) args.push(flag, value)
    if (request.clearClaim === true) args.push('--clear-claim')
    if (todoId === undefined || args.length === 4) {
      return Promise.resolve(rejected(this.invalidTodo('todo-update')))
    }
    return this.todoMutation(session, 'todo-update', args, todoId, signal)
  }

  todoComplete(
    session: LoopXSessionRef,
    request: LoopXTodoCompleteRequest,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    const todoId = present(request.todoId)
    if (todoId === undefined
      || (request.taskLeaseExpectedVersion !== undefined
        && (!Number.isSafeInteger(request.taskLeaseExpectedVersion)
          || request.taskLeaseExpectedVersion < 0))) {
      return Promise.resolve(rejected(this.invalidTodo('todo-complete')))
    }
    const args = ['todo', 'complete', '--todo-id', todoId]
    const fields: readonly [string, string | undefined][] = [
      ['--note', present(request.note)],
      ['--evidence', present(request.evidence)],
      ['--turn-instance-id', present(request.turnInstanceId)],
      ['--task-lease-idempotency-key', present(request.taskLeaseIdempotencyKey)],
      [
        '--task-lease-expected-version',
        request.taskLeaseExpectedVersion === undefined
          ? undefined
          : String(request.taskLeaseExpectedVersion),
      ],
    ]
    for (const [flag, value] of fields) if (value !== undefined) args.push(flag, value)
    if (request.noFollowUp === true) args.push('--no-follow-up')
    return this.todoMutation(session, 'todo-complete', args, todoId, signal)
  }

  async quotaShouldRun(
    session: LoopXSessionRef,
    turnInstanceId: string,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXQuotaDecision>> {
    const turnId = present(turnInstanceId)
    const binding = this.getBinding(session)
    if (!binding.ok) return binding
    const row = binding.value
    if (row === undefined) return rejected(this.notBound('quota-should-run'))
    if (row.phase !== 'active_armed' || turnId === undefined) {
      return rejected(failure(
        'LOOPX_DRIVER_NOT_ARMED',
        'Quota evaluation requires an armed binding and one turn identity.',
        { operation: 'quota-should-run' },
      ))
    }
    const before = fenceOf(session.id, row)
    try {
      const payload = await this.cli.runJson({
        operation: 'quota-should-run',
        kind: 'idempotent-write',
        args: [
          ...this.locatorArgs(row),
          'quota', 'should-run',
          '--goal-id', row.goalId,
          '--agent-id', row.agentId,
          '--runtime-profile', RUNTIME_PROFILE,
          '--include-detail', 'scheduler',
          '--turn-instance-id', turnId,
        ],
        cwd: row.projectLocator,
        schema: quotaShouldRunSchema,
        signal,
        scopeKey: session.id,
      })
      if (!payload.ok || payload.goal_id !== row.goalId
        || payload.agent_identity.agent_id !== row.agentId
        || payload.heartbeat_receipt?.turn_instance_id !== turnId) {
        await this.pauseAfterReadFailure(session, before)
        return rejected(readbackFailure(
          'quota-should-run',
          'LoopX quota did not confirm the current Goal, agent, and turn identity.',
        ))
      }
      if (!this.fenceIsCurrent(before)) {
        return rejected(readbackFailure('quota-should-run', 'The binding changed during quota evaluation.'))
      }
      const hint = schedulerHint(payload)
      return success(Object.freeze({
        goalId: row.goalId,
        agentId: row.agentId,
        turnInstanceId: turnId,
        shouldRun: payload.should_run,
        effectiveAction: payload.effective_action,
        schedulerHint: hint,
        terminalNoFollowup: terminalClosureIsComplete(payload),
        payload: boundedQuotaProjection(payload),
      }))
    } catch (error) {
      const cause = safeFailure(error, 'quota-should-run')
      if (cause.outcomeUncertain) {
        await this.markUncertain(session, 'uncertain_write', before)
      } else if (!cause.retryable) {
        await this.pauseAfterReadFailure(session, before)
      }
      return rejected(cause)
    }
  }

  async taskBody(
    session: LoopXSessionRef,
    generation: number,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTaskBody>> {
    const binding = this.getBinding(session)
    if (!binding.ok) return binding
    const row = binding.value
    if (row === undefined) return rejected(this.notBound('task-body'))
    if (row.phase !== 'active_armed' || row.generation !== generation) {
      return rejected(failure(
        'LOOPX_DRIVER_NOT_ARMED',
        'The requested task body generation is no longer armed.',
        { operation: 'task-body' },
      ))
    }
    const fence = fenceOf(session.id, row)
    const cached = this.taskBodies.get(session.id)
    if (!refresh && cached?.generation === generation) {
      return success({ fence, body: cached.body })
    }
    try {
      const body = await this.readTaskBody(
        session.id,
        row.projectLocator,
        row.registryLocator,
        row.goalId,
        row.agentId,
        signal,
      )
      if (!this.fenceIsCurrent(fence)) {
        return rejected(readbackFailure('task-body', 'The binding changed while task body was loading.'))
      }
      this.taskBodies.set(session.id, { generation, body })
      return success({ fence, body })
    } catch (error) {
      await this.pauseAfterReadFailure(session, fence)
      return rejected(safeFailure(error, 'task-body'))
    }
  }

  updateScheduler(
    session: LoopXSessionRef,
    fence: LoopXBindingFence,
    hint: LoopXSchedulerHint,
    unchangedPollCount: number,
    nextCheckAt?: number,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    return this.queued(session, 'update-scheduler', async () => {
      const row = this.currentRow(session)
      if (!fenceMatchesSession(session.id, row, fence) || row?.phase !== 'active_armed'
        || !Number.isSafeInteger(unchangedPollCount) || unchangedPollCount < 0
        || (nextCheckAt !== undefined
          && (!Number.isSafeInteger(nextCheckAt) || nextCheckAt < 0))) {
        return rejected(failure(
          'LOOPX_DRIVER_NOT_ARMED',
          'The scheduler update no longer matches the armed binding.',
          { operation: 'update-scheduler' },
        ))
      }
      const updated = schedulerBinding(row, hint, unchangedPollCount, nextCheckAt, Date.now())
      await this.requireTable().put(session.id, updated)
      return success(updated)
    })
  }

  fence(session: LoopXSessionRef): LoopXResult<LoopXBindingFence> {
    const binding = this.getBinding(session)
    if (!binding.ok) return binding
    if (binding.value === undefined) return rejected(this.notBound('fence'))
    return success(fenceOf(session.id, binding.value))
  }

  fenceIsCurrent(fence: LoopXBindingFence): boolean {
    return fenceMatches(this.requireTable().get(fence.sessionId), fence)
  }

  markUncertain(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'uncertain_write',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    if (expectedFence === undefined) {
      this.cli.abortScope(session.id)
      this.taskBodies.delete(session.id)
    }
    return this.queued(session, 'mark-uncertain', async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound('mark-uncertain'))
      if (expectedFence !== undefined
        && !fenceMatchesSession(session.id, row, expectedFence)) {
        return rejected(driverFenceFailure('mark-uncertain'))
      }
      if (expectedFence !== undefined) {
        this.cli.abortScope(session.id)
        this.taskBodies.delete(session.id)
      }
      const uncertain = transitionBinding(row, 'uncertain', reason, Date.now())
      await this.requireTable().put(session.id, uncertain)
      return success(uncertain)
    })
  }

  async disposeSession(session: LoopXSessionRef): Promise<void> {
    this.cli.abortScope(session.id)
    this.taskBodies.delete(session.id)
    if (!this.mutationAdmissionOpen || validateSession(session) !== undefined) return
    await this.enqueue(session.id, async () => {
      const row = this.currentRow(session)
      if (row === undefined) return
      const phase = row.phase === 'planning' ? 'planning' : 'active_paused'
      await this.requireTable().put(
        session.id,
        transitionBinding(row, phase, 'session_disposed', Date.now()),
      )
    })
  }

  private async readStartPacket(
    session: LoopXSessionRef,
    project: string,
    goalText: string,
    agentId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StartGoalGuidedPayload> {
    return await this.cli.runJson({
      operation: 'start-goal',
      kind: 'read',
      args: [
        ...this.runtimeArgs(),
        'start-goal', '--guided',
        '--project', project,
        '--thread-id', session.id,
        '--host-surface', HOST_SURFACE,
        ...argsWhen(agentId !== undefined, '--agent-id', agentId ?? ''),
        '--goal-text', goalText,
      ],
      cwd: project,
      schema: startGoalGuidedSchema,
      signal,
      scopeKey: session.id,
    })
  }

  private async readCommandPack(
    session: LoopXSessionRef,
    project: string,
    goalId: string,
    agentId: string | undefined,
    newPeer: boolean,
    signal: AbortSignal | undefined,
  ): Promise<BootstrapCommandPackPayload> {
    return await this.cli.runJson({
      operation: 'bootstrap-command-pack',
      kind: 'read',
      args: [
        ...this.runtimeArgs(),
        'bootstrap-command-pack',
        '--project', project,
        '--goal-id', goalId,
        '--thread-id', session.id,
        '--host-surface', HOST_SURFACE,
        ...argsWhen(agentId !== undefined, '--agent-id', agentId ?? ''),
        ...argsWhen(newPeer, '--new-peer'),
      ],
      cwd: project,
      schema: bootstrapCommandPackSchema,
      signal,
      scopeKey: session.id,
    })
  }

  private async readTaskBody(
    scopeKey: string,
    project: string,
    registry: string | undefined,
    goalId: string,
    agentId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const payload: HeartbeatPromptPayload = await this.cli.runJson({
      operation: 'heartbeat-prompt',
      kind: 'read',
      args: [
        ...this.locatorValues(registry, present(this.config.runtimeRoot)),
        'heartbeat-prompt', '--thin',
        '--goal-id', goalId,
        '--agent-id', agentId,
        '--agent-scope', AGENT_SCOPE,
        '--runtime-profile', RUNTIME_PROFILE,
      ],
      cwd: project,
      schema: heartbeatPromptSchema,
      signal,
      scopeKey,
    })
    const body = present(payload.task_body ?? undefined)
    if (!payload.ok || payload.goal_id !== goalId || payload.agent_id !== agentId
      || body === undefined) {
      throw new LoopXCliError(readbackFailure(
        'heartbeat-prompt',
        'LoopX did not return the bound heartbeat task body.',
      ))
    }
    return body
  }

  private async registerFreshAgent(
    session: LoopXSessionRef,
    project: string,
    goalId: string,
    agentId: string,
    signal: AbortSignal | undefined,
    bindThread = true,
  ): Promise<LoopXResult<undefined>> {
    try {
      const payload = await this.cli.runJson({
        operation: 'register-agent',
        kind: 'write',
        args: [
          ...this.runtimeArgs(),
          'register-agent',
          '--goal-id', goalId,
          '--agent-id', agentId,
          '--require-new',
          '--execute',
        ],
        cwd: project,
        schema: registerAgentSchema,
        signal,
        scopeKey: session.id,
      })
      if (!payload.ok || payload.goal_id !== goalId || !payload.changed || !payload.written
        || payload.global_sync?.ok !== true
        || payload.registration_readback?.verified !== true) {
        return rejected(failure(
          'LOOPX_WRITE_UNCERTAIN',
          'LoopX did not verify the fresh agent registration.',
          { operation: 'register-agent', outcomeUncertain: true },
        ))
      }
      if (!bindThread) return success(undefined)
      return await this.writeThreadBinding(
        session,
        project,
        goalId,
        agentId,
        true,
        signal,
      )
    } catch (error) {
      return rejected(safeFailure(error, 'register-agent'))
    }
  }

  private async writeThreadBinding(
    session: LoopXSessionRef,
    project: string,
    goalId: string,
    agentId: string,
    bind: boolean,
    signal: AbortSignal | undefined,
  ): Promise<LoopXResult<undefined>> {
    const operation = bind ? 'bind-agent-thread' : 'unbind-agent-thread'
    try {
      const payload = await this.cli.runJson({
        operation,
        kind: 'write',
        args: [
          ...this.runtimeArgs(),
          operation,
          '--goal-id', goalId,
          '--thread-id', session.id,
          '--host-surface', HOST_SURFACE,
          '--agent-id', agentId,
          '--execute',
        ],
        cwd: project,
        schema: threadBindingCommandSchema,
        signal,
        scopeKey: session.id,
      })
      const expected = bind ? 'bound' : 'missing'
      if (!payload.ok || payload.goal_id !== goalId
        || payload.thread_id !== session.id
        || payload.host_surface !== HOST_SURFACE
        || payload.agent_id !== agentId
        || payload.binding?.status !== expected
        || payload.binding.thread_id !== session.id
        || payload.binding.host_surface !== HOST_SURFACE
        || (bind && payload.binding.agent_id !== agentId)
        || (!bind && payload.binding.agent_id !== null)
        || payload.global_sync?.ok !== true
        || payload.registration_readback?.verified !== true) {
        return rejected(failure(
          'LOOPX_WRITE_UNCERTAIN',
          `LoopX did not verify the ${bind ? 'bound' : 'unbound'} thread postcondition.`,
          { operation, outcomeUncertain: true },
        ))
      }
      return success(undefined)
    } catch (error) {
      return rejected(safeFailure(error, operation))
    }
  }

  private todoMutation(
    session: LoopXSessionRef,
    operation: string,
    commandArgs: string[],
    todoId: string,
    signal: AbortSignal | undefined,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    return this.queued(session, operation, async () => {
      const row = this.currentRow(session)
      if (row === undefined) return rejected(this.notBound(operation))
      if (row.phase === 'uncertain') {
        return rejected(failure(
          'LOOPX_WRITE_UNCERTAIN',
          'Read back and resume the LoopX binding before another Todo mutation.',
          { operation, outcomeUncertain: true },
        ))
      }
      const args = commandArgs.map(value => value === '__BOUND_AGENT__' ? row.agentId : value)
      args.push('--goal-id', row.goalId, '--agent-id', row.agentId)
      try {
        const payload = await this.cli.runJson({
          operation,
          kind: 'write',
          args: [...this.locatorArgs(row), ...args],
          cwd: row.projectLocator,
          schema: todoCommandSchema,
          signal,
          scopeKey: session.id,
        })
        if (!payload.ok || payload.goal_id !== row.goalId || payload.todo_id !== todoId) {
          return await this.disarmInsideQueue(
            session,
            row,
            failure(
              'LOOPX_WRITE_UNCERTAIN',
              'The LoopX Todo write did not return a verified postcondition.',
              { operation, outcomeUncertain: true },
            ),
          )
        }
        return success(Object.freeze({
          todoId,
          ...optional(payload.status !== undefined, { status: payload.status as string }),
          payload: boundedTodoProjection(payload),
        }))
      } catch (error) {
        return await this.disarmInsideQueue(session, row, safeFailure(error, operation))
      }
    })
  }

  private async disarmInsideQueue<T>(
    session: LoopXSessionRef,
    observed: LoopXBindingRow,
    cause: LoopXFailure,
  ): Promise<LoopXResult<T>> {
    const current = this.currentRow(session)
    if (current !== undefined && current.generation === observed.generation) {
      const uncertain = cause.outcomeUncertain || observed.phase === 'uncertain'
      const phase = uncertain ? 'uncertain' : observed.phase === 'planning' ? 'planning' : 'active_paused'
      const reason: LoopXBindingReason = uncertain ? 'uncertain_write' : 'readback_failed'
      await this.requireTable().put(
        session.id,
        transitionBinding(current, phase, reason, Date.now()),
      )
      this.taskBodies.delete(session.id)
    }
    return rejected(cause)
  }

  private async persistAttachFailure(
    session: LoopXSessionRef,
    project: string,
    registry: string | undefined,
    goalId: string,
    agentId: string,
    cause: LoopXFailure,
    reason?: LoopXBindingReason,
  ): Promise<LoopXResult<LoopXAttachValue>> {
    if (this.currentRow(session) !== undefined) return rejected(cause)
    const now = Date.now()
    const candidate = createBinding({
      session,
      goalId,
      agentId,
      projectLocator: project,
      ...optional(registry !== undefined, { registryLocator: registry as string }),
      ...optional(present(this.config.runtimeRoot) !== undefined, {
        runtimeRootLocator: present(this.config.runtimeRoot) as string,
      }),
      phase: 'active_armed',
      now,
    })
    const outcomeUncertain = cause.outcomeUncertain
    const disarmed = transitionBinding(
      candidate,
      outcomeUncertain ? 'uncertain' : 'active_paused',
      reason ?? (outcomeUncertain ? 'uncertain_write' : 'readback_failed'),
      now,
    )
    await this.requireTable().put(session.id, disarmed)
    this.taskBodies.delete(session.id)
    return rejected(cause)
  }

  private async pauseAfterReadFailure(
    session: LoopXSessionRef,
    expectedFence: LoopXBindingFence,
  ): Promise<void> {
    if (!this.mutationAdmissionOpen) return
    await this.enqueue(session.id, async () => {
      const row = this.currentRow(session)
      if (!fenceMatchesSession(session.id, row, expectedFence)
        || row === undefined || row.phase === 'planning'
        || row.phase === 'active_paused' || row.phase === 'uncertain') return
      await this.requireTable().put(
        session.id,
        transitionBinding(row, 'active_paused', 'readback_failed', Date.now()),
      )
      this.taskBodies.delete(session.id)
    })
  }

  private queued<T>(
    session: LoopXSessionRef,
    operation: string,
    body: () => Promise<LoopXResult<T>>,
  ): Promise<LoopXResult<T>> {
    const invalid = validateSession(session)
    if (invalid !== undefined) return Promise.resolve(rejected(invalid))
    if (!this.mutationAdmissionOpen) {
      return Promise.resolve(rejected(failure(
        'LOOPX_SERVICE_CLOSED',
        'The LoopX Host service is shutting down.',
        { operation },
      )))
    }
    return this.enqueue(session.id, body).catch(() => rejected(failure(
      'LOOPX_CLI_FAILED',
      'The LoopX Host operation failed before its postcondition was stored.',
      { operation },
    )))
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }

  private currentRow(session: LoopXSessionRef): LoopXBindingRow | undefined {
    const row = this.requireTable().get(session.id)
    return row !== undefined && sameSessionIdentity(row.session, session.identity)
      ? row
      : undefined
  }

  private projectFor(session: LoopXSessionRef): string | undefined {
    return present(this.config.project) ?? present(session.identity.cwd)
  }

  private runtimeArgs(): string[] {
    const root = present(this.config.runtimeRoot)
    return root === undefined ? [] : ['--runtime-root', root]
  }

  private locatorArgs(row: LoopXBindingRow): string[] {
    return this.locatorValues(row.registryLocator, row.runtimeRootLocator)
  }

  private locatorValues(registry: string | undefined, runtimeRoot: string | undefined): string[] {
    return [
      ...argsWhen(present(registry) !== undefined, '--registry', present(registry) ?? ''),
      ...argsWhen(
        present(runtimeRoot) !== undefined,
        '--runtime-root',
        present(runtimeRoot) ?? '',
      ),
    ]
  }

  private freshAgentId(): string {
    return `dsh-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  }

  private notBound(operation: string): LoopXFailure {
    return failure(
      'LOOPX_SESSION_NOT_BOUND',
      'The current DSH Session is not bound to a LoopX Goal.',
      { operation },
    )
  }

  private invalidTodo(operation: string): LoopXFailure {
    return failure(
      'LOOPX_INVALID_REQUEST',
      'The bounded Todo operation requires a non-empty Todo id and supported fields.',
      { operation },
    )
  }

  private projectRequired(operation: string): LoopXFailure {
    return failure(
      'LOOPX_INVALID_REQUEST',
      'Configure a LoopX project or use a DSH Session with a working directory.',
      { operation },
    )
  }

  private requireTable(): KvTable<string, LoopXBindingRow> {
    if (this.table === undefined) throw new Error('dsh-loopx-plugin: service is not initialized')
    return this.table
  }
}

export default LoopXService
