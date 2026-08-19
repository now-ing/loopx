/** Public Host-only contract shared by the LoopX service, commands, tools, and driver. */

export const LOOPX_HOST_SURFACE = 'deepseek-harness-native' as const
export const LOOPX_HOST_MODE = 'deepseek_harness_native_session' as const

export type LoopXBindingPhase =
  | 'planning'
  | 'active_paused'
  | 'active_armed'
  | 'uncertain'

export type LoopXBindingReason =
  | 'cold_restore'
  | 'user_pause'
  | 'foreign_input'
  | 'loopx_terminal_observed'
  | 'identity_conflict'
  | 'readback_failed'
  | 'uncertain_write'
  | 'session_disposed'
  | 'manual_resume_required'

export interface LoopXSessionIdentity {
  readonly createdAt: number
  readonly cwd?: string | undefined
}

export interface LoopXSessionRef {
  readonly id: string
  readonly identity: LoopXSessionIdentity
}

export interface LoopXBindingRow {
  readonly schemaVersion: 'loopx_dsh_binding_row_v0'
  readonly session: LoopXSessionIdentity
  readonly hostSurface: typeof LOOPX_HOST_SURFACE
  readonly goalId: string
  readonly agentId: string
  readonly projectLocator: string
  readonly registryLocator?: string | undefined
  readonly runtimeRootLocator?: string | undefined
  readonly phase: LoopXBindingPhase
  readonly generation: number
  readonly schedulerResetToken?: string | undefined
  readonly unchangedPollCount: number
  readonly nextCheckAt?: number | undefined
  readonly reason?: LoopXBindingReason | undefined
  readonly bindingCreatedAt: number
  readonly updatedAt: number
}

export interface LoopXBindingFence {
  readonly sessionId: string
  readonly session: LoopXSessionIdentity
  readonly goalId: string
  readonly agentId: string
  readonly generation: number
}

export type LoopXFailureCode =
  | 'LOOPX_SESSION_NOT_BOUND'
  | 'LOOPX_SESSION_LIFECYCLE_MISMATCH'
  | 'LOOPX_IDENTITY_CONFLICT'
  | 'LOOPX_SELECTION_REQUIRED'
  | 'LOOPX_DRIVER_NOT_ARMED'
  | 'LOOPX_INVALID_REQUEST'
  | 'LOOPX_SCHEMA_UNSUPPORTED'
  | 'LOOPX_CLI_NOT_FOUND'
  | 'LOOPX_CLI_TIMEOUT'
  | 'LOOPX_CLI_ABORTED'
  | 'LOOPX_CLI_OUTPUT_LIMIT'
  | 'LOOPX_CLI_FAILED'
  | 'LOOPX_READBACK_FAILED'
  | 'LOOPX_WRITE_UNCERTAIN'
  | 'LOOPX_SERVICE_CLOSED'

export interface LoopXFailure {
  readonly code: LoopXFailureCode
  readonly message: string
  readonly operation?: string
  readonly retryable: boolean
  readonly outcomeUncertain: boolean
}

export type LoopXResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LoopXFailure }

export interface LoopXIdentitySelectionChoice {
  readonly agentId?: string | undefined
  readonly goalId?: string | undefined
  readonly label?: string | undefined
}

export interface LoopXIdentitySelection {
  readonly kind: 'agent' | 'goal'
  readonly defaultAction: string
  readonly reason?: string | undefined
  readonly choices: readonly LoopXIdentitySelectionChoice[]
  readonly freshAgentSuggestedId?: string | undefined
}

export type LoopXStartValue =
  | {
    readonly kind: 'selection_required'
    readonly goalId?: string | undefined
    readonly selection: LoopXIdentitySelection
  }
  | {
    readonly kind: 'planning'
    readonly binding: LoopXBindingRow
    readonly modelCheckpoint: string
  }

export interface LoopXAttachRequest {
  readonly goalId: string
  readonly agentId?: string | undefined
  readonly newPeer?: boolean | undefined
}

export type LoopXAttachValue =
  | {
    readonly kind: 'selection_required'
    readonly goalId: string
    readonly selection: LoopXIdentitySelection
  }
  | { readonly kind: 'attached'; readonly binding: LoopXBindingRow }

export interface LoopXHostStatus {
  readonly binarySource: 'config' | 'environment' | 'path'
  readonly binding?: LoopXBindingRow | undefined
}

export interface LoopXStatusValue {
  readonly host: LoopXHostStatus
  readonly authority?: Readonly<Record<string, unknown>> | undefined
}

export interface LoopXTodoClaimRequest {
  readonly todoId: string
  readonly role?: 'user' | 'agent' | undefined
}

export interface LoopXTodoUpdateRequest {
  readonly todoId: string
  readonly status?: 'open' | 'done' | 'blocked' | 'deferred' | undefined
  readonly note?: string | undefined
  readonly evidence?: string | undefined
  readonly reason?: string | undefined
  readonly taskClass?: 'advancement_task' | 'continuous_monitor' | 'user_gate' | 'user_action' | 'blocker' | undefined
  readonly clearClaim?: boolean | undefined
}

export interface LoopXTodoCompleteRequest {
  readonly todoId: string
  readonly note?: string | undefined
  readonly evidence?: string | undefined
  readonly noFollowUp?: boolean | undefined
  readonly turnInstanceId?: string | undefined
  readonly taskLeaseIdempotencyKey?: string | undefined
  readonly taskLeaseExpectedVersion?: number | undefined
}

export interface LoopXTodoMutationValue {
  readonly todoId: string
  readonly status?: string | undefined
  readonly payload: Readonly<Record<string, unknown>>
}

export interface LoopXSchedulerHint {
  readonly action: string
  readonly cadenceClass: string
  readonly resetToken?: string | undefined
  readonly recommendedIntervalMinutes?: number | undefined
  readonly unchangedPollLimit?: number | undefined
  readonly afterLimit?: string | undefined
}

export interface LoopXQuotaDecision {
  readonly goalId: string
  readonly agentId: string
  readonly turnInstanceId: string
  readonly shouldRun: boolean
  readonly effectiveAction: string
  readonly schedulerHint: LoopXSchedulerHint
  readonly terminalNoFollowup: boolean
  readonly payload: Readonly<Record<string, unknown>>
}

export interface LoopXTaskBody {
  readonly fence: LoopXBindingFence
  readonly body: string
}

export interface LoopXServiceApi {
  getBinding(session: LoopXSessionRef): LoopXResult<LoopXBindingRow | undefined>
  start(session: LoopXSessionRef, goalText: string, signal?: AbortSignal): Promise<LoopXResult<LoopXStartValue>>
  attach(session: LoopXSessionRef, request: LoopXAttachRequest, signal?: AbortSignal): Promise<LoopXResult<LoopXAttachValue>>
  activate(session: LoopXSessionRef, goalId: string, agentId?: string, signal?: AbortSignal): Promise<LoopXResult<LoopXBindingRow>>
  status(session: LoopXSessionRef, signal?: AbortSignal): Promise<LoopXResult<LoopXStatusValue>>
  pause(session: LoopXSessionRef, reason?: LoopXBindingReason, expectedFence?: LoopXBindingFence): Promise<LoopXResult<LoopXBindingRow>>
  resume(session: LoopXSessionRef, signal?: AbortSignal): Promise<LoopXResult<LoopXBindingRow>>
  detach(session: LoopXSessionRef, signal?: AbortSignal): Promise<LoopXResult<{ readonly detached: true }>>
  todoClaim(session: LoopXSessionRef, request: LoopXTodoClaimRequest, signal?: AbortSignal): Promise<LoopXResult<LoopXTodoMutationValue>>
  todoUpdate(session: LoopXSessionRef, request: LoopXTodoUpdateRequest, signal?: AbortSignal): Promise<LoopXResult<LoopXTodoMutationValue>>
  todoComplete(session: LoopXSessionRef, request: LoopXTodoCompleteRequest, signal?: AbortSignal): Promise<LoopXResult<LoopXTodoMutationValue>>
  quotaShouldRun(session: LoopXSessionRef, turnInstanceId: string, signal?: AbortSignal): Promise<LoopXResult<LoopXQuotaDecision>>
  taskBody(session: LoopXSessionRef, generation: number, refresh?: boolean, signal?: AbortSignal): Promise<LoopXResult<LoopXTaskBody>>
  updateScheduler(session: LoopXSessionRef, fence: LoopXBindingFence, hint: LoopXSchedulerHint, unchangedPollCount: number, nextCheckAt?: number): Promise<LoopXResult<LoopXBindingRow>>
  fence(session: LoopXSessionRef): LoopXResult<LoopXBindingFence>
  fenceIsCurrent(fence: LoopXBindingFence): boolean
  markUncertain(session: LoopXSessionRef, reason?: LoopXBindingReason, expectedFence?: LoopXBindingFence): Promise<LoopXResult<LoopXBindingRow>>
  disposeSession(session: LoopXSessionRef): Promise<void>
}
