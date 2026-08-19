import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import LoopXService from '../src/service.ts'
import type { LoopXServiceApi, LoopXSessionRef } from '../src/types.ts'

interface FakeLoopXState {
  readonly goalId: string
  readonly agents: string[]
  readonly bindingAgent: string | null
  readonly taskBody: string
  readonly delayCommand?: string | undefined
  readonly delayMs?: number | undefined
  readonly invalidJsonFor?: string | undefined
}

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly project: string
  readonly statePath: string
  readonly callsPath: string
  service: LoopXServiceApi
  disposeService(): Promise<void>
  reloadService(): Promise<void>
  readState(): Promise<FakeLoopXState>
  writeState(update: Partial<FakeLoopXState>): Promise<void>
  storageText(): Promise<string>
  dispose(): Promise<void>
}

const fakeLoopXSource = String.raw`#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const statePath = process.env.LOOPX_FAKE_STATE
if (!statePath) throw new Error('LOOPX_FAKE_STATE is required')
const args = process.argv.slice(2)
const value = flag => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
let index = 0
while (index < args.length) {
  if (['--format', '--registry', '--runtime-root'].includes(args[index])) index += 2
  else break
}
const command = args[index]
const subcommand = command === 'todo' || command === 'quota' ? args[index + 1] : undefined
const key = subcommand ? command + '-' + subcommand : command
let state = JSON.parse(await readFile(statePath, 'utf8'))
await appendFile(statePath + '.calls', 'start:' + key + '\n')
if (state.delayCommand === key) {
  await new Promise(resolve => setTimeout(resolve, state.delayMs ?? 25))
}

const goalId = value('--goal-id') ?? state.goalId
const threadId = value('--thread-id')
const project = value('--project') ?? process.cwd()
const requestedAgent = value('--agent-id')
const binding = state.bindingAgent === null
  ? { status: 'missing' }
  : { status: 'bound', agent_id: state.bindingAgent }
const selectionGate = defaultAction => ({
  schema_version: 'loopx_host_loop_identity_selection_v0',
  default_action: defaultAction,
  reason: 'Select an exact LoopX agent lane.',
  choices: state.agents.map(agent_id => ({ agent_id })),
  ...(defaultAction === 'register_fresh_agent'
    ? { fresh_agent_registration: { agent_id: '<new-public-safe-agent-id>' } }
    : {}),
})

let output
if (command === 'start-goal') {
  const selected = requestedAgent ?? state.bindingAgent
  const exact = selected !== null && selected !== undefined
    && state.agents.includes(selected)
    && state.bindingAgent === selected
  const gate = exact
    ? undefined
    : selectionGate(state.agents.length === 0 ? 'register_fresh_agent' : 'select_agent_identity')
  output = {
    schema_version: 'loopx_start_goal_guided_v0',
    ok: true,
    read_only: true,
    guided: true,
    project,
    goal_id: goalId,
    agent_id: exact ? selected : null,
    host_surface: 'deepseek-harness-native',
    thread_id: threadId,
    thread_agent_binding: binding,
    project_connection: { registry: project + '/.loopx/registry.json' },
    guided_transaction: {
      schema_version: 'loopx_start_goal_guided_v0',
      ...(gate ? { blocked_by: 'agent_identity_selection', identity_selection_gate: gate } : {}),
      ordered_steps: [
        { id: 'inspect', kind: 'read_only' },
        { id: 'plan', kind: 'model_checkpoint', prompt: 'Plan and write the bounded LoopX Todos.' },
      ],
    },
  }
} else if (command === 'bootstrap-command-pack') {
  const selected = requestedAgent
    ?? state.bindingAgent
    ?? (state.agents.length === 1 ? state.agents[0] : null)
  const allowed = selected !== null && state.agents.includes(selected)
  const activationArguments = { goalId, ...(selected ? { agentId: selected } : {}) }
  output = {
    schema_version: 'loopx_bootstrap_command_pack_v0',
    ok: true,
    read_only: true,
    project,
    goal_id: goalId,
    agent_id: selected,
    agent_type: 'deepseek-harness-native',
    host_surface: 'deepseek-harness-native',
    thread_id: threadId,
    thread_agent_binding: binding,
    project_connection: { registry: project + '/.loopx/registry.json' },
    host_loop_activation: {
      schema_version: 'loopx_host_loop_activation_v1',
      agent_type: 'deepseek-harness-native',
      goal_id: goalId,
      agent_id: selected,
      activation_allowed: allowed,
      identity_contract: {
        schema_version: 'loopx_host_loop_identity_selection_v0',
        registered_agents: state.agents,
      },
      identity_selection_gate: allowed ? null : selectionGate('select_agent_identity'),
      host_surface: 'deepseek_harness_native_session',
      activation_method: 'current_session_host_tool',
      activation_input: {
        schema_version: 'loopx_deepseek_harness_native_activation_input_v0',
        tool: 'loopx_goal_activate',
        arguments: activationArguments,
      },
      host_mutation: {
        owner: 'DSH LoopX plugin',
        host_tool: 'loopx_goal_activate',
        current_session_only: true,
        cli_can_mutate_directly: false,
        forbidden_tool_arguments: ['sessionId', 'registryPath', 'taskBody', 'argv'],
      },
    },
  }
} else if (command === 'register-agent') {
  const agent = requestedAgent
  const changed = !state.agents.includes(agent)
  if (changed) state.agents.push(agent)
  output = {
    schema_version: 'loopx_register_agent_v0',
    ok: changed,
    goal_id: goalId,
    changed,
    written: changed,
    global_sync: { ok: changed },
    registration_readback: { verified: changed },
  }
} else if (command === 'bind-agent-thread') {
  const agent = requestedAgent
  const conflict = state.bindingAgent !== null && state.bindingAgent !== agent
  if (!conflict) state.bindingAgent = agent
  output = {
    schema_version: 'loopx_thread_agent_binding_command_v0',
    ok: !conflict,
    goal_id: goalId,
    thread_id: threadId,
    host_surface: 'deepseek-harness-native',
    agent_id: agent,
    changed: !conflict,
    written: !conflict,
    binding: conflict
      ? { schema_version: 'loopx_thread_agent_binding_v0', status: 'conflict', thread_id: threadId, host_surface: 'deepseek-harness-native' }
      : { schema_version: 'loopx_thread_agent_binding_v0', status: 'bound', thread_id: threadId, host_surface: 'deepseek-harness-native', agent_id: agent },
    global_sync: { ok: !conflict },
    registration_readback: { verified: !conflict },
  }
} else if (command === 'unbind-agent-thread') {
  const agent = requestedAgent
  const matches = state.bindingAgent === null || state.bindingAgent === agent
  if (matches) state.bindingAgent = null
  output = {
    schema_version: 'loopx_thread_agent_binding_command_v0',
    ok: matches,
    goal_id: goalId,
    thread_id: threadId,
    host_surface: 'deepseek-harness-native',
    agent_id: agent,
    changed: matches,
    written: matches,
    binding: {
      schema_version: 'loopx_thread_agent_binding_v0',
      status: matches ? 'missing' : 'conflict',
      thread_id: threadId,
      host_surface: 'deepseek-harness-native',
      agent_id: null,
    },
    global_sync: { ok: matches },
    registration_readback: { verified: matches },
  }
} else if (command === 'heartbeat-prompt') {
  output = {
    schema_version: 'loopx_heartbeat_prompt_v0',
    ok: true,
    goal_id: goalId,
    agent_id: requestedAgent,
    runtime_profile: 'generic_cli',
    task_body: state.taskBody,
  }
} else if (command === 'status') {
  output = {
    schema_version: 'loopx_status_v0',
    ok: true,
    goal_filter: goalId,
    registry: project + '/private-registry.json',
    attention_queue: {
      items: [{
        goal_id: goalId,
        status: 'active',
        waiting_on: 'agent',
        severity: 'normal',
        recommended_action: 'Continue the selected Todo.',
        private_path: project + '/must-not-project',
      }],
    },
  }
} else if (command === 'todo') {
  output = {
    schema_version: 'loopx_todo_command_v0',
    ok: true,
    goal_id: goalId,
    todo_id: value('--todo-id'),
    status: key === 'todo-complete' ? 'done' : value('--status') ?? 'open',
    changed: true,
    dry_run: false,
    state_file: project + '/private-state.md',
  }
} else if (command === 'quota') {
  output = {
    schema_version: 'loopx_quota_should_run_v0',
    ok: true,
    mode: 'should-run',
    goal_id: goalId,
    decision: 'run',
    should_run: true,
    effective_action: 'run_now',
    agent_identity: { agent_id: requestedAgent },
    heartbeat_receipt: {
      schema_version: 'heartbeat_quota_receipt_v0',
      turn_instance_id: value('--turn-instance-id'),
      status: 'committed',
    },
    scheduler_hint: {
      schema_version: 'scheduler_hint_v0',
      source: 'quota.should-run',
      action: 'run_now',
      cadence_class: 'immediate',
      reset_policy: { reset_token: 'reset-1' },
      unchanged_poll: { limits: { local_scheduler: 2 }, after_limits: { local_scheduler: 'pause' } },
      cold_path_detail: {
        schema_version: 'scheduler_hint_detail_v0',
        local_scheduler: {
          recommended_interval_minutes: 3,
          unchanged_poll_limit: 2,
          after_limit: 'pause',
        },
      },
    },
  }
} else {
  output = { schema_version: 'unknown_v0', ok: false }
}

await writeFile(statePath, JSON.stringify(state))
await appendFile(statePath + '.calls', 'end:' + key + '\n')
if (state.invalidJsonFor === key) process.stdout.write('PRIVATE INVALID OUTPUT')
else process.stdout.write(JSON.stringify(output))
`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function setupHarness(initial: Partial<FakeLoopXState> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loopx-service-test-'))
  const project = join(root, 'project')
  const storageRoot = join(root, 'storage')
  const statePath = join(root, 'fake-state.json')
  const callsPath = `${statePath}.calls`
  const executable = join(root, 'loopx-fixture.mjs')
  await mkdir(project, { recursive: true })
  await mkdir(storageRoot, { recursive: true })
  await writeFile(executable, fakeLoopXSource)
  await chmod(executable, 0o755)
  await writeFile(callsPath, '')
  await writeFile(statePath, JSON.stringify({
    goalId: 'goal-a',
    agents: ['agent-a'],
    bindingAgent: 'agent-a',
    taskBody: 'PRIVATE TASK BODY FROM LOOPX',
    ...initial,
  }))

  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  let serviceFiber = await ctx.plugin(LoopXService, {
    loopxBin: executable,
    project,
    environment: { LOOPX_FAKE_STATE: statePath },
  })
  let disposed = false
  const harness: Harness = {
    ctx,
    root,
    project,
    statePath,
    callsPath,
    service: ctx.loopx,
    async disposeService() {
      await serviceFiber.dispose()
    },
    async reloadService() {
      serviceFiber = await ctx.plugin(LoopXService, {
        loopxBin: executable,
        project,
        environment: { LOOPX_FAKE_STATE: statePath },
      })
      harness.service = ctx.loopx
    },
    async readState() {
      return JSON.parse(await readFile(statePath, 'utf8')) as FakeLoopXState
    },
    async writeState(update) {
      const current = await harness.readState()
      await writeFile(statePath, JSON.stringify({ ...current, ...update }))
    },
    async storageText() {
      const names = await readdir(storageRoot)
      return (await Promise.all(names.map(name => readFile(join(storageRoot, name), 'utf8')))).join('\n')
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
  cleanups.push(harness.dispose)
  return harness
}

function session(project: string, createdAt = 1): LoopXSessionRef {
  return Object.freeze({
    id: 'dsh-session-a',
    identity: Object.freeze({ createdAt, cwd: project }),
  })
}

describe('LoopXService', () => {
  it('stays pending when storage-domain is absent instead of using memory state', async () => {
    const ctx = new Context()
    await ctx.plugin(LoopXService, { loopxBin: 'loopx' })
    expect(ctx.get('loopx')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps the two-phase checkpoint and task body in memory and cold-restores disarmed', async () => {
    const harness = await setupHarness()
    const current = session(harness.project)
    const rawGoal = 'PRIVATE GOAL TEXT THAT MUST NOT PERSIST'

    const started = await harness.service.start(current, rawGoal)
    expect(started).toMatchObject({
      ok: true,
      value: {
        kind: 'planning',
        binding: { phase: 'planning', goalId: 'goal-a', agentId: 'agent-a', generation: 1 },
        modelCheckpoint: 'Plan and write the bounded LoopX Todos.',
      },
    })
    const planning = harness.service.getBinding(current)
    expect(planning.ok && planning.value?.phase).toBe('planning')
    expect(planning.ok && Object.isFrozen(planning.value)).toBe(true)
    expect(harness.service.getBinding(session(harness.project, 2))).toEqual({ ok: true, value: undefined })

    await expect(harness.service.activate(current, 'goal-a', 'agent-b')).resolves.toMatchObject({
      ok: false,
      error: { code: 'LOOPX_IDENTITY_CONFLICT' },
    })
    const activated = await harness.service.activate(current, 'goal-a', 'agent-a')
    expect(activated).toMatchObject({
      ok: true,
      value: { phase: 'active_armed', generation: 2 },
    })
    const firstBody = await harness.service.taskBody(current, 2)
    expect(firstBody).toMatchObject({
      ok: true,
      value: { body: 'PRIVATE TASK BODY FROM LOOPX' },
    })
    await harness.writeState({ taskBody: 'REFRESHED PRIVATE TASK BODY' })
    await expect(harness.service.taskBody(current, 2)).resolves.toMatchObject({
      ok: true,
      value: { body: 'PRIVATE TASK BODY FROM LOOPX' },
    })
    await expect(harness.service.taskBody(current, 2, true)).resolves.toMatchObject({
      ok: true,
      value: { body: 'REFRESHED PRIVATE TASK BODY' },
    })

    const storageBefore = await harness.storageText()
    expect(storageBefore).not.toContain(rawGoal)
    expect(storageBefore).not.toContain('PRIVATE TASK BODY')
    expect(storageBefore).not.toContain('REFRESHED PRIVATE TASK BODY')

    const paused = await harness.service.pause(current)
    expect(paused).toMatchObject({ ok: true, value: { phase: 'active_paused', generation: 3 } })
    const resumed = await harness.service.resume(current)
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active_armed', generation: 4 } })
    await harness.disposeService()
    await harness.reloadService()
    expect(harness.service.getBinding(current)).toMatchObject({
      ok: true,
      value: {
        phase: 'active_paused',
        reason: 'cold_restore',
        generation: 5,
      },
    })
  })

  it('preserves the exact-thread selection gate and supports explicit takeover and detach', async () => {
    const harness = await setupHarness({
      agents: ['agent-a', 'agent-b'],
      bindingAgent: null,
    })
    const current = session(harness.project)
    const started = await harness.service.start(current, 'Implement the bounded change')
    expect(started).toMatchObject({
      ok: true,
      value: {
        kind: 'selection_required',
        selection: { kind: 'agent', defaultAction: 'select_agent_identity' },
      },
    })
    expect(harness.service.getBinding(current)).toEqual({ ok: true, value: undefined })

    const implicit = await harness.service.attach(current, { goalId: 'goal-a' })
    expect(implicit).toMatchObject({
      ok: true,
      value: { kind: 'selection_required', selection: { kind: 'agent' } },
    })
    const attached = await harness.service.attach(current, {
      goalId: 'goal-a',
      agentId: 'agent-b',
    })
    expect(attached).toMatchObject({
      ok: true,
      value: { kind: 'attached', binding: { agentId: 'agent-b', phase: 'active_armed' } },
    })
    expect((await harness.readState()).bindingAgent).toBe('agent-b')
    await expect(harness.service.detach(current)).resolves.toEqual({
      ok: true,
      value: { detached: true },
    })
    expect((await harness.readState()).bindingAgent).toBeNull()
    expect(harness.service.getBinding(current)).toEqual({ ok: true, value: undefined })
  })

  it('registers --new-peer through official contracts and takes over an existing thread binding', async () => {
    const harness = await setupHarness()
    const current = session(harness.project)
    const attached = await harness.service.attach(current, { goalId: 'goal-a', newPeer: true })
    expect(attached.ok).toBe(true)
    if (!attached.ok || attached.value.kind !== 'attached') throw new Error('new peer did not attach')
    expect(attached.value.binding.agentId).toMatch(/^dsh-[a-f0-9]{20}$/u)
    const state = await harness.readState()
    expect(state.agents).toContain(attached.value.binding.agentId)
    expect(state.bindingAgent).toBe(attached.value.binding.agentId)
  })

  it('rejects an unregistered explicit lane before changing the authoritative thread binding', async () => {
    const harness = await setupHarness()
    const current = session(harness.project)

    await expect(harness.service.attach(current, {
      goalId: 'goal-a',
      agentId: 'agent-not-registered',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'LOOPX_IDENTITY_CONFLICT' },
    })
    expect((await harness.readState()).bindingAgent).toBe('agent-a')
    expect(harness.service.getBinding(current)).toEqual({ ok: true, value: undefined })
  })

  it('persists a disarmed sidecar when attach write or readback cannot be verified', async () => {
    const uncertainHarness = await setupHarness({
      bindingAgent: null,
      invalidJsonFor: 'bind-agent-thread',
    })
    const uncertainSession = session(uncertainHarness.project)

    await expect(uncertainHarness.service.attach(uncertainSession, {
      goalId: 'goal-a',
      agentId: 'agent-a',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'LOOPX_SCHEMA_UNSUPPORTED', outcomeUncertain: true },
    })
    expect(uncertainHarness.service.getBinding(uncertainSession)).toMatchObject({
      ok: true,
      value: {
        goalId: 'goal-a',
        agentId: 'agent-a',
        phase: 'uncertain',
        reason: 'uncertain_write',
      },
    })

    const pausedHarness = await setupHarness({ invalidJsonFor: 'heartbeat-prompt' })
    const pausedSession = session(pausedHarness.project)
    await expect(pausedHarness.service.attach(pausedSession, { goalId: 'goal-a' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'LOOPX_SCHEMA_UNSUPPORTED', outcomeUncertain: false },
      })
    expect(pausedHarness.service.getBinding(pausedSession)).toMatchObject({
      ok: true,
      value: {
        goalId: 'goal-a',
        agentId: 'agent-a',
        phase: 'active_paused',
        reason: 'readback_failed',
      },
    })
  })

  it('serializes Session mutations, projects bounded output, and disarms uncertain writes', async () => {
    const harness = await setupHarness({ delayCommand: 'todo-update', delayMs: 35 })
    const current = session(harness.project)
    const attached = await harness.service.attach(current, { goalId: 'goal-a' })
    expect(attached.ok).toBe(true)

    const [first, second] = await Promise.all([
      harness.service.todoUpdate(current, { todoId: 'todo-a', status: 'blocked' }),
      harness.service.todoUpdate(current, { todoId: 'todo-b', status: 'open' }),
    ])
    expect(first).toMatchObject({ ok: true, value: { todoId: 'todo-a' } })
    expect(second).toMatchObject({ ok: true, value: { todoId: 'todo-b' } })
    const calls = (await readFile(harness.callsPath, 'utf8')).trim().split('\n')
    expect(calls.filter(line => line.includes('todo-update'))).toEqual([
      'start:todo-update',
      'end:todo-update',
      'start:todo-update',
      'end:todo-update',
    ])
    if (!first.ok) throw new Error('first Todo update failed')
    expect(JSON.stringify(first.value.payload)).not.toContain('private-state.md')

    const status = await harness.service.status(current)
    expect(status.ok).toBe(true)
    expect(JSON.stringify(status)).not.toContain('private-registry.json')
    expect(JSON.stringify(status)).not.toContain('must-not-project')
    const quota = await harness.service.quotaShouldRun(current, 'turn-a')
    expect(quota).toMatchObject({
      ok: true,
      value: {
        shouldRun: true,
        terminalNoFollowup: false,
        schedulerHint: { resetToken: 'reset-1', recommendedIntervalMinutes: 3 },
      },
    })

    await harness.writeState({ invalidJsonFor: 'todo-update', delayCommand: undefined })
    const uncertain = await harness.service.todoUpdate(current, {
      todoId: 'todo-c',
      note: 'public note',
    })
    expect(uncertain).toMatchObject({
      ok: false,
      error: { code: 'LOOPX_SCHEMA_UNSUPPORTED', outcomeUncertain: true },
    })
    expect(JSON.stringify(uncertain)).not.toContain('PRIVATE INVALID OUTPUT')
    expect(harness.service.getBinding(current)).toMatchObject({
      ok: true,
      value: { phase: 'uncertain', reason: 'uncertain_write' },
    })
  })

  it('invalidates stale scheduler fences and drains admitted work during service disposal', async () => {
    const harness = await setupHarness()
    const current = session(harness.project)
    const attached = await harness.service.attach(current, { goalId: 'goal-a' })
    if (!attached.ok || attached.value.kind !== 'attached') throw new Error('attach failed')
    const fence = harness.service.fence(current)
    if (!fence.ok) throw new Error('fence missing')
    const scheduled = await harness.service.updateScheduler(
      current,
      fence.value,
      {
        action: 'wait',
        cadenceClass: 'monitor_wait',
        resetToken: 'reset-a',
        recommendedIntervalMinutes: 3,
        unchangedPollLimit: 2,
        afterLimit: 'pause',
      },
      1,
      Date.now() + 1_000,
    )
    expect(scheduled).toMatchObject({
      ok: true,
      value: { schedulerResetToken: 'reset-a', unchangedPollCount: 1 },
    })
    await harness.service.pause(current)
    expect(harness.service.fenceIsCurrent(fence.value)).toBe(false)
    const paused = harness.service.getBinding(current)
    expect(paused).toMatchObject({
      ok: true,
      value: {
        phase: 'active_paused',
      },
    })
    if (!paused.ok || paused.value === undefined) throw new Error('paused binding missing')
    expect(paused.value).not.toHaveProperty('schedulerResetToken')
    expect(paused.value).not.toHaveProperty('nextCheckAt')

    await harness.service.resume(current)
    await harness.writeState({ delayCommand: 'todo-update', delayMs: 1_000 })
    const service = harness.service
    const first = service.todoUpdate(current, { todoId: 'todo-dispose-a', status: 'open' })
    const second = service.todoUpdate(current, { todoId: 'todo-dispose-b', status: 'open' })
    await new Promise(resolve => setTimeout(resolve, 25))
    await harness.disposeService()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await expect(service.todoUpdate(current, { todoId: 'after-close', status: 'open' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'LOOPX_SERVICE_CLOSED' } })
  })

  it('applies fail-closed transitions with an in-queue generation fence', async () => {
    const harness = await setupHarness({ delayCommand: 'heartbeat-prompt', delayMs: 35 })
    const current = session(harness.project)
    const attached = await harness.service.attach(current, { goalId: 'goal-a' })
    if (!attached.ok || attached.value.kind !== 'attached') throw new Error('attach failed')

    const firstFence = harness.service.fence(current)
    if (!firstFence.ok) throw new Error('first fence missing')
    const firstResume = harness.service.resume(current)
    const stalePause = harness.service.pause(current, 'readback_failed', firstFence.value)
    await expect(firstResume).resolves.toMatchObject({ ok: true, value: { generation: 2 } })
    await expect(stalePause).resolves.toMatchObject({
      ok: false,
      error: { code: 'LOOPX_DRIVER_NOT_ARMED' },
    })
    expect(harness.service.getBinding(current)).toMatchObject({
      ok: true,
      value: { phase: 'active_armed', generation: 2 },
    })

    const secondFence = harness.service.fence(current)
    if (!secondFence.ok) throw new Error('second fence missing')
    const secondResume = harness.service.resume(current)
    const staleUncertain = harness.service.markUncertain(
      current,
      'uncertain_write',
      secondFence.value,
    )
    await expect(secondResume).resolves.toMatchObject({ ok: true, value: { generation: 3 } })
    await expect(staleUncertain).resolves.toMatchObject({
      ok: false,
      error: { code: 'LOOPX_DRIVER_NOT_ARMED' },
    })
    expect(harness.service.getBinding(current)).toMatchObject({
      ok: true,
      value: { phase: 'active_armed', generation: 3 },
    })
    await expect(harness.service.taskBody(current, 3)).resolves.toMatchObject({
      ok: true,
      value: { body: 'PRIVATE TASK BODY FROM LOOPX' },
    })
  })

  it('keeps a certain retryable quota failure armed for the driver retry', async () => {
    const harness = await setupHarness()
    const current = session(harness.project)
    const attached = await harness.service.attach(current, { goalId: 'goal-a' })
    if (!attached.ok || attached.value.kind !== 'attached') throw new Error('attach failed')
    const before = harness.service.getBinding(current)
    const controller = new AbortController()
    controller.abort(new Error('test cancellation'))

    const result = await harness.service.quotaShouldRun(current, 'turn-retry', controller.signal)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LOOPX_CLI_ABORTED', retryable: true, outcomeUncertain: false },
    })
    expect(harness.service.getBinding(current)).toEqual(before)
  })
})
