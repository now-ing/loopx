import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply as applyCommand } from '../src/command.ts'
import { apply as applyTools } from '../src/tools.ts'
import type {
  LoopXAttachRequest,
  LoopXAttachValue,
  LoopXBindingFence,
  LoopXBindingPhase,
  LoopXBindingReason,
  LoopXBindingRow,
  LoopXFailure,
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
} from '../src/types.ts'

const signal = new AbortController().signal

function success<T>(value: T): LoopXResult<T> {
  return { ok: true, value }
}

function failure(
  code: LoopXFailure['code'],
  operation: string,
  outcomeUncertain = false,
): LoopXResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `safe ${operation} failure`,
      operation,
      retryable: false,
      outcomeUncertain,
    },
  }
}

function binding(
  phase: LoopXBindingPhase = 'active_armed',
  overrides: Partial<LoopXBindingRow> = {},
): LoopXBindingRow {
  return {
    schemaVersion: 'loopx_dsh_binding_row_v0',
    session: { createdAt: 42, cwd: 'SENSITIVE_SESSION_CWD' },
    hostSurface: 'deepseek-harness-native',
    goalId: 'goal-a',
    agentId: 'agent-a',
    projectLocator: 'SENSITIVE_PROJECT_LOCATOR',
    registryLocator: 'SENSITIVE_REGISTRY_LOCATOR',
    runtimeRootLocator: 'SENSITIVE_RUNTIME_LOCATOR',
    phase,
    generation: 3,
    unchangedPollCount: 0,
    bindingCreatedAt: 40,
    updatedAt: 42,
    ...overrides,
  }
}

interface StubAgent {
  readonly agent: Agent
  readonly followups: unknown[]
}

function stubAgent(
  id = 'session-current',
  createdAt = 42,
  cwd = 'SENSITIVE_SESSION_CWD',
): StubAgent {
  const followups: unknown[] = []
  const session = {
    id,
    header: { version: 0, id, createdAt, cwd },
  }
  const agent = {
    id,
    session,
    followup(message: unknown) { followups.push(message) },
  } as unknown as Agent
  return { agent, followups }
}

class FakeService implements LoopXServiceApi {
  binding: LoopXBindingRow | undefined
  startResult: LoopXResult<LoopXStartValue> | undefined
  attachResult: LoopXResult<LoopXAttachValue> | undefined
  activateResult: LoopXResult<LoopXBindingRow> | undefined
  statusResult: LoopXResult<LoopXStatusValue> | undefined
  detachResult: LoopXResult<{ readonly detached: true }> | undefined
  todoFailure: LoopXResult<never> | undefined
  readonly sessions: LoopXSessionRef[] = []
  readonly starts: string[] = []
  readonly attaches: LoopXAttachRequest[] = []
  readonly activations: { goalId: string; agentId?: string }[] = []
  readonly claims: LoopXTodoClaimRequest[] = []
  readonly updates: LoopXTodoUpdateRequest[] = []
  readonly completions: LoopXTodoCompleteRequest[] = []
  readonly pauses: LoopXBindingReason[] = []
  readonly pauseFences: Array<LoopXBindingFence | undefined> = []
  readonly uncertainFences: Array<LoopXBindingFence | undefined> = []
  uncertainCalls = 0
  statusCalls = 0

  constructor(initial: LoopXBindingRow | null = binding()) {
    this.binding = initial ?? undefined
  }

  getBinding(session: LoopXSessionRef): LoopXResult<LoopXBindingRow | undefined> {
    this.sessions.push(session)
    return success(this.binding)
  }

  start(
    session: LoopXSessionRef,
    goalText: string,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStartValue>> {
    this.sessions.push(session)
    this.starts.push(goalText)
    const planned = binding('planning')
    this.binding = planned
    return Promise.resolve(this.startResult ?? success({
      kind: 'planning',
      binding: planned,
      modelCheckpoint: '<loopx_planning>write the plan and Todos</loopx_planning>',
    }))
  }

  attach(
    session: LoopXSessionRef,
    request: LoopXAttachRequest,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXAttachValue>> {
    this.sessions.push(session)
    this.attaches.push(request)
    const attached = binding('active_armed', {
      goalId: request.goalId,
      agentId: request.agentId ?? (request.newPeer === true ? 'fresh-peer' : 'agent-a'),
    })
    this.binding = attached
    return Promise.resolve(this.attachResult ?? success({ kind: 'attached', binding: attached }))
  }

  activate(
    session: LoopXSessionRef,
    goalId: string,
    agentId?: string,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    this.sessions.push(session)
    this.activations.push({ goalId, ...(agentId === undefined ? {} : { agentId }) })
    if (this.activateResult !== undefined) return Promise.resolve(this.activateResult)
    if (this.binding === undefined || this.binding.goalId !== goalId
      || (agentId !== undefined && this.binding.agentId !== agentId)) {
      return Promise.resolve(failure('LOOPX_IDENTITY_CONFLICT', 'goal-activate'))
    }
    this.binding = binding('active_armed', {
      goalId: this.binding.goalId,
      agentId: this.binding.agentId,
      generation: this.binding.generation + 1,
    })
    return Promise.resolve(success(this.binding))
  }

  status(
    session: LoopXSessionRef,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStatusValue>> {
    this.sessions.push(session)
    this.statusCalls += 1
    return Promise.resolve(this.statusResult ?? success({
      host: {
        binarySource: 'path',
        ...(this.binding === undefined ? {} : { binding: this.binding }),
      },
      ...(this.binding === undefined ? {} : {
        authority: {
          schema_version: 'loopx_status_v0',
          ok: true,
          goal_filter: this.binding.goalId,
          attention_queue: { items: [{ goal_id: this.binding.goalId, status: 'active' }] },
        },
      }),
    }))
  }

  pause(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'user_pause',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    this.sessions.push(session)
    this.pauses.push(reason)
    this.pauseFences.push(expectedFence)
    if (this.binding === undefined) return Promise.resolve(failure('LOOPX_SESSION_NOT_BOUND', 'pause'))
    this.binding = binding(this.binding.phase === 'planning' ? 'planning' : 'active_paused', {
      goalId: this.binding.goalId,
      agentId: this.binding.agentId,
      generation: this.binding.generation + 1,
      reason,
    })
    return Promise.resolve(success(this.binding))
  }

  resume(session: LoopXSessionRef): Promise<LoopXResult<LoopXBindingRow>> {
    this.sessions.push(session)
    if (this.binding === undefined) return Promise.resolve(failure('LOOPX_SESSION_NOT_BOUND', 'resume'))
    this.binding = binding('active_armed', {
      goalId: this.binding.goalId,
      agentId: this.binding.agentId,
      generation: this.binding.generation + 1,
    })
    return Promise.resolve(success(this.binding))
  }

  detach(session: LoopXSessionRef): Promise<LoopXResult<{ readonly detached: true }>> {
    this.sessions.push(session)
    if (this.detachResult !== undefined) {
      if (!this.detachResult.ok && this.detachResult.error.outcomeUncertain && this.binding !== undefined) {
        this.binding = binding('uncertain', {
          goalId: this.binding.goalId,
          agentId: this.binding.agentId,
          reason: 'uncertain_write',
        })
      }
      return Promise.resolve(this.detachResult)
    }
    this.binding = undefined
    return Promise.resolve(success({ detached: true }))
  }

  todoClaim(
    session: LoopXSessionRef,
    request: LoopXTodoClaimRequest,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    this.sessions.push(session)
    this.claims.push(request)
    if (this.todoFailure !== undefined) return Promise.resolve(this.todoFailure)
    return Promise.resolve(success({
      todoId: request.todoId,
      status: 'claimed',
      payload: { schema_version: 'loopx_todo_command_v0', ok: true, todo_id: request.todoId },
    }))
  }

  todoUpdate(
    session: LoopXSessionRef,
    request: LoopXTodoUpdateRequest,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    this.sessions.push(session)
    this.updates.push(request)
    if (this.todoFailure !== undefined) return Promise.resolve(this.todoFailure)
    return Promise.resolve(success({
      todoId: request.todoId,
      status: request.status,
      payload: { schema_version: 'loopx_todo_command_v0', ok: true, todo_id: request.todoId },
    }))
  }

  todoComplete(
    session: LoopXSessionRef,
    request: LoopXTodoCompleteRequest,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    this.sessions.push(session)
    this.completions.push(request)
    if (this.todoFailure !== undefined) return Promise.resolve(this.todoFailure)
    return Promise.resolve(success({
      todoId: request.todoId,
      status: 'done',
      payload: { schema_version: 'loopx_todo_command_v0', ok: true, todo_id: request.todoId },
    }))
  }

  quotaShouldRun(): Promise<LoopXResult<LoopXQuotaDecision>> {
    return Promise.resolve(failure('LOOPX_DRIVER_NOT_ARMED', 'quota'))
  }

  taskBody(): Promise<LoopXResult<LoopXTaskBody>> {
    return Promise.resolve(failure('LOOPX_DRIVER_NOT_ARMED', 'task-body'))
  }

  updateScheduler(
    _session: LoopXSessionRef,
    _fence: LoopXBindingFence,
    _hint: LoopXSchedulerHint,
    _unchangedPollCount: number,
    _nextCheckAt?: number,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    return Promise.resolve(failure('LOOPX_DRIVER_NOT_ARMED', 'scheduler'))
  }

  fence(): LoopXResult<LoopXBindingFence> {
    return failure('LOOPX_DRIVER_NOT_ARMED', 'fence')
  }

  fenceIsCurrent(): boolean {
    return false
  }

  markUncertain(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'uncertain_write',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    this.sessions.push(session)
    this.uncertainCalls += 1
    this.uncertainFences.push(expectedFence)
    if (this.binding === undefined) return Promise.resolve(failure('LOOPX_SESSION_NOT_BOUND', 'uncertain'))
    this.binding = binding('uncertain', {
      goalId: this.binding.goalId,
      agentId: this.binding.agentId,
      generation: this.binding.generation + 1,
      reason,
    })
    return Promise.resolve(success(this.binding))
  }

  disposeSession(): Promise<void> {
    return Promise.resolve()
  }
}

function invocation(agent: Agent, rawInput: string): CommandInvocation {
  return { commandId: 'command-test', agent, rawInput, signal } as unknown as CommandInvocation
}

function registerCommand(service: LoopXServiceApi): CommandDefinition {
  let definition: CommandDefinition | undefined
  const ctx = {
    loopx: service,
    commands: { register(value: CommandDefinition) { definition = value } },
  } as unknown as Context
  applyCommand(ctx)
  if (definition === undefined) throw new Error('command was not registered')
  return definition
}

function runCommand(service: LoopXServiceApi, agent: Agent, rawInput: string) {
  return registerCommand(service).handler(invocation(agent, rawInput))
}

function registerTools(service: LoopXServiceApi): ReadonlyMap<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>()
  const ctx = {
    loopx: service,
    tools: { register(value: ToolDefinition) { definitions.set(value.name, value) } },
  } as unknown as Context
  applyTools(ctx)
  return definitions
}

async function callTool(
  definitions: ReadonlyMap<string, ToolDefinition>,
  name: string,
  args: unknown,
  agent?: Agent,
): Promise<Record<string, unknown>> {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  const exec = {
    name,
    arguments: args,
    agent,
    signal,
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    token: Symbol(name),
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
  const value = await definition.execute(args, exec)
  expect(validateJsonSchemaValue(definition.output.schema, value, '')).toEqual([])
  return value as Record<string, unknown>
}

function errorCode(value: Record<string, unknown>): unknown {
  return (value.error as Record<string, unknown> | undefined)?.code
}

describe('/loopx command', () => {
  it('registers one command and renders Host sidecar separately from live LoopX authority', async () => {
    const service = new FakeService()
    const current = stubAgent()
    const definition = registerCommand(service)
    expect(definition.name).toBe('loopx')

    const result = await definition.handler(invocation(current.agent, ''))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('DSH Host sidecar (Host binding/driver state; not Goal or Todo authority)')
    expect(result.text).toContain('LoopX authoritative state (live CLI readback)')
    expect(result.text).not.toContain('SENSITIVE_PROJECT_LOCATOR')
    expect(result.text).not.toContain('SENSITIVE_REGISTRY_LOCATOR')
  })

  it('preserves selection gates, then queues the formal planning checkpoint as same-Agent plugin input', async () => {
    const current = stubAgent()
    const selectionService = new FakeService(null)
    selectionService.startResult = success({
      kind: 'selection_required',
      goalId: 'goal-a',
      selection: {
        kind: 'agent',
        defaultAction: 'select_agent_identity',
        choices: [{ agentId: 'only-agent' }],
      },
    })
    const selection = await runCommand(selectionService, current.agent, ' start ship the plugin ')
    expect(selection).toMatchObject({ kind: 'error' })
    expect(selection.text).toContain('will not infer one from Goal agent count')
    expect(current.followups).toEqual([])

    const service = new FakeService(null)
    const started = await runCommand(service, current.agent, ' finish the same-session adapter ')
    expect(started.kind).toBe('success')
    expect(service.starts).toEqual(['finish the same-session adapter'])
    expect(current.followups).toHaveLength(1)
    expect(current.followups[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-loopx-plugin' },
      content: [{ type: 'text', text: '<loopx_planning>write the plan and Todos</loopx_planning>' }],
    })
    expect(service.binding?.phase).toBe('planning')

    const activated = await callTool(registerTools(service), 'loopx_goal_activate', {
      goalId: 'goal-a',
      agentId: 'agent-a',
    }, current.agent)
    expect(activated).toMatchObject({ ok: true, value: { phase: 'active_armed' } })
    expect(service.binding?.phase).toBe('active_armed')
  })

  it('maps attach selection, explicit takeover, and --new-peer without guessing identity', async () => {
    const current = stubAgent()
    const selectionService = new FakeService(null)
    selectionService.attachResult = success({
      kind: 'selection_required',
      goalId: 'goal-a',
      selection: {
        kind: 'agent',
        defaultAction: 'select_agent_identity',
        choices: [{ agentId: 'agent-a' }],
      },
    })
    const selected = await runCommand(selectionService, current.agent, ' attach goal-a ')
    expect(selected.kind).toBe('error')
    expect(selected.text).toContain('identity selection is required')
    expect(selectionService.attaches).toEqual([{ goalId: 'goal-a' }])

    const takeover = new FakeService(null)
    expect((await runCommand(takeover, current.agent, ' attach goal-a agent-b ')).kind).toBe('success')
    expect(takeover.attaches).toEqual([{ goalId: 'goal-a', agentId: 'agent-b' }])

    const peer = new FakeService(null)
    expect((await runCommand(peer, current.agent, ' attach goal-a --new-peer ')).kind).toBe('success')
    expect(peer.attaches).toEqual([{ goalId: 'goal-a', newPeer: true }])
  })

  it('keeps a cold-restored binding paused until explicit resume', async () => {
    const current = stubAgent()
    const service = new FakeService(binding('active_paused', { reason: 'cold_restore' }))
    const status = await runCommand(service, current.agent, '')
    expect(status.text).toContain('active_paused (cold_restore)')
    expect(service.binding?.phase).toBe('active_paused')

    const resumed = await runCommand(service, current.agent, ' resume ')
    expect(resumed.kind).toBe('success')
    expect(service.binding?.phase).toBe('active_armed')
  })

  it('pauses only the Host driver and detaches only the exact Session binding', async () => {
    const current = stubAgent()
    const service = new FakeService()
    const paused = await runCommand(service, current.agent, ' pause ')
    expect(paused).toEqual({
      kind: 'success',
      text: 'Paused the DSH continuation driver. LoopX Goal and Todo state were not changed.',
    })
    expect(service.binding?.phase).toBe('active_paused')

    await runCommand(service, current.agent, ' resume ')
    const detached = await runCommand(service, current.agent, ' detach ')
    expect(detached.kind).toBe('success')
    expect(detached.text).toContain('LoopX Goal, Todo, quota, and global scheduler state were not changed')
    expect(service.binding).toBeUndefined()
  })

  it('reports detach uncertainty and never claims the LoopX Goal was changed', async () => {
    const current = stubAgent()
    const service = new FakeService()
    service.detachResult = failure('LOOPX_WRITE_UNCERTAIN', 'detach', true)
    const result = await runCommand(service, current.agent, ' detach ')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('LOOPX_WRITE_UNCERTAIN')
    expect(result.text).toContain('outcome is uncertain')
    expect(service.binding?.phase).toBe('uncertain')
  })
})

describe('bounded LoopX model tools', () => {
  it('registers exactly five typed tools', () => {
    const tools = registerTools(new FakeService())
    expect([...tools.keys()]).toEqual([
      'loopx_goal_activate',
      'loopx_status',
      'loopx_todo_claim',
      'loopx_todo_update',
      'loopx_todo_complete',
    ])
  })

  it('returns the fixed unbound failure without asking status to invent a binding', async () => {
    const service = new FakeService(null)
    const tools = registerTools(service)
    const result = await callTool(tools, 'loopx_status', {}, stubAgent().agent)
    expect(result).toMatchObject({ schemaVersion: 'dsh_loopx_tool_result_v0', ok: false })
    expect(errorCode(result)).toBe('LOOPX_SESSION_NOT_BOUND')
    expect(service.statusCalls).toBe(0)
  })

  it('derives exact current Session lifecycle identity for every mutation', async () => {
    const service = new FakeService()
    const tools = registerTools(service)
    const current = stubAgent('session-exact', 777, 'SENSITIVE_EXACT_CWD')
    const result = await callTool(tools, 'loopx_todo_claim', {
      todoId: 'todo-a',
      role: 'agent',
    }, current.agent)
    expect(result.ok).toBe(true)
    expect(service.claims).toEqual([{ todoId: 'todo-a', role: 'agent' }])
    expect(service.sessions.at(-1)).toEqual({
      id: 'session-exact',
      identity: { createdAt: 777, cwd: 'SENSITIVE_EXACT_CWD' },
    })

    const mismatched = stubAgent('session-a')
    Object.defineProperty(mismatched.agent, 'id', { value: 'session-b' })
    const denied = await callTool(tools, 'loopx_todo_claim', { todoId: 'todo-b' }, mismatched.agent)
    expect(errorCode(denied)).toBe('LOOPX_SESSION_LIFECYCLE_MISMATCH')

    const missing = stubAgent('session-missing')
    Object.defineProperty(missing.agent, 'id', { value: undefined })
    const missingDenied = await callTool(
      tools,
      'loopx_todo_claim',
      { todoId: 'todo-c' },
      missing.agent,
    )
    expect(errorCode(missingDenied)).toBe('LOOPX_SESSION_LIFECYCLE_MISMATCH')
  })

  it('completes the two-phase start only for the exact pending Goal and agent', async () => {
    const service = new FakeService(binding('planning'))
    const tools = registerTools(service)
    const current = stubAgent()

    const denied = await callTool(tools, 'loopx_goal_activate', {
      goalId: 'goal-other',
      agentId: 'agent-a',
    }, current.agent)
    expect(errorCode(denied)).toBe('LOOPX_IDENTITY_CONFLICT')
    expect(service.binding?.phase).toBe('planning')

    const activated = await callTool(tools, 'loopx_goal_activate', {
      goalId: 'goal-a',
      agentId: 'agent-a',
    }, current.agent)
    expect(activated).toMatchObject({
      schemaVersion: 'dsh_loopx_tool_result_v0',
      ok: true,
      value: { goalId: 'goal-a', agentId: 'agent-a', phase: 'active_armed' },
    })
    expect(JSON.stringify(activated)).not.toContain('SENSITIVE_')
  })

  it('rejects alternate identity, private locator, task-body, and arbitrary command fields and pauses an armed driver', async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['loopx_status', { sessionId: 'another-session' }],
      ['loopx_status', { goalId: 'another-goal' }],
      ['loopx_todo_claim', { todoId: 'todo-a', agentId: 'another-agent' }],
      ['loopx_todo_update', { todoId: 'todo-a', argv: ['status'] }],
      ['loopx_todo_complete', { todoId: 'todo-a', registryPath: 'SENSITIVE_REGISTRY_LOCATOR' }],
      ['loopx_goal_activate', { goalId: 'goal-a', taskBody: 'forged' }],
    ]
    for (const [name, args] of cases) {
      const service = new FakeService()
      const result = await callTool(registerTools(service), name, args, stubAgent().agent)
      expect(errorCode(result), name).toBe('LOOPX_INVALID_REQUEST')
      expect(service.binding?.phase, name).toBe('active_paused')
      expect(service.pauses, name).toContain('manual_resume_required')
      expect(service.pauseFences.at(-1), name).toMatchObject({ generation: 3 })
    }
  })

  it('maps the bounded Todo fields and returns stable success envelopes', async () => {
    const service = new FakeService()
    const tools = registerTools(service)
    const current = stubAgent().agent
    const update = await callTool(tools, 'loopx_todo_update', {
      todoId: 'todo-a',
      status: 'blocked',
      reason: 'waiting for an explicit user gate',
      taskClass: 'user_gate',
      clearClaim: true,
    }, current)
    expect(update).toMatchObject({
      schemaVersion: 'dsh_loopx_tool_result_v0',
      ok: true,
      value: { todoId: 'todo-a', status: 'blocked' },
    })
    expect(service.updates).toEqual([{
      todoId: 'todo-a',
      status: 'blocked',
      reason: 'waiting for an explicit user gate',
      taskClass: 'user_gate',
      clearClaim: true,
    }])

    const complete = await callTool(tools, 'loopx_todo_complete', {
      todoId: 'todo-a',
      evidence: 'public-safe evidence pointer',
      noFollowUp: true,
      turnInstanceId: 'turn-a',
      taskLeaseIdempotencyKey: 'lease-key',
      taskLeaseExpectedVersion: 2,
    }, current)
    expect(complete).toMatchObject({ ok: true, value: { todoId: 'todo-a', status: 'done' } })
    expect(service.completions[0]).toMatchObject({
      todoId: 'todo-a',
      noFollowUp: true,
      turnInstanceId: 'turn-a',
      taskLeaseExpectedVersion: 2,
    })
  })

  it('returns uncertain writes as typed failures and disarms through the service API', async () => {
    const service = new FakeService()
    service.todoFailure = failure('LOOPX_WRITE_UNCERTAIN', 'todo-update', true)
    const result = await callTool(registerTools(service), 'loopx_todo_update', {
      todoId: 'todo-a',
      status: 'done',
    }, stubAgent().agent)
    expect(result).toMatchObject({
      schemaVersion: 'dsh_loopx_tool_result_v0',
      ok: false,
      error: { code: 'LOOPX_WRITE_UNCERTAIN', outcomeUncertain: true },
    })
    expect(service.uncertainCalls).toBe(1)
    expect(service.uncertainFences).toMatchObject([{ generation: 3 }])
    expect(service.binding?.phase).toBe('uncertain')
  })

  it('pauses an armed driver on a typed schema/readback boundary failure', async () => {
    const service = new FakeService()
    service.statusResult = failure('LOOPX_SCHEMA_UNSUPPORTED', 'status')
    const result = await callTool(
      registerTools(service),
      'loopx_status',
      {},
      stubAgent().agent,
    )
    expect(errorCode(result)).toBe('LOOPX_SCHEMA_UNSUPPORTED')
    expect(service.pauses).toEqual(['manual_resume_required'])
    expect(service.pauseFences).toMatchObject([{ generation: 3 }])
    expect(service.binding?.phase).toBe('active_paused')
  })

  it('status labels Host sidecar and LoopX authority without leaking locators', async () => {
    const service = new FakeService()
    const result = await callTool(
      registerTools(service),
      'loopx_status',
      {},
      stubAgent().agent,
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        dshHostSidecar: { authority: 'host_binding_and_driver_only' },
        loopxAuthority: { schema_version: 'loopx_status_v0' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_')
  })
})
