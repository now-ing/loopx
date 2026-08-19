import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {
  LoopXAttachValue,
  LoopXBindingRow,
  LoopXFailure,
  LoopXIdentitySelection,
  LoopXResult,
  LoopXServiceApi,
  LoopXSessionRef,
  LoopXStatusValue,
} from './types.ts'

export const name = 'dsh-loopx-command'
export const inject = ['commands', 'loopx']

const PLUGIN_ID = 'dsh-loopx-plugin'
const USAGE = 'Usage: /loopx [<goal>|start <goal>|attach <goal-id> [<agent-id>|--new-peer]|status|pause|resume|detach]'

function invalidRequest(message: string): LoopXFailure {
  return Object.freeze({
    code: 'LOOPX_INVALID_REQUEST',
    message,
    operation: 'command',
    retryable: false,
    outcomeUncertain: false,
  })
}

function lifecycleMismatch(message: string, operation: string): LoopXFailure {
  return Object.freeze({
    code: 'LOOPX_SESSION_LIFECYCLE_MISMATCH',
    message,
    operation,
    retryable: false,
    outcomeUncertain: false,
  })
}

/** Derive the only Session identity a command or tool is allowed to operate on. */
export function deriveLoopXSessionRef(
  agent: Agent | undefined,
  operation: string,
): LoopXResult<LoopXSessionRef> {
  if (agent === undefined) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: 'LOOPX_INVALID_REQUEST',
        message: 'LoopX operations require the current DSH Agent execution.',
        operation,
        retryable: false,
        outcomeUncertain: false,
      }),
    })
  }
  const agentId: unknown = agent.id
  const sessionId: unknown = agent.session.id
  const headerId: unknown = agent.session.header.id
  if (typeof agentId !== 'string' || typeof sessionId !== 'string'
    || typeof headerId !== 'string' || sessionId.length === 0
    || agentId !== sessionId || headerId !== sessionId) {
    return Object.freeze({
      ok: false,
      error: lifecycleMismatch('The current Agent and DSH Session identities do not match.', operation),
    })
  }
  const { createdAt, cwd } = agent.session.header
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    return Object.freeze({
      ok: false,
      error: lifecycleMismatch('The current DSH Session lifecycle identity is invalid.', operation),
    })
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      id: sessionId,
      identity: Object.freeze({ createdAt, ...(cwd === undefined ? {} : { cwd }) }),
    }),
  })
}

function commandFailure(error: LoopXFailure): CommandResult {
  const uncertainty = error.outcomeUncertain
    ? ' The write outcome is uncertain; read back the binding before retrying.'
    : ''
  return {
    kind: 'error',
    text: `${error.code}: ${error.message}${uncertainty}`,
  }
}

function safeBinding(binding: LoopXBindingRow): Readonly<Record<string, unknown>> {
  return Object.freeze({
    goalId: binding.goalId,
    agentId: binding.agentId,
    phase: binding.phase,
    generation: binding.generation,
    ...(binding.reason === undefined ? {} : { reason: binding.reason }),
  })
}

function renderSelection(selection: LoopXIdentitySelection): string {
  const choices = selection.choices.map((choice) => {
    const identity = choice.agentId ?? choice.goalId ?? '<unknown>'
    return choice.label === undefined ? identity : `${identity} (${choice.label})`
  })
  return [
    `LoopX identity selection is required (${selection.defaultAction}).`,
    ...(selection.reason === undefined ? [] : [selection.reason]),
    ...(choices.length === 0 ? [] : [`Choices: ${choices.join(', ')}`]),
    ...(selection.freshAgentSuggestedId === undefined
      ? []
      : [`Suggested fresh agent: ${selection.freshAgentSuggestedId}`]),
    'Choose an exact identity; this plugin will not infer one from Goal agent count.',
  ].join('\n')
}

function renderStatus(value: LoopXStatusValue): string {
  const binding = value.host.binding
  const hostLines = binding === undefined
    ? ['Binding: none']
    : [
        `Binding: ${JSON.stringify(safeBinding(binding))}`,
        `Driver: ${binding.phase}${binding.reason === undefined ? '' : ` (${binding.reason})`}`,
      ]
  const authority = value.authority === undefined
    ? 'Unavailable because this Session has no binding.'
    : JSON.stringify(value.authority)
  return [
    'DSH Host sidecar (Host binding/driver state; not Goal or Todo authority)',
    `LoopX binary source: ${value.host.binarySource}`,
    ...hostLines,
    '',
    'LoopX authoritative state (live CLI readback)',
    authority,
  ].join('\n')
}

function pluginCheckpoint(text: string): UserMessage {
  const content = Object.freeze([Object.freeze({ type: 'text' as const, text })])
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content,
    source: Object.freeze({ kind: 'plugin' as const, plugin: PLUGIN_ID }),
  }) as unknown as UserMessage
}

function exactControlInput(input: string, control: string): CommandResult | undefined {
  if (input === control) return undefined
  return { kind: 'error', text: `${control} does not accept arguments. ${USAGE}` }
}

async function statusCommand(
  service: LoopXServiceApi,
  session: LoopXSessionRef,
  signal: AbortSignal,
  includeUsage: boolean,
): Promise<CommandResult> {
  const result = await service.status(session, signal)
  if (!result.ok) return commandFailure(result.error)
  return {
    kind: 'success',
    text: `${renderStatus(result.value)}${includeUsage ? `\n\n${USAGE}` : ''}`,
  }
}

async function startCommand(
  service: LoopXServiceApi,
  invocation: CommandInvocation,
  session: LoopXSessionRef,
  goalText: string,
): Promise<CommandResult> {
  if (goalText.length === 0) {
    return { kind: 'error', text: `A Goal description is required. ${USAGE}` }
  }
  const result = await service.start(session, goalText, invocation.signal)
  if (!result.ok) return commandFailure(result.error)
  if (result.value.kind === 'selection_required') {
    return { kind: 'error', text: renderSelection(result.value.selection) }
  }
  try {
    invocation.agent.followup(pluginCheckpoint(result.value.modelCheckpoint))
  } catch {
    return {
      kind: 'error',
      text: 'LOOPX_CHECKPOINT_DELIVERY_FAILED: The planning binding remains disarmed, but its model checkpoint could not be queued in this DSH Session.',
    }
  }
  return {
    kind: 'success',
    text: [
      `LoopX planning started for Goal ${result.value.binding.goalId} on agent ${result.value.binding.agentId}.`,
      'The formal planning checkpoint was queued as a plugin-owned follow-up in this Session.',
      'The driver remains disarmed until the model calls loopx_goal_activate with the exact pending identity.',
    ].join('\n'),
  }
}

function parseAttach(input: string): LoopXResult<{
  readonly goalId: string
  readonly agentId?: string
  readonly newPeer?: true
}> {
  const tokens = input.split(/\s+/u)
  if (tokens[0] !== 'attach' || tokens.length < 2 || tokens.length > 3) {
    return Object.freeze({
      ok: false,
      error: invalidRequest(`Attach requires one Goal id and optionally an agent id or --new-peer. ${USAGE}`),
    })
  }
  const goalId = tokens[1]
  const selection = tokens[2]
  if (goalId === undefined || goalId.startsWith('--')
    || (selection !== undefined && selection.startsWith('--') && selection !== '--new-peer')) {
    return Object.freeze({
      ok: false,
      error: invalidRequest(`Attach contains an unsupported option. ${USAGE}`),
    })
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      goalId,
      ...(selection === '--new-peer'
        ? { newPeer: true as const }
        : selection === undefined ? {} : { agentId: selection }),
    }),
  })
}

function renderAttach(value: LoopXAttachValue): CommandResult {
  if (value.kind === 'selection_required') {
    return { kind: 'error', text: renderSelection(value.selection) }
  }
  return {
    kind: 'success',
    text: [
      `Attached this DSH Session to LoopX Goal ${value.binding.goalId}, agent ${value.binding.agentId}.`,
      'The binding passed authoritative readback and the local continuation driver is armed.',
    ].join('\n'),
  }
}

/** Execute one human `/loopx` command against the frozen Host service contract. */
async function executeLoopXCommand(
  service: LoopXServiceApi,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const current = deriveLoopXSessionRef(invocation.agent, 'command')
  if (!current.ok) return commandFailure(current.error)
  const session = current.value
  const input = invocation.rawInput.trim()
  if (input.length === 0) return statusCommand(service, session, invocation.signal, true)

  const firstSeparator = input.search(/\s/u)
  const command = firstSeparator < 0 ? input : input.slice(0, firstSeparator)
  const remainder = firstSeparator < 0 ? '' : input.slice(firstSeparator).trim()

  if (command === 'start') {
    return startCommand(service, invocation, session, remainder)
  }
  if (command === 'attach') {
    const request = parseAttach(input)
    if (!request.ok) return commandFailure(request.error)
    const result = await service.attach(session, request.value, invocation.signal)
    return result.ok ? renderAttach(result.value) : commandFailure(result.error)
  }
  if (command === 'status') {
    const invalid = exactControlInput(input, 'status')
    return invalid ?? statusCommand(service, session, invocation.signal, false)
  }
  if (command === 'pause') {
    const invalid = exactControlInput(input, 'pause')
    if (invalid !== undefined) return invalid
    const result = await service.pause(session, 'user_pause')
    return result.ok
      ? { kind: 'success', text: 'Paused the DSH continuation driver. LoopX Goal and Todo state were not changed.' }
      : commandFailure(result.error)
  }
  if (command === 'resume') {
    const invalid = exactControlInput(input, 'resume')
    if (invalid !== undefined) return invalid
    const result = await service.resume(session, invocation.signal)
    return result.ok
      ? {
          kind: 'success',
          text: `Resumed and revalidated LoopX Goal ${result.value.goalId}, agent ${result.value.agentId}; the driver is armed.`,
        }
      : commandFailure(result.error)
  }
  if (command === 'detach') {
    const invalid = exactControlInput(input, 'detach')
    if (invalid !== undefined) return invalid
    const result = await service.detach(session, invocation.signal)
    return result.ok
      ? {
          kind: 'success',
          text: 'Detached this DSH Session. LoopX Goal, Todo, quota, and global scheduler state were not changed.',
        }
      : commandFailure(result.error)
  }

  return startCommand(service, invocation, session, input)
}

/** Register the global human command without reading or changing DSH Goal state. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'loopx',
    description: 'start, attach, pause, resume, detach, or inspect a LoopX Goal in this Session',
    input: { hint: '[<goal>|start <goal>|attach <goal-id> [<agent-id>|--new-peer]|status|pause|resume|detach]' },
    handler: invocation => executeLoopXCommand(ctx.loopx, invocation),
  })
}
