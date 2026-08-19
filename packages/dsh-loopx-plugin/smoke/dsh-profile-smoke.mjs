#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = process.env.DSH_BIN || join(packageRoot, 'node_modules', '.bin', 'dsh')
const profileName = 'web'
const bundleRows = [
  ['loopx-service', 'dsh-loopx-plugin/service'],
  ['loopx-command', 'dsh-loopx-plugin/command'],
  ['loopx-tools', 'dsh-loopx-plugin/tools'],
  ['loopx-driver', 'dsh-loopx-plugin/driver'],
]

function parseSpecs(argv) {
  const specs = []
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--package-path' && flag !== '--tarball') {
      throw new Error(`unsupported argument: ${flag}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${flag} requires a path`)
    specs.push({ kind: flag === '--tarball' ? 'tarball' : 'path', value: resolve(value) })
    index += 1
  }
  if (specs.length === 0) throw new Error('pass --package-path and/or --tarball')
  return specs
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `${file} ${args.join(' ')} failed with ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

function assertPackedFiles(tarball) {
  const entries = run('tar', ['-tf', tarball]).trim().split('\n').filter(Boolean)
  assert(entries.length > 0, 'tarball is empty')
  for (const entry of entries) {
    assert.match(entry, /^package\/(?:package\.json|README\.md|LICENSE|NOTICE|cordis\.patch\.yml|lib\/[^/]+\.js|lib\/types\/[^/]+\.d\.ts)$/u)
  }
  for (const required of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/NOTICE',
    'package/cordis.patch.yml',
    'package/lib/service.js',
    'package/lib/command.js',
    'package/lib/tools.js',
    'package/lib/driver.js',
    'package/lib/types/service.d.ts',
  ]) {
    assert(entries.includes(required), `tarball is missing ${required}`)
  }
}

function assertInstalledConfig(dump) {
  let previous = -1
  for (const [id, name] of bundleRows) {
    const position = dump.indexOf(`id: ${id}`)
    assert(position > previous, `missing or unordered bundle row ${id}`)
    assert(dump.includes(`name: ${name}`), `missing bundle module ${name}`)
    previous = position
  }
  assert.match(dump, /id: storage-domain[\s\S]{0,240}backend: json/u)
  assert(!dump.includes('dsh.client: dsh-loopx-plugin'), 'v1 must not add a Client-plane row')
}

async function textTree(root) {
  let output = ''
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output += await textTree(path)
    else if (entry.isFile()) output += await readFile(path, 'utf8')
  }
  return output
}

const mockLoopXSource = String.raw`#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const state = process.env.LOOPX_SMOKE_STATE
if (!state) throw new Error('LOOPX_SMOKE_STATE is required')
const value = flag => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
if (value('--format') !== 'json') throw new Error('JSON format is required')
const commands = new Set(['start-goal', 'bootstrap-command-pack', 'heartbeat-prompt', 'status', 'quota'])
const index = args.findIndex(arg => commands.has(arg))
const command = args[index]
const goalId = value('--goal-id') ?? 'goal-smoke'
const agentId = value('--agent-id') ?? 'agent-smoke'
const threadId = value('--thread-id') ?? 'session-smoke'
const project = value('--project') ?? process.cwd()
await appendFile(state, command + '\n')

let output
if (command === 'start-goal') {
  output = {
    schema_version: 'loopx_start_goal_guided_v0', ok: true, read_only: true, guided: true,
    project, goal_id: goalId, agent_id: agentId,
    host_surface: 'deepseek-harness-native', thread_id: threadId,
    thread_agent_binding: { status: 'bound', agent_id: agentId },
    project_connection: { registry: project + '/.loopx/registry.json' },
    guided_transaction: {
      schema_version: 'loopx_start_goal_guided_v0',
      ordered_steps: [
        { id: 'inspect', kind: 'read_only' },
        { id: 'plan', kind: 'model_checkpoint', prompt: 'Plan, refresh bounded Todos, then call loopx_goal_activate.' },
      ],
    },
  }
} else if (command === 'bootstrap-command-pack') {
  output = {
    schema_version: 'loopx_bootstrap_command_pack_v0', ok: true, read_only: true,
    project, goal_id: goalId, agent_id: agentId, agent_type: 'deepseek-harness-native',
    host_surface: 'deepseek-harness-native', thread_id: threadId,
    thread_agent_binding: { status: 'bound', agent_id: agentId },
    project_connection: { registry: project + '/.loopx/registry.json' },
    host_loop_activation: {
      schema_version: 'loopx_host_loop_activation_v1', agent_type: 'deepseek-harness-native',
      goal_id: goalId, agent_id: agentId, activation_allowed: true,
      identity_contract: { schema_version: 'loopx_host_loop_identity_selection_v0', registered_agents: [agentId] },
      identity_selection_gate: null, host_surface: 'deepseek_harness_native_session',
      activation_method: 'current_session_host_tool',
      activation_input: {
        schema_version: 'loopx_deepseek_harness_native_activation_input_v0',
        tool: 'loopx_goal_activate', arguments: { goalId, agentId },
      },
      host_mutation: {
        owner: 'DSH LoopX plugin', host_tool: 'loopx_goal_activate', current_session_only: true,
        cli_can_mutate_directly: false,
        forbidden_tool_arguments: ['sessionId', 'registryPath', 'taskBody', 'argv'],
      },
    },
  }
} else if (command === 'heartbeat-prompt') {
  output = {
    schema_version: 'loopx_heartbeat_prompt_v0', ok: true, goal_id: goalId,
    agent_id: agentId, runtime_profile: 'generic_cli', task_body: 'SMOKE PRIVATE TASK BODY',
  }
} else if (command === 'status') {
  output = {
    schema_version: 'loopx_status_v0', ok: true, goal_filter: goalId,
    attention_queue: { items: [{ goal_id: goalId, status: 'active', waiting_on: 'agent' }] },
  }
} else if (command === 'quota' && args[index + 1] === 'should-run') {
  output = {
    schema_version: 'loopx_quota_should_run_v0', ok: true, mode: 'should-run',
    goal_id: goalId, decision: 'run', should_run: true, effective_action: 'run_now',
    agent_identity: { agent_id: agentId },
    heartbeat_receipt: {
      schema_version: 'heartbeat_quota_receipt_v0',
      turn_instance_id: value('--turn-instance-id'), status: 'committed',
    },
    scheduler_hint: {
      schema_version: 'scheduler_hint_v0', source: 'quota.should-run', action: 'run_now',
      cadence_class: 'immediate', reset_policy: { reset_token: 'smoke-reset' },
      unchanged_poll: { limits: { local_scheduler: 2 }, after_limits: { local_scheduler: 'pause' } },
      cold_path_detail: {
        schema_version: 'scheduler_hint_detail_v0',
        local_scheduler: { recommended_interval_minutes: 3, unchanged_poll_limit: 2, after_limit: 'pause' },
      },
    },
  }
} else {
  output = { schema_version: 'unsupported_v0', ok: false }
}
process.stdout.write(JSON.stringify(output))
`

async function importFrom(requireFromPlugin, specifier) {
  return import(pathToFileURL(requireFromPlugin.resolve(specifier)).href)
}

async function exerciseInstalledPlugin(installedDir, home, mockLoopX, statePath) {
  const requireFromPlugin = createRequire(join(installedDir, 'package.json'))
  const [{ Context }, Storage, StorageDomain, StorageJson, serviceModule, commandModule, toolsModule, driverModule] = await Promise.all([
    importFrom(requireFromPlugin, '@deepseek-ai/cordis'),
    importFrom(requireFromPlugin, '@deepseek-ai/dsh-storage'),
    importFrom(requireFromPlugin, '@deepseek-ai/dsh-storage-domain'),
    importFrom(requireFromPlugin, '@deepseek-ai/dsh-storage-json'),
    import(pathToFileURL(join(installedDir, 'lib', 'service.js')).href),
    import(pathToFileURL(join(installedDir, 'lib', 'command.js')).href),
    import(pathToFileURL(join(installedDir, 'lib', 'tools.js')).href),
    import(pathToFileURL(join(installedDir, 'lib', 'driver.js')).href),
  ])
  const storageRoot = join(home, 'behavior-storage')
  const project = join(home, 'behavior-project')
  await mkdir(project, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Storage.default)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(serviceModule.LoopXService, {
    loopxBin: mockLoopX,
    project,
    environment: { LOOPX_SMOKE_STATE: statePath },
  })
  assert.equal(ctx.get('goals'), undefined, 'ctx.loopx must not mount or consume ctx.goals')
  const service = ctx.get('loopx')
  assert(service, 'LoopX service did not activate over storage-domain')

  const commands = new Map()
  commandModule.apply({ loopx: service, commands: { register: value => commands.set(value.name, value) } })
  const tools = new Map()
  toolsModule.apply({ loopx: service, tools: { register: value => tools.set(value.name, value) } })
  const followups = []
  const nextTurn = []
  let status = 'idle'
  let driver
  let agent
  agent = {
    id: 'session-smoke',
    session: { id: 'session-smoke', header: { version: 0, id: 'session-smoke', createdAt: 7, cwd: project } },
    get status() { return status },
    inbox: {
      nextTurn,
      nextStep: [],
      get hasPending() { return nextTurn.length > 0 },
      remove(id) {
        const position = nextTurn.findIndex(message => message.id === id)
        if (position < 0) return false
        nextTurn.splice(position, 1)
        return true
      },
    },
    followup(message) {
      followups.push(message)
      nextTurn.push(message)
      if (driver) {
        driver.onInboxInserted(agent, message)
        status = 'running'
        driver.onAgentStatus(agent, 'running')
      }
    },
    cancel() { status = 'idle' },
    whenIdle() { status = 'idle'; return Promise.resolve() },
  }
  const command = commands.get('loopx')
  assert(command, '/loopx command was not registered')
  const signal = new AbortController().signal
  const invoke = rawInput => command.handler({ commandId: 'smoke-command', agent, rawInput, signal })
  const started = await invoke('start smoke goal')
  assert.equal(started.kind, 'success')
  assert.equal(followups.length, 1, 'two-phase start did not enqueue the planning checkpoint')
  assert.match(followups[0].content[0].text, /loopx_goal_activate/u)

  const activate = tools.get('loopx_goal_activate')
  assert(activate, 'activation tool was not registered')
  const activated = await activate.execute(
    { goalId: 'goal-smoke', agentId: 'agent-smoke' },
    { agent, signal },
  )
  assert.equal(activated.ok, true)
  const readback = await invoke('status')
  assert.equal(readback.kind, 'success')
  assert.match(readback.text, /active_armed/u)
  assert.match(readback.text, /LoopX authoritative state/u)

  followups.length = 0
  nextTurn.length = 0
  status = 'idle'
  driver = new driverModule.LoopXContinuationDriver({
    service,
    isLiveAgent: current => current === agent,
    makeTurnInstanceId: () => 'turn-smoke',
  })
  driver.observeAgent(agent)
  driver.onAgentStatus(agent, 'idle')
  await driver.whenSettled()
  assert.equal(followups.length, 1, 'idle continuation did not enqueue exactly one same-Agent follow-up')
  assert.equal(followups[0].source.kind, 'plugin')
  assert.equal(followups[0].source.plugin, 'dsh-loopx-plugin')
  assert.equal(followups[0].content[0].text, 'SMOKE PRIVATE TASK BODY')

  driver.onInboxInserted(agent, {
    id: 'human-smoke', role: 'user', content: [{ type: 'text', text: 'human preemption' }],
    source: { kind: 'user' },
  })
  await driver.whenSettled()
  const paused = service.getBinding({ id: 'session-smoke', identity: { createdAt: 7, cwd: project } })
  assert.equal(paused.ok, true)
  assert.equal(paused.value?.phase, 'active_paused')
  assert.equal(paused.value?.reason, 'foreign_input')
  await driver.dispose()
  await ctx.fiber.dispose()

  const stored = await textTree(storageRoot)
  assert(!stored.includes('SMOKE PRIVATE TASK BODY'), 'task body leaked into Host sidecar')
  assert(!stored.includes('smoke goal'), 'raw Goal text leaked into Host sidecar')
}

async function runProfileSmoke(spec, ordinal) {
  if (spec.kind === 'tarball') assertPackedFiles(spec.value)
  const home = await mkdtemp(join(tmpdir(), `dsh-loopx-profile-${ordinal}-`))
  const mockLoopX = join(home, 'loopx-smoke.mjs')
  const statePath = join(home, 'loopx-calls.txt')
  await writeFile(mockLoopX, mockLoopXSource)
  await chmod(mockLoopX, 0o755)
  await writeFile(statePath, '')
  const env = { ...process.env, DSH_HOME: home, LOOPX_BIN: mockLoopX }
  try {
    run(dshBin, ['plugin', '--profile', profileName, 'add', spec.value, '--offline', '--ignore-scripts'], { env })
    const dump = run(dshBin, ['--profile', profileName, '--dump-config'], { env })
    assertInstalledConfig(dump)
    const installed = await realpath(join(home, 'profiles', profileName, 'node_modules', 'dsh-loopx-plugin'))
    await exerciseInstalledPlugin(installed, home, mockLoopX, statePath)
    run(dshBin, ['plugin', '--profile', profileName, 'remove', 'dsh-loopx-plugin'], { env })
    const removed = run(dshBin, ['--profile', profileName, '--dump-config'], { env })
    for (const [id] of bundleRows) assert(!removed.includes(`id: ${id}`), `remove retained ${id}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const specs = parseSpecs(process.argv.slice(2))
for (const [index, spec] of specs.entries()) await runProfileSmoke(spec, index + 1)
process.stdout.write(`dsh-loopx profile smoke passed (${specs.map(spec => spec.kind).join(', ')})\n`)
