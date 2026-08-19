import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { deriveLoopXSessionRef } from './command.ts'
import type {
  LoopXBindingFence,
  LoopXBindingRow,
  LoopXFailure,
  LoopXResult,
  LoopXServiceApi,
  LoopXSessionRef,
  LoopXStatusValue,
  LoopXTodoMutationValue,
} from './types.ts'

export const name = 'dsh-loopx-tools'
export const inject = ['tools', 'loopx']

const RESULT_SCHEMA_VERSION = 'dsh_loopx_tool_result_v0' as const

type ToolEnvelope =
  | {
    readonly schemaVersion: typeof RESULT_SCHEMA_VERSION
    readonly ok: true
    readonly value: JsonValue
  }
  | {
    readonly schemaVersion: typeof RESULT_SCHEMA_VERSION
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message: string
      readonly operation?: string
      readonly retryable: boolean
      readonly outcomeUncertain: boolean
    }
  }

const TOOL_OUTPUT = {
  schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'string', const: RESULT_SCHEMA_VERSION, required: true },
          ok: { type: 'boolean', const: true, required: true },
          value: { type: 'json', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'string', const: RESULT_SCHEMA_VERSION, required: true },
          ok: { type: 'boolean', const: false, required: true },
          error: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              operation: { type: 'string' },
              retryable: { type: 'boolean', required: true },
              outcomeUncertain: { type: 'boolean', required: true },
            },
          },
        },
      },
    ],
  },
  render: (_args: unknown, value: ToolEnvelope) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
} as const

function invalidRequest(message: string, operation: string): LoopXFailure {
  return Object.freeze({
    code: 'LOOPX_INVALID_REQUEST',
    message,
    operation,
    retryable: false,
    outcomeUncertain: false,
  })
}

function notBound(operation: string): LoopXFailure {
  return Object.freeze({
    code: 'LOOPX_SESSION_NOT_BOUND',
    message: 'The current DSH Session has no LoopX binding.',
    operation,
    retryable: false,
    outcomeUncertain: false,
  })
}

function success(value: JsonValue): ToolEnvelope {
  return Object.freeze({ schemaVersion: RESULT_SCHEMA_VERSION, ok: true, value })
}

function rejected(error: LoopXFailure): ToolEnvelope {
  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: false,
    error: Object.freeze({
      code: error.code,
      message: error.message,
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      retryable: error.retryable,
      outcomeUncertain: error.outcomeUncertain,
    }),
  })
}

function hasOnlyKeys(args: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(args).every(key => allowed.has(key))
}

function safeBinding(binding: LoopXBindingRow): JsonValue {
  return {
    goalId: binding.goalId,
    agentId: binding.agentId,
    phase: binding.phase,
    generation: binding.generation,
    ...(binding.reason === undefined ? {} : { reason: binding.reason }),
  }
}

function safeStatus(status: LoopXStatusValue): JsonValue {
  return {
    dshHostSidecar: {
      authority: 'host_binding_and_driver_only',
      binarySource: status.host.binarySource,
      binding: status.host.binding === undefined ? null : safeBinding(status.host.binding),
    },
    loopxAuthority: status.authority === undefined
      ? null
      : status.authority as JsonValue,
  }
}

function safeTodo(value: LoopXTodoMutationValue): JsonValue {
  return {
    todoId: value.todoId,
    status: value.status ?? null,
    loopxAuthority: value.payload as JsonValue,
  }
}

/**
 * Preserve the original typed failure while ensuring suspicious or uncertain
 * writes cannot leave the continuation driver armed.
 */
async function disarmAfterFailure(
  service: LoopXServiceApi,
  session: LoopXSessionRef,
  error: LoopXFailure,
  expectedFence: LoopXBindingFence | undefined,
): Promise<void> {
  if (expectedFence === undefined) return
  try {
    const current = service.getBinding(session)
    if (!current.ok || current.value === undefined) return
    if (error.outcomeUncertain) {
      if (current.value.phase !== 'uncertain') {
        await service.markUncertain(session, 'uncertain_write', expectedFence)
      }
      return
    }
    if (current.value.phase === 'active_armed'
      && error.code !== 'LOOPX_DRIVER_NOT_ARMED'
      && error.code !== 'LOOPX_SERVICE_CLOSED') {
      await service.pause(session, 'manual_resume_required', expectedFence)
    }
  } catch {
    // The original stable failure remains the authoritative tool outcome.
  }
}

async function toolFailure(
  service: LoopXServiceApi,
  session: LoopXSessionRef | undefined,
  error: LoopXFailure,
  expectedFence?: LoopXBindingFence,
): Promise<ToolEnvelope> {
  if (session !== undefined) await disarmAfterFailure(service, session, error, expectedFence)
  return rejected(error)
}

interface BoundLoopXSession {
  readonly session: LoopXSessionRef
  readonly fence: LoopXBindingFence
}

function bindingFence(session: LoopXSessionRef, row: LoopXBindingRow): LoopXBindingFence {
  return Object.freeze({
    sessionId: session.id,
    session: Object.freeze({ ...row.session }),
    goalId: row.goalId,
    agentId: row.agentId,
    generation: row.generation,
  })
}

function currentFence(
  service: LoopXServiceApi,
  session: LoopXSessionRef,
): LoopXBindingFence | undefined {
  const binding = service.getBinding(session)
  return binding.ok && binding.value !== undefined
    ? bindingFence(session, binding.value)
    : undefined
}

function boundSession(
  service: LoopXServiceApi,
  exec: ToolRunContext,
  operation: string,
): LoopXResult<BoundLoopXSession> {
  const current = deriveLoopXSessionRef(exec.agent, operation)
  if (!current.ok) return current
  const binding = service.getBinding(current.value)
  if (!binding.ok) return binding
  if (binding.value === undefined) {
    return Object.freeze({ ok: false, error: notBound(operation) })
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      session: current.value,
      fence: bindingFence(current.value, binding.value),
    }),
  })
}

function invalidKeys(operation: string): LoopXFailure {
  return invalidRequest(
    'Unsupported arguments are forbidden; Session, Goal authority, locators, task body, and command arguments are derived by the plugin.',
    operation,
  )
}

const ACTIVATE_KEYS = new Set(['goalId', 'agentId'])
const CLAIM_KEYS = new Set(['todoId', 'role'])
const UPDATE_KEYS = new Set([
  'todoId', 'status', 'note', 'evidence', 'reason', 'taskClass', 'clearClaim',
])
const COMPLETE_KEYS = new Set([
  'todoId', 'note', 'evidence', 'noFollowUp', 'turnInstanceId',
  'taskLeaseIdempotencyKey', 'taskLeaseExpectedVersion',
])

/** Build immutable tool definitions that close over one Host service instance. */
function loopXToolDefinitions(
  service: LoopXServiceApi,
): readonly ReturnType<typeof defineTool>[] {
  const goalActivate = defineTool({
    name: 'loopx_goal_activate',
    description: 'Activate only the exact pending LoopX Goal binding in the current DSH Session after planning and Todo refresh are complete.',
    parameters: {
      goalId: { type: 'string', required: true, description: 'Exact pending Goal id.' },
      agentId: { type: 'string', description: 'Optional exact pending agent id.' },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec): Promise<ToolEnvelope> {
      const current = deriveLoopXSessionRef(exec.agent, 'goal-activate')
      if (!current.ok) return rejected(current.error)
      if (!hasOnlyKeys(args, ACTIVATE_KEYS)) {
        return toolFailure(
          service,
          current.value,
          invalidKeys('goal-activate'),
          currentFence(service, current.value),
        )
      }
      const bound = boundSession(service, exec, 'goal-activate')
      if (!bound.ok) return toolFailure(service, current.value, bound.error)
      const result = await service.activate(
        bound.value.session,
        args.goalId,
        args.agentId,
        exec.signal,
      )
      if (!result.ok) {
        return toolFailure(
          service,
          bound.value.session,
          result.error,
          bound.value.fence,
        )
      }
      return success(safeBinding(result.value))
    },
  })

  const loopxStatus = defineTool({
    name: 'loopx_status',
    description: 'Read live LoopX authoritative state together with the current DSH Host sidecar state; accepts no alternate identity.',
    parameters: {},
    output: TOOL_OUTPUT,
    async execute(args, exec): Promise<ToolEnvelope> {
      const current = deriveLoopXSessionRef(exec.agent, 'status')
      if (!current.ok) return rejected(current.error)
      if (!hasOnlyKeys(args, new Set())) {
        return toolFailure(
          service,
          current.value,
          invalidKeys('status'),
          currentFence(service, current.value),
        )
      }
      const bound = boundSession(service, exec, 'status')
      if (!bound.ok) return toolFailure(service, current.value, bound.error)
      const result = await service.status(bound.value.session, exec.signal)
      if (!result.ok) {
        return toolFailure(
          service,
          bound.value.session,
          result.error,
          bound.value.fence,
        )
      }
      return success(safeStatus(result.value))
    },
  })

  const todoClaim = defineTool({
    name: 'loopx_todo_claim',
    description: 'Claim one Todo for the exact Goal and agent bound to the current DSH Session.',
    parameters: {
      todoId: { type: 'string', required: true, description: 'Todo id from LoopX.' },
      role: { type: 'string', enum: ['user', 'agent'], description: 'Optional bounded claim role.' },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec): Promise<ToolEnvelope> {
      const current = deriveLoopXSessionRef(exec.agent, 'todo-claim')
      if (!current.ok) return rejected(current.error)
      if (!hasOnlyKeys(args, CLAIM_KEYS)) {
        return toolFailure(
          service,
          current.value,
          invalidKeys('todo-claim'),
          currentFence(service, current.value),
        )
      }
      const bound = boundSession(service, exec, 'todo-claim')
      if (!bound.ok) return toolFailure(service, current.value, bound.error)
      const result = await service.todoClaim(bound.value.session, args, exec.signal)
      if (!result.ok) {
        return toolFailure(
          service,
          bound.value.session,
          result.error,
          bound.value.fence,
        )
      }
      return success(safeTodo(result.value))
    },
  })

  const todoUpdate = defineTool({
    name: 'loopx_todo_update',
    description: 'Update the stable bounded fields of one Todo for the exact current LoopX binding.',
    parameters: {
      todoId: { type: 'string', required: true },
      status: { type: 'string', enum: ['open', 'done', 'blocked', 'deferred'] },
      note: { type: 'string' },
      evidence: { type: 'string' },
      reason: { type: 'string' },
      taskClass: {
        type: 'string',
        enum: ['advancement_task', 'continuous_monitor', 'user_gate', 'user_action', 'blocker'],
      },
      clearClaim: { type: 'boolean' },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec): Promise<ToolEnvelope> {
      const current = deriveLoopXSessionRef(exec.agent, 'todo-update')
      if (!current.ok) return rejected(current.error)
      if (!hasOnlyKeys(args, UPDATE_KEYS)) {
        return toolFailure(
          service,
          current.value,
          invalidKeys('todo-update'),
          currentFence(service, current.value),
        )
      }
      const bound = boundSession(service, exec, 'todo-update')
      if (!bound.ok) return toolFailure(service, current.value, bound.error)
      const result = await service.todoUpdate(bound.value.session, args, exec.signal)
      if (!result.ok) {
        return toolFailure(
          service,
          bound.value.session,
          result.error,
          bound.value.fence,
        )
      }
      return success(safeTodo(result.value))
    },
  })

  const todoComplete = defineTool({
    name: 'loopx_todo_complete',
    description: 'Complete one Todo through LoopX with bounded evidence and exact turn/lease identity for the current binding.',
    parameters: {
      todoId: { type: 'string', required: true },
      note: { type: 'string' },
      evidence: { type: 'string' },
      noFollowUp: { type: 'boolean' },
      turnInstanceId: { type: 'string' },
      taskLeaseIdempotencyKey: { type: 'string' },
      taskLeaseExpectedVersion: { type: 'integer' },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec): Promise<ToolEnvelope> {
      const current = deriveLoopXSessionRef(exec.agent, 'todo-complete')
      if (!current.ok) return rejected(current.error)
      if (!hasOnlyKeys(args, COMPLETE_KEYS)) {
        return toolFailure(
          service,
          current.value,
          invalidKeys('todo-complete'),
          currentFence(service, current.value),
        )
      }
      const bound = boundSession(service, exec, 'todo-complete')
      if (!bound.ok) return toolFailure(service, current.value, bound.error)
      const result = await service.todoComplete(bound.value.session, args, exec.signal)
      if (!result.ok) {
        return toolFailure(
          service,
          bound.value.session,
          result.error,
          bound.value.fence,
        )
      }
      return success(safeTodo(result.value))
    },
  })

  return Object.freeze([goalActivate, loopxStatus, todoClaim, todoUpdate, todoComplete])
}

/** Register five bounded model tools over the current `ctx.loopx` service. */
export function apply(ctx: Context): void {
  for (const definition of loopXToolDefinitions(ctx.loopx)) {
    ctx.tools.register(definition)
  }
}
