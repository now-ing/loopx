import type {
  LoopXBindingFence,
  LoopXBindingPhase,
  LoopXBindingReason,
  LoopXBindingRow,
  LoopXSchedulerHint,
  LoopXSessionIdentity,
  LoopXSessionRef,
} from './types.ts'

function optional<T extends object>(condition: boolean, value: T): T | Record<never, never> {
  return condition ? value : {}
}

export function sameSessionIdentity(
  left: LoopXSessionIdentity,
  right: LoopXSessionIdentity,
): boolean {
  return left.createdAt === right.createdAt && left.cwd === right.cwd
}

export function snapshotBinding(row: LoopXBindingRow): LoopXBindingRow {
  return Object.freeze({
    schemaVersion: row.schemaVersion,
    session: Object.freeze({
      createdAt: row.session.createdAt,
      ...optional(row.session.cwd !== undefined, { cwd: row.session.cwd as string }),
    }),
    hostSurface: row.hostSurface,
    goalId: row.goalId,
    agentId: row.agentId,
    projectLocator: row.projectLocator,
    ...optional(row.registryLocator !== undefined, {
      registryLocator: row.registryLocator as string,
    }),
    ...optional(row.runtimeRootLocator !== undefined, {
      runtimeRootLocator: row.runtimeRootLocator as string,
    }),
    phase: row.phase,
    generation: row.generation,
    ...optional(row.schedulerResetToken !== undefined, {
      schedulerResetToken: row.schedulerResetToken as string,
    }),
    unchangedPollCount: row.unchangedPollCount,
    ...optional(row.nextCheckAt !== undefined, { nextCheckAt: row.nextCheckAt as number }),
    ...optional(row.reason !== undefined, { reason: row.reason as LoopXBindingReason }),
    bindingCreatedAt: row.bindingCreatedAt,
    updatedAt: row.updatedAt,
  })
}

export function createBinding(input: {
  readonly session: LoopXSessionRef
  readonly goalId: string
  readonly agentId: string
  readonly projectLocator: string
  readonly registryLocator?: string
  readonly runtimeRootLocator?: string
  readonly phase: 'planning' | 'active_armed'
  readonly now: number
}): LoopXBindingRow {
  return snapshotBinding({
    schemaVersion: 'loopx_dsh_binding_row_v0',
    session: input.session.identity,
    hostSurface: 'deepseek-harness-native',
    goalId: input.goalId,
    agentId: input.agentId,
    projectLocator: input.projectLocator,
    ...optional(input.registryLocator !== undefined, {
      registryLocator: input.registryLocator as string,
    }),
    ...optional(input.runtimeRootLocator !== undefined, {
      runtimeRootLocator: input.runtimeRootLocator as string,
    }),
    phase: input.phase,
    generation: 1,
    unchangedPollCount: 0,
    bindingCreatedAt: input.now,
    updatedAt: input.now,
  })
}

export function transitionBinding(
  row: LoopXBindingRow,
  phase: LoopXBindingPhase,
  reason: LoopXBindingReason | undefined,
  now: number,
): LoopXBindingRow {
  const {
    reason: _reason,
    schedulerResetToken: _schedulerResetToken,
    nextCheckAt: _nextCheckAt,
    ...base
  } = row
  return snapshotBinding({
    ...base,
    phase,
    generation: row.generation + 1,
    unchangedPollCount: 0,
    updatedAt: Math.max(now, row.updatedAt),
    ...optional(reason !== undefined, { reason: reason as LoopXBindingReason }),
  })
}

export function coldRestoreBinding(row: LoopXBindingRow, now: number): LoopXBindingRow {
  if (row.phase !== 'active_armed') return snapshotBinding(row)
  return transitionBinding(row, 'active_paused', 'cold_restore', now)
}

export function schedulerBinding(
  row: LoopXBindingRow,
  hint: LoopXSchedulerHint,
  unchangedPollCount: number,
  nextCheckAt: number | undefined,
  now: number,
): LoopXBindingRow {
  const {
    schedulerResetToken: _schedulerResetToken,
    nextCheckAt: _nextCheckAt,
    ...base
  } = row
  return snapshotBinding({
    ...base,
    ...optional(hint.resetToken !== undefined, {
      schedulerResetToken: hint.resetToken as string,
    }),
    unchangedPollCount,
    ...optional(nextCheckAt !== undefined, { nextCheckAt: nextCheckAt as number }),
    updatedAt: Math.max(now, row.updatedAt),
  })
}

export function fenceOf(sessionId: string, row: LoopXBindingRow): LoopXBindingFence {
  return Object.freeze({
    sessionId,
    session: Object.freeze({ ...row.session }),
    goalId: row.goalId,
    agentId: row.agentId,
    generation: row.generation,
  })
}

export function fenceMatches(row: LoopXBindingRow | undefined, fence: LoopXBindingFence): boolean {
  return row !== undefined
    && sameSessionIdentity(row.session, fence.session)
    && row.goalId === fence.goalId
    && row.agentId === fence.agentId
    && row.generation === fence.generation
}
