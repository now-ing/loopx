import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  LoopXContinuationDriver,
  type LoopXDriverClock,
} from '../src/driver.ts'
import type {
  LoopXAttachRequest,
  LoopXAttachValue,
  LoopXBindingFence,
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

function success<T>(value: T): LoopXResult<T> {
  return { ok: true, value }
}

function failure(
  code: LoopXFailure['code'],
  operation: string,
  options: { readonly retryable?: boolean; readonly outcomeUncertain?: boolean } = {},
): LoopXResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `safe ${operation} failure`,
      operation,
      retryable: options.retryable ?? false,
      outcomeUncertain: options.outcomeUncertain ?? false,
    },
  }
}

function row(
  sessionId: string,
  overrides: Partial<LoopXBindingRow> = {},
): LoopXBindingRow {
  return Object.freeze({
    schemaVersion: 'loopx_dsh_binding_row_v0',
    session: Object.freeze({ createdAt: 42, cwd: '/workspace' }),
    hostSurface: 'deepseek-harness-native',
    goalId: `goal-${sessionId}`,
    agentId: `agent-${sessionId}`,
    projectLocator: '/workspace',
    phase: 'active_armed' as const,
    generation: 1,
    unchangedPollCount: 0,
    bindingCreatedAt: 40,
    updatedAt: 42,
    ...overrides,
  })
}

function fence(sessionId: string, binding: LoopXBindingRow): LoopXBindingFence {
  return Object.freeze({
    sessionId,
    session: Object.freeze({ ...binding.session }),
    goalId: binding.goalId,
    agentId: binding.agentId,
    generation: binding.generation,
  })
}

function fenceMatches(binding: LoopXBindingRow | undefined, expected: LoopXBindingFence): boolean {
  return binding !== undefined
    && binding.session.createdAt === expected.session.createdAt
    && binding.session.cwd === expected.session.cwd
    && binding.goalId === expected.goalId
    && binding.agentId === expected.agentId
    && binding.generation === expected.generation
}

const waitHint: LoopXSchedulerHint = Object.freeze({
  action: 'wait',
  cadenceClass: 'backoff',
  resetToken: 'reset-a',
  recommendedIntervalMinutes: 3,
  unchangedPollLimit: 2,
  afterLimit: 'quiet_until_material_transition',
})

function decision(
  binding: LoopXBindingRow,
  turnInstanceId: string,
  overrides: Partial<LoopXQuotaDecision> = {},
): LoopXQuotaDecision {
  return Object.freeze({
    goalId: binding.goalId,
    agentId: binding.agentId,
    turnInstanceId,
    shouldRun: true,
    effectiveAction: 'run_now',
    schedulerHint: Object.freeze({
      action: 'run_now',
      cadenceClass: 'immediate',
      resetToken: 'run-a',
      recommendedIntervalMinutes: 3,
      unchangedPollLimit: 2,
      afterLimit: 'quiet_until_material_transition',
    }),
    terminalNoFollowup: false,
    payload: Object.freeze({ schema_version: 'loopx_quota_should_run_v0', ok: true }),
    ...overrides,
  })
}

interface SchedulerUpdate {
  readonly sessionId: string
  readonly hint: LoopXSchedulerHint
  readonly unchangedPollCount: number
  readonly nextCheckAt?: number
}

interface TransitionAttempt {
  readonly sessionId: string
  readonly reason: LoopXBindingReason
  readonly expectedFence?: LoopXBindingFence
}

class FakeService implements LoopXServiceApi {
  readonly rows = new Map<string, LoopXBindingRow>()
  readonly bodies = new Map<string, string>()
  readonly quotaCalls: { readonly sessionId: string; readonly turnInstanceId: string; readonly signal?: AbortSignal }[] = []
  readonly taskBodyCalls: { readonly sessionId: string; readonly generation: number; readonly refresh: boolean }[] = []
  readonly schedulerUpdates: SchedulerUpdate[] = []
  readonly pauses: { readonly sessionId: string; readonly reason: LoopXBindingReason }[] = []
  readonly pauseAttempts: TransitionAttempt[] = []
  readonly uncertain: string[] = []
  readonly uncertainAttempts: TransitionAttempt[] = []
  readonly disposedSessions: string[] = []
  private readonly queues = new Map<string, Promise<void>>()
  quotaHandler: (
    session: LoopXSessionRef,
    turnInstanceId: string,
    signal?: AbortSignal,
  ) => Promise<LoopXResult<LoopXQuotaDecision>>
  disposeHandler: (session: LoopXSessionRef) => Promise<void> = () => Promise.resolve()

  constructor(...sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      this.rows.set(sessionId, row(sessionId))
      this.bodies.set(sessionId, `task body for ${sessionId}`)
    }
    this.quotaHandler = (session, turnInstanceId) => {
      const binding = this.rows.get(session.id)
      return Promise.resolve(binding === undefined
        ? failure('LOOPX_SESSION_NOT_BOUND', 'quota')
        : success(decision(binding, turnInstanceId)))
    }
  }

  arm(sessionId: string, overrides: Partial<LoopXBindingRow> = {}): LoopXBindingRow {
    const previous = this.rows.get(sessionId) ?? row(sessionId)
    const armed = row(sessionId, {
      ...previous,
      phase: 'active_armed',
      generation: previous.generation + 1,
      reason: undefined,
      ...overrides,
    })
    this.rows.set(sessionId, armed)
    return armed
  }

  queueRebind(
    sessionId: string,
    waitFor: Promise<void>,
    overrides: Partial<LoopXBindingRow> = {},
  ): Promise<LoopXBindingRow> {
    return this.enqueue(sessionId, async () => {
      await waitFor
      return this.arm(sessionId, overrides)
    })
  }

  getBinding(session: LoopXSessionRef): LoopXResult<LoopXBindingRow | undefined> {
    const binding = this.rows.get(session.id)
    if (binding !== undefined && (binding.session.createdAt !== session.identity.createdAt
      || binding.session.cwd !== session.identity.cwd)) {
      return failure('LOOPX_SESSION_LIFECYCLE_MISMATCH', 'get-binding')
    }
    return success(binding)
  }

  start(
    _session: LoopXSessionRef,
    _goalText: string,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStartValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'start'))
  }

  attach(
    _session: LoopXSessionRef,
    _request: LoopXAttachRequest,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXAttachValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'attach'))
  }

  activate(
    _session: LoopXSessionRef,
    _goalId: string,
    _agentId?: string,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'activate'))
  }

  status(
    _session: LoopXSessionRef,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXStatusValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'status'))
  }

  pause(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'user_pause',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    this.pauseAttempts.push({
      sessionId: session.id,
      reason,
      ...(expectedFence === undefined ? {} : { expectedFence }),
    })
    return this.enqueue(session.id, () => {
      const binding = this.rows.get(session.id)
      if (binding === undefined) return failure('LOOPX_SESSION_NOT_BOUND', 'pause')
      if (expectedFence !== undefined
        && (expectedFence.sessionId !== session.id || !fenceMatches(binding, expectedFence))) {
        return failure('LOOPX_DRIVER_NOT_ARMED', 'pause')
      }
      this.pauses.push({ sessionId: session.id, reason })
      const paused = row(session.id, {
        ...binding,
        phase: binding.phase === 'planning' ? 'planning' : 'active_paused',
        generation: binding.generation + 1,
        reason,
        schedulerResetToken: undefined,
        unchangedPollCount: 0,
        nextCheckAt: undefined,
      })
      this.rows.set(session.id, paused)
      return success(paused)
    })
  }

  resume(session: LoopXSessionRef): Promise<LoopXResult<LoopXBindingRow>> {
    return Promise.resolve(success(this.arm(session.id)))
  }

  detach(
    session: LoopXSessionRef,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<{ readonly detached: true }>> {
    this.rows.delete(session.id)
    return Promise.resolve(success({ detached: true }))
  }

  todoClaim(
    _session: LoopXSessionRef,
    _request: LoopXTodoClaimRequest,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'todo-claim'))
  }

  todoUpdate(
    _session: LoopXSessionRef,
    _request: LoopXTodoUpdateRequest,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'todo-update'))
  }

  todoComplete(
    _session: LoopXSessionRef,
    _request: LoopXTodoCompleteRequest,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTodoMutationValue>> {
    return Promise.resolve(failure('LOOPX_INVALID_REQUEST', 'todo-complete'))
  }

  quotaShouldRun(
    session: LoopXSessionRef,
    turnInstanceId: string,
    signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXQuotaDecision>> {
    this.quotaCalls.push({ sessionId: session.id, turnInstanceId, ...(signal === undefined ? {} : { signal }) })
    return this.quotaHandler(session, turnInstanceId, signal)
  }

  taskBody(
    session: LoopXSessionRef,
    generation: number,
    refresh = false,
    _signal?: AbortSignal,
  ): Promise<LoopXResult<LoopXTaskBody>> {
    this.taskBodyCalls.push({ sessionId: session.id, generation, refresh })
    const binding = this.rows.get(session.id)
    const body = this.bodies.get(session.id)
    if (binding === undefined || binding.phase !== 'active_armed'
      || binding.generation !== generation || body === undefined) {
      return Promise.resolve(failure('LOOPX_DRIVER_NOT_ARMED', 'task-body'))
    }
    return Promise.resolve(success({ fence: fence(session.id, binding), body }))
  }

  updateScheduler(
    session: LoopXSessionRef,
    expected: LoopXBindingFence,
    hint: LoopXSchedulerHint,
    unchangedPollCount: number,
    nextCheckAt?: number,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    const binding = this.rows.get(session.id)
    if (!fenceMatches(binding, expected)) {
      return Promise.resolve(failure('LOOPX_DRIVER_NOT_ARMED', 'scheduler'))
    }
    this.schedulerUpdates.push({
      sessionId: session.id,
      hint,
      unchangedPollCount,
      ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
    })
    const updated = row(session.id, {
      ...binding,
      schedulerResetToken: hint.resetToken,
      unchangedPollCount,
      nextCheckAt,
    })
    this.rows.set(session.id, updated)
    return Promise.resolve(success(updated))
  }

  fence(session: LoopXSessionRef): LoopXResult<LoopXBindingFence> {
    const binding = this.rows.get(session.id)
    return binding === undefined
      ? failure('LOOPX_SESSION_NOT_BOUND', 'fence')
      : success(fence(session.id, binding))
  }

  fenceIsCurrent(expected: LoopXBindingFence): boolean {
    return fenceMatches(this.rows.get(expected.sessionId), expected)
  }

  markUncertain(
    session: LoopXSessionRef,
    reason: LoopXBindingReason = 'uncertain_write',
    expectedFence?: LoopXBindingFence,
  ): Promise<LoopXResult<LoopXBindingRow>> {
    this.uncertainAttempts.push({
      sessionId: session.id,
      reason,
      ...(expectedFence === undefined ? {} : { expectedFence }),
    })
    return this.enqueue(session.id, () => {
      const binding = this.rows.get(session.id)
      if (binding === undefined) return failure('LOOPX_SESSION_NOT_BOUND', 'uncertain')
      if (expectedFence !== undefined
        && (expectedFence.sessionId !== session.id || !fenceMatches(binding, expectedFence))) {
        return failure('LOOPX_DRIVER_NOT_ARMED', 'uncertain')
      }
      this.uncertain.push(session.id)
      const uncertain = row(session.id, {
        ...binding,
        phase: 'uncertain',
        generation: binding.generation + 1,
        reason,
      })
      this.rows.set(session.id, uncertain)
      return success(uncertain)
    })
  }

  async disposeSession(session: LoopXSessionRef): Promise<void> {
    this.disposedSessions.push(session.id)
    await this.disposeHandler(session)
    const binding = this.rows.get(session.id)
    if (binding !== undefined) {
      this.rows.set(session.id, row(session.id, {
        ...binding,
        phase: binding.phase === 'planning' ? 'planning' : 'active_paused',
        generation: binding.generation + 1,
        reason: 'session_disposed',
      }))
    }
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(sessionId, tail)
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    })
    return result
  }
}

interface FakeAgentHarness {
  readonly agent: Agent
  readonly followups: UserMessage[]
  readonly cancels: unknown[]
  readonly removed: UserMessage['id'][]
  setStatus(status: 'idle' | 'running'): void
  connect(driver: LoopXContinuationDriver): void
}

function fakeAgent(sessionId: string): FakeAgentHarness {
  let status: 'idle' | 'running' = 'idle'
  let driver: LoopXContinuationDriver | undefined
  const followups: UserMessage[] = []
  const cancels: unknown[] = []
  const removed: UserMessage['id'][] = []
  const nextTurn: UserMessage[] = []
  const nextStep: UserMessage[] = []
  let agent: Agent
  agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: { version: 0, id: sessionId, createdAt: 42, cwd: '/workspace' },
    },
    get status() { return status },
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      remove(messageId: UserMessage['id']) {
        const index = nextTurn.findIndex(message => message.id === messageId)
        if (index < 0) return false
        nextTurn.splice(index, 1)
        removed.push(messageId)
        return true
      },
    },
    followup(message: UserMessage) {
      followups.push(message)
      nextTurn.push(message)
      driver?.onInboxInserted(agent, message)
      status = 'running'
      driver?.onAgentStatus(agent, 'running')
    },
    cancel(cause: unknown) { cancels.push(cause) },
    whenIdle() { return Promise.resolve() },
  } as unknown as Agent
  return {
    agent,
    followups,
    cancels,
    removed,
    setStatus(value) { status = value },
    connect(value) { driver = value },
  }
}

interface FakeTimer {
  readonly id: number
  readonly at: number
  readonly callback: () => void
}

class FakeClock implements LoopXDriverClock {
  nowMs = 1_000
  private nextId = 1
  private readonly timers = new Map<number, FakeTimer>()

  now(): number {
    return this.nowMs
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { id, at: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get size(): number {
    return this.timers.size
  }

  takeNext(): FakeTimer {
    const timer = [...this.timers.values()].sort((left, right) => left.at - right.at)[0]
    if (timer === undefined) throw new Error('no fake timer is scheduled')
    this.timers.delete(timer.id)
    return timer
  }

  fire(timer: FakeTimer): void {
    this.nowMs = Math.max(this.nowMs, timer.at)
    timer.callback()
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  const pending = Promise.withResolvers<T>()
  return { promise: pending.promise, resolve: pending.resolve }
}

function userMessage(id: string): UserMessage {
  return {
    id: id as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text: 'human input' }],
    source: { kind: 'user' },
  }
}

function commandDoneEvent(): SessionEvent {
  return {
    type: 'command/done',
    seq: 0,
    time: 1,
    data: { commandId: 'cmd-test', kind: 'success' },
  } as SessionEvent
}

function admittedMessageEvent(message: UserMessage): SessionEvent {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: message,
  } as SessionEvent
}

function harness(...sessionIds: string[]): {
  readonly service: FakeService
  readonly clock: FakeClock
  readonly driver: LoopXContinuationDriver
  readonly agents: Map<string, FakeAgentHarness>
} {
  const service = new FakeService(...sessionIds)
  const clock = new FakeClock()
  const agents = new Map<string, FakeAgentHarness>()
  const live = new Set<Agent>()
  let turn = 0
  const driver = new LoopXContinuationDriver({
    service,
    clock,
    isLiveAgent: agent => live.has(agent),
    makeTurnInstanceId: () => {
      turn += 1
      return `turn-${turn}`
    },
  })
  for (const sessionId of sessionIds) {
    const current = fakeAgent(sessionId)
    current.connect(driver)
    live.add(current.agent)
    agents.set(sessionId, current)
    driver.observeAgent(current.agent)
  }
  return { service, clock, driver, agents }
}

function requiredAgent(
  agents: ReadonlyMap<string, FakeAgentHarness>,
  sessionId: string,
): FakeAgentHarness {
  const agent = agents.get(sessionId)
  if (agent === undefined) throw new Error(`missing fake agent ${sessionId}`)
  return agent
}

describe('LoopX same-session continuation driver', () => {
  it('probes only at idle, uses a unique turn identity, and follows up on the same Agent', async () => {
    const test = harness('session-a')
    const current = requiredAgent(test.agents, 'session-a')

    test.driver.onAgentStatus(current.agent, 'idle')
    await test.driver.whenSettled()

    expect(test.service.quotaCalls.map(call => call.turnInstanceId)).toEqual(['turn-1'])
    expect(test.service.taskBodyCalls).toEqual([
      { sessionId: 'session-a', generation: 1, refresh: false },
    ])
    expect(current.followups).toHaveLength(1)
    expect(current.followups[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'task body for session-a' }],
      source: { kind: 'plugin', plugin: 'dsh-loopx-plugin' },
    })

    current.setStatus('idle')
    test.driver.onAgentStatus(current.agent, 'idle')
    await test.driver.whenSettled()
    expect(test.service.quotaCalls.map(call => call.turnInstanceId)).toEqual(['turn-1', 'turn-2'])
    await test.driver.dispose()
  })

  it('persists scheduler reset/count state, then becomes quiet without inventing terminal state', async () => {
    const test = harness('session-a')
    const current = requiredAgent(test.agents, 'session-a')
    test.service.quotaHandler = (session, turnInstanceId) => {
      const binding = test.service.rows.get(session.id)
      if (binding === undefined) return Promise.resolve(failure('LOOPX_SESSION_NOT_BOUND', 'quota'))
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'wait',
        schedulerHint: waitHint,
      })))
    }

    test.driver.onAgentStatus(current.agent, 'idle')
    await test.driver.whenSettled()
    expect(test.service.schedulerUpdates[0]).toMatchObject({
      unchangedPollCount: 1,
      nextCheckAt: 181_000,
      hint: { resetToken: 'reset-a' },
    })
    expect(test.clock.size).toBe(1)

    test.clock.fire(test.clock.takeNext())
    await test.driver.whenSettled()
    expect(test.service.schedulerUpdates[1]).toMatchObject({
      unchangedPollCount: 2,
      nextCheckAt: 361_000,
    })
    expect(test.clock.size).toBe(1)

    test.clock.fire(test.clock.takeNext())
    await test.driver.whenSettled()
    expect(test.service.schedulerUpdates[2]).toMatchObject({ unchangedPollCount: 2 })
    expect(test.service.schedulerUpdates[2]).not.toHaveProperty('nextCheckAt')
    expect(test.clock.size).toBe(0)
    expect(test.service.pauses).toEqual([])
    expect(test.service.rows.get('session-a')?.phase).toBe('active_armed')
    await test.driver.dispose()
  })

  it('stops only on the service-validated terminal closure', async () => {
    const incomplete = harness('session-a')
    const incompleteAgent = requiredAgent(incomplete.agents, 'session-a')
    incomplete.service.quotaHandler = (session, turnInstanceId) => {
      const binding = incomplete.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'terminal_no_followup',
        schedulerHint: waitHint,
        terminalNoFollowup: false,
      })))
    }
    incomplete.driver.onAgentStatus(incompleteAgent.agent, 'idle')
    await incomplete.driver.whenSettled()
    expect(incomplete.service.pauses).toEqual([])
    expect(incomplete.clock.size).toBe(1)
    await incomplete.driver.dispose()

    const terminal = harness('session-b')
    const terminalAgent = requiredAgent(terminal.agents, 'session-b')
    const terminalBinding = terminal.service.rows.get('session-b') as LoopXBindingRow
    terminal.service.quotaHandler = (session, turnInstanceId) => {
      const binding = terminal.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'terminal_no_followup',
        schedulerHint: waitHint,
        terminalNoFollowup: true,
      })))
    }
    terminal.driver.onAgentStatus(terminalAgent.agent, 'idle')
    await terminal.driver.whenSettled()
    expect(terminal.service.pauses).toEqual([
      { sessionId: 'session-b', reason: 'loopx_terminal_observed' },
    ])
    expect(terminal.service.pauseAttempts).toEqual([{
      sessionId: 'session-b',
      reason: 'loopx_terminal_observed',
      expectedFence: fence('session-b', terminalBinding),
    }])
    expect(terminalAgent.followups).toEqual([])
    expect(terminal.service.rows.get('session-b')?.phase).toBe('active_paused')
    await terminal.driver.dispose()
  })

  it('fences a dequeued stale timer and a quota result that resolves after rebind', async () => {
    const stale = harness('session-a')
    const staleAgent = requiredAgent(stale.agents, 'session-a')
    stale.service.quotaHandler = (session, turnInstanceId) => {
      const binding = stale.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'wait',
        schedulerHint: waitHint,
      })))
    }
    stale.driver.onAgentStatus(staleAgent.agent, 'idle')
    await stale.driver.whenSettled()
    const callback = stale.clock.takeNext()
    stale.service.arm('session-a', { goalId: 'goal-rebound' })
    stale.clock.fire(callback)
    await stale.driver.whenSettled()
    expect(stale.service.quotaCalls).toHaveLength(1)
    await stale.driver.dispose()

    const midAwait = harness('session-b')
    const midAgent = requiredAgent(midAwait.agents, 'session-b')
    const pending = deferred<LoopXResult<LoopXQuotaDecision>>()
    let capturedTurn = ''
    let capturedBinding: LoopXBindingRow | undefined
    midAwait.service.quotaHandler = (session, turnInstanceId) => {
      capturedTurn = turnInstanceId
      capturedBinding = midAwait.service.rows.get(session.id)
      return pending.promise
    }
    midAwait.driver.onAgentStatus(midAgent.agent, 'idle')
    await Promise.resolve()
    midAwait.service.arm('session-b', { goalId: 'goal-new' })
    pending.resolve(success(decision(capturedBinding as LoopXBindingRow, capturedTurn)))
    await midAwait.driver.whenSettled()
    expect(midAwait.service.taskBodyCalls).toEqual([])
    expect(midAgent.followups).toEqual([])
    await midAwait.driver.dispose()
  })

  it('coalesces double-idle and retries only one valid fence with the same turn identity', async () => {
    const test = harness('session-a')
    const current = requiredAgent(test.agents, 'session-a')
    const first = deferred<LoopXResult<LoopXQuotaDecision>>()
    let attempts = 0
    test.service.quotaHandler = (session, turnInstanceId) => {
      attempts += 1
      if (attempts === 1) return first.promise
      const binding = test.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId)))
    }

    test.driver.onAgentStatus(current.agent, 'idle')
    test.driver.onAgentStatus(current.agent, 'idle')
    await Promise.resolve()
    expect(test.service.quotaCalls).toHaveLength(1)
    first.resolve(failure('LOOPX_CLI_TIMEOUT', 'quota', { retryable: true }))
    await test.driver.whenSettled()

    expect(test.service.quotaCalls).toHaveLength(2)
    expect(new Set(test.service.quotaCalls.map(call => call.turnInstanceId))).toEqual(new Set(['turn-1']))
    expect(current.followups).toHaveLength(1)
    await test.driver.dispose()

    const disarmed = harness('session-b')
    const disarmedAgent = requiredAgent(disarmed.agents, 'session-b')
    disarmed.service.quotaHandler = (session) => {
      const binding = disarmed.service.rows.get(session.id) as LoopXBindingRow
      disarmed.service.rows.set(session.id, row(session.id, {
        ...binding,
        phase: 'active_paused',
        generation: binding.generation + 1,
        reason: 'readback_failed',
      }))
      return Promise.resolve(failure('LOOPX_CLI_TIMEOUT', 'quota', { retryable: true }))
    }
    disarmed.driver.onAgentStatus(disarmedAgent.agent, 'idle')
    await disarmed.driver.whenSettled()
    expect(disarmed.service.quotaCalls).toHaveLength(1)
    expect(disarmedAgent.followups).toEqual([])
    await disarmed.driver.dispose()
  })

  it('fences fail-closed writes and cannot pause a newer binding queued first', async () => {
    const failed = harness('session-a')
    const failedAgent = requiredAgent(failed.agents, 'session-a')
    const failedBinding = failed.service.rows.get('session-a') as LoopXBindingRow
    failed.service.quotaHandler = () => Promise.resolve(failure(
      'LOOPX_CLI_FAILED',
      'quota',
    ))
    failed.driver.onAgentStatus(failedAgent.agent, 'idle')
    await failed.driver.whenSettled()
    expect(failed.service.pauseAttempts).toEqual([{
      sessionId: 'session-a',
      reason: 'readback_failed',
      expectedFence: fence('session-a', failedBinding),
    }])
    expect(failed.service.pauses).toEqual([
      { sessionId: 'session-a', reason: 'readback_failed' },
    ])
    await failed.driver.dispose()

    const raced = harness('session-b')
    const racedAgent = requiredAgent(raced.agents, 'session-b')
    const oldBinding = raced.service.rows.get('session-b') as LoopXBindingRow
    const rebindGate = deferred<void>()
    const rebinding = raced.service.queueRebind('session-b', rebindGate.promise, {
      goalId: 'goal-new',
      agentId: 'agent-new',
    })

    // The rebind owns the queue but has not committed, so foreign input still
    // observes the old row and queues its fenced pause behind that mutation.
    raced.driver.onInboxInserted(racedAgent.agent, userMessage('human-race'))
    expect(raced.service.pauseAttempts).toEqual([{
      sessionId: 'session-b',
      reason: 'foreign_input',
      expectedFence: fence('session-b', oldBinding),
    }])
    rebindGate.resolve(undefined)
    const rebound = await rebinding
    await raced.driver.whenSettled()

    expect(rebound).toMatchObject({
      phase: 'active_armed',
      generation: oldBinding.generation + 1,
      goalId: 'goal-new',
      agentId: 'agent-new',
    })
    expect(raced.service.rows.get('session-b')).toEqual(rebound)
    expect(raced.service.pauses).toEqual([])
    await raced.driver.dispose()
  })

  it('uses the three-minute fail-closed timer for an incomplete hint and disarms uncertainty', async () => {
    const fallback = harness('session-a')
    const fallbackAgent = requiredAgent(fallback.agents, 'session-a')
    fallback.service.quotaHandler = (session, turnInstanceId) => {
      const binding = fallback.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'wait',
        schedulerHint: {
          action: 'wait',
          cadenceClass: 'unknown_detail',
          recommendedIntervalMinutes: 9,
          afterLimit: 'retry',
        },
      })))
    }
    fallback.driver.onAgentStatus(fallbackAgent.agent, 'idle')
    await fallback.driver.whenSettled()
    expect(fallback.service.schedulerUpdates[0]).toMatchObject({
      unchangedPollCount: 1,
      nextCheckAt: 181_000,
    })
    expect(fallback.clock.size).toBe(1)
    await fallback.driver.dispose()

    const uncertain = harness('session-b')
    const uncertainAgent = requiredAgent(uncertain.agents, 'session-b')
    uncertain.service.quotaHandler = () => Promise.resolve(failure(
      'LOOPX_WRITE_UNCERTAIN',
      'quota',
      { retryable: true, outcomeUncertain: true },
    ))
    uncertain.driver.onAgentStatus(uncertainAgent.agent, 'idle')
    await uncertain.driver.whenSettled()
    expect(uncertain.service.quotaCalls).toHaveLength(1)
    expect(uncertain.service.uncertain).toEqual(['session-b'])
    expect(uncertain.service.uncertainAttempts).toEqual([{
      sessionId: 'session-b',
      reason: 'uncertain_write',
      expectedFence: fence(
        'session-b',
        row('session-b'),
      ),
    }])
    expect(uncertain.service.rows.get('session-b')?.phase).toBe('uncertain')
    expect(uncertainAgent.followups).toEqual([])
    await uncertain.driver.dispose()
  })

  it('lets foreign user input preempt the timer and pauses only this binding', async () => {
    const test = harness('session-a')
    const current = requiredAgent(test.agents, 'session-a')
    const initialBinding = test.service.rows.get('session-a') as LoopXBindingRow
    test.service.quotaHandler = (session, turnInstanceId) => {
      const binding = test.service.rows.get(session.id) as LoopXBindingRow
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'wait',
        schedulerHint: waitHint,
      })))
    }
    test.driver.onAgentStatus(current.agent, 'idle')
    await test.driver.whenSettled()
    const staleCallback = test.clock.takeNext()

    test.driver.onInboxInserted(current.agent, userMessage('human-1'))
    await test.driver.whenSettled()
    test.clock.fire(staleCallback)
    await test.driver.whenSettled()

    expect(test.service.pauses).toEqual([
      { sessionId: 'session-a', reason: 'foreign_input' },
    ])
    expect(test.service.pauseAttempts).toEqual([{
      sessionId: 'session-a',
      reason: 'foreign_input',
      expectedFence: fence('session-a', initialBinding),
    }])
    expect(test.service.rows.get('session-a')?.phase).toBe('active_paused')
    expect(test.service.quotaCalls).toHaveLength(1)
    expect(current.followups).toEqual([])
    await test.driver.dispose()

    const active = harness('session-b')
    const activeAgent = requiredAgent(active.agents, 'session-b')
    active.driver.onAgentStatus(activeAgent.agent, 'idle')
    await active.driver.whenSettled()
    const automatic = activeAgent.followups[0] as UserMessage
    active.driver.onInboxClaimed(activeAgent.agent, automatic)
    active.driver.onSessionEvent(activeAgent.agent, admittedMessageEvent(automatic))
    active.driver.onInboxInserted(activeAgent.agent, userMessage('human-2'))
    await active.driver.whenSettled()
    expect(activeAgent.cancels).toEqual([
      { kind: 'hook', reason: 'dsh-loopx-plugin foreign input' },
    ])
    expect(active.service.pauses).toContainEqual({
      sessionId: 'session-b',
      reason: 'foreign_input',
    })
    await active.driver.dispose()
  })

  it('scopes Session disposal to one lane while another timer keeps running', async () => {
    const test = harness('session-a', 'session-b')
    const firstAgent = requiredAgent(test.agents, 'session-a')
    const secondAgent = requiredAgent(test.agents, 'session-b')
    const pending = deferred<LoopXResult<LoopXQuotaDecision>>()
    test.service.quotaHandler = (session, turnInstanceId) => {
      const binding = test.service.rows.get(session.id) as LoopXBindingRow
      if (session.id === 'session-a') return pending.promise
      return Promise.resolve(success(decision(binding, turnInstanceId, {
        shouldRun: false,
        effectiveAction: 'wait',
        schedulerHint: waitHint,
      })))
    }
    test.driver.onAgentStatus(firstAgent.agent, 'idle')
    test.driver.onAgentStatus(secondAgent.agent, 'idle')
    await Promise.resolve()
    await Promise.resolve()
    test.driver.onAgentDisposed(firstAgent.agent)
    expect(test.service.quotaCalls.find(call => call.sessionId === 'session-a')?.signal?.aborted).toBe(true)
    pending.resolve(failure('LOOPX_CLI_ABORTED', 'quota'))
    await test.driver.whenSettled()

    expect(test.service.disposedSessions).toEqual(['session-a'])
    expect(test.clock.size).toBe(1)
    test.clock.fire(test.clock.takeNext())
    await test.driver.whenSettled()
    expect(test.service.quotaCalls.filter(call => call.sessionId === 'session-b')).toHaveLength(2)
    await test.driver.dispose()
  })

  it('disarms inherited authority on reload, refetches task body after re-arm, and drains shutdown', async () => {
    const reload = harness('session-a')
    const current = requiredAgent(reload.agents, 'session-a')
    const inheritedBinding = reload.service.rows.get('session-a') as LoopXBindingRow
    reload.driver.observeAgent(current.agent, true)
    await reload.driver.whenSettled()
    expect(reload.service.pauses).toEqual([
      { sessionId: 'session-a', reason: 'manual_resume_required' },
    ])
    expect(reload.service.pauseAttempts).toEqual([{
      sessionId: 'session-a',
      reason: 'manual_resume_required',
      expectedFence: fence('session-a', inheritedBinding),
    }])
    expect(reload.service.quotaCalls).toEqual([])

    const restartedBinding = reload.service.arm('session-a')
    reload.driver.onSessionStart(current.agent)
    await reload.driver.whenSettled()
    expect(reload.service.pauseAttempts[1]).toEqual({
      sessionId: 'session-a',
      reason: 'manual_resume_required',
      expectedFence: fence('session-a', restartedBinding),
    })

    reload.service.bodies.set('session-a', 'refetched task body')
    reload.service.arm('session-a')
    reload.driver.onSessionEvent(current.agent, commandDoneEvent())
    reload.driver.onAgentStatus(current.agent, 'idle')
    await reload.driver.whenSettled()
    expect(reload.service.taskBodyCalls).toHaveLength(1)
    expect(current.followups[0]?.content).toEqual([{ type: 'text', text: 'refetched task body' }])
    await reload.driver.dispose()

    const shutdown = harness('session-b')
    const shutdownAgent = requiredAgent(shutdown.agents, 'session-b')
    const pending = deferred<LoopXResult<LoopXQuotaDecision>>()
    let capturedTurn = ''
    shutdown.service.quotaHandler = (_session, turnInstanceId) => {
      capturedTurn = turnInstanceId
      return pending.promise
    }
    shutdown.driver.onAgentStatus(shutdownAgent.agent, 'idle')
    await Promise.resolve()
    const shutdownBinding = shutdown.service.rows.get('session-b') as LoopXBindingRow
    let disposed = false
    const disposing = shutdown.driver.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const binding = shutdown.service.rows.get('session-b') as LoopXBindingRow
    pending.resolve(success(decision(binding, capturedTurn)))
    await disposing
    expect(disposed).toBe(true)
    expect(shutdownAgent.followups).toEqual([])
    expect(shutdown.service.pauses).toContainEqual({
      sessionId: 'session-b',
      reason: 'manual_resume_required',
    })
    expect(shutdown.service.pauseAttempts).toContainEqual({
      sessionId: 'session-b',
      reason: 'manual_resume_required',
      expectedFence: fence('session-b', shutdownBinding),
    })
  })
})
