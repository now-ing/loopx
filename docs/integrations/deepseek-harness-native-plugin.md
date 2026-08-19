# DeepSeek Harness Native LoopX Plugin

Status: public-safe v1 integration for running a LoopX-governed continuation
inside the current visible DeepSeek Harness Session.

The native provider is an optional DSH bundle in
`packages/dsh-loopx-plugin/`. Its canonical LoopX agent type is
`deepseek-harness-native`; `dsh-native` is only an input alias. It is separate
from the existing `deepseek-harness` / `dsh` external adapter and is not a
migration or replacement for that connector.

## Choose the correct surface

| Need | Agent type | Execution shape | Entry point |
| --- | --- | --- | --- |
| Continue inside the current visible DSH Agent and Session | `deepseek-harness-native` (`dsh-native` alias) | Same-process command, tools, follow-up, and Host sidecar | `/loopx <task>` after installing `dsh-loopx-plugin` |
| Run one isolated, independently validated DSH-backed LoopX Turn | `deepseek-harness` (`dsh` alias) | External Python SDK adapter and headless runtime | `loopx turn run-once` with `scripts/dsh_turn_host_adapter.py` |

Both surfaces keep LoopX authoritative for Goal, Todo, gate, quota, evidence,
scheduler, and terminal state. They differ only in Host integration and
execution lifecycle.

## Install and verify

Prerequisites are DSH `0.1.0-rc.7`, Node.js `^22.19.0 || >=24`, and a local
`loopx` executable:

```bash
dsh --version
command -v loopx
loopx --version
```

Build and add the local bundle to the supported `web` profile:

```bash
cd packages/dsh-loopx-plugin
corepack pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
dsh plugin --profile web add "$PWD"
```

The canonical artifact path is a prebuilt tarball:

```bash
pnpm pack --pack-destination <artifact-directory>
dsh plugin --profile web add <artifact-directory>/dsh-loopx-plugin-0.1.0.tgz
```

Profile readback is boot-free and must show four Host rows plus durable JSON
storage-domain routing:

```bash
dsh --profile web --dump-config
```

Expected rows are `loopx-service`, `loopx-command`, `loopx-tools`, and
`loopx-driver`. The `storage-domain` row must resolve `backend: json`. The
service declares `storageDomain` as a required injection and therefore stays
pending when that backend is absent; no memory-only fallback exists.

## Local LoopX executable

The plugin uses Node `execFile` with argv arrays. It never evaluates packet
command strings and does not invoke Python directly. Resolution is explicit
`loopxBin` config, then `LOOPX_BIN`, then the locally installed `loopx` on
`PATH`. The normal setup is therefore simply:

```bash
command -v loopx
dsh --profile web
```

Use `LOOPX_BIN=/path/to/loopx dsh --profile web` when the binary is not on the
Host `PATH`. Optional config can pin `project`, `runtimeRoot`, timeouts and
byte caps, or a minimal child-only environment. The defaults are read timeout
15 seconds, write timeout 30 seconds, stdout 1 MiB, and stderr 256 KiB.

## Same-Session lifecycle

Start through the visible DSH command surface:

```text
/loopx implement the bounded change
```

LoopX returns an exact thread/Goal/agent identity and a formal planning
checkpoint. The checkpoint is queued to the same Agent. Only after planning
and Todo refresh does the bounded `loopx_goal_activate` Host tool read the
canonical activation packet, fetch the heartbeat task body into memory, and
arm the driver.

Existing Goals require an explicit lane decision:

```text
/loopx attach <goal-id> <agent-id>
/loopx attach <goal-id> --new-peer
```

The model-facing surface contains exactly five tools:

- `loopx_goal_activate`
- `loopx_status`
- `loopx_todo_claim`
- `loopx_todo_update`
- `loopx_todo_complete`

All derive the current Session identity. Alternate Session ids, registry
paths, task bodies, arbitrary argv, and unsupported fields are rejected and
the active driver fails closed.

At each idle boundary, the driver calls `loopx quota should-run` with runtime
profile `generic_cli`, scheduler detail, and one unique turn identity. A
certain retryable failure gets at most one retry with that same identity.
Generation and lifecycle fences protect every post-await follow-up, scheduler
write, pause, uncertain transition, reload, disposal, and foreign-input path.

## Observe, pause, resume, and detach

```text
/loopx status
/loopx pause
/loopx resume
/loopx detach
```

The status output separates the DSH Host sidecar projection from live LoopX
authority. Pause changes only driver state. Resume revalidates LoopX identity
and refetches task text before arming a fresh generation. Detach removes the
current Session binding and performs authoritative unbind readback; it does
not alter the Goal or Todo lifecycle.

Human messages, foreign plugin messages, and command runs preempt automatic
continuation. The driver owns at most one evaluation, AbortController, timer,
and follow-up attempt per Session. It becomes quiet when the LoopX scheduler
unchanged limit is reached and treats only a validated terminal-no-follow-up
receipt as terminal.

## Remove and rollback

```bash
dsh plugin --profile web remove dsh-loopx-plugin
dsh --profile web --dump-config
```

Removal takes away the command, tools, service, and driver rows. It does not
delete LoopX state or purge the DSH storage-domain sidecar. v1 has no implicit
purge command. On reinstall, a stored armed binding cold-restores paused and
requires exact lifecycle readback plus explicit resume.

## Authority and privacy

`ctx.loopx` and `ctx.goals` are fully isolated. DSH retains only Host binding
identity, locators, lifecycle phase/generation, scheduler bookkeeping, and a
bounded reason. Goal text and task bodies stay in memory. Raw transcripts,
raw command output, Todo evidence, environment values, credentials, and local
logs are neither stored in the sidecar nor published as LoopX evidence.

Installing the provider exposes interfaces but grants no new file, shell,
network, credential, production, or cross-Session authority. Multi-Host
processes sharing one storage root, cross-machine scheduling, and hostile
local callers are outside the v1 threat model.

## Hermetic acceptance

Maintainers validate both a built package directory and its tarball against a
temporary `DSH_HOME`:

```bash
node smoke/dsh-profile-smoke.mjs \
  --package-path . \
  --tarball <artifact-directory>/dsh-loopx-plugin-0.1.0.tgz
```

The smoke performs real DSH plugin add/dump/remove operations, uses a mock
LoopX executable, and checks `/loopx status`, two-phase activation, one idle
continuation, foreign-input pause, sidecar privacy, and tarball contents. It
does not start a model, access the network, require credentials, or touch the
user's existing DSH Profile.

## Related contracts

- [External DeepSeek Harness connector](deepseek-harness-connector.md)
- [Runtime connector catalog](runtime-connector-catalog.md)
- [Host integration surface v0](../reference/protocols/host-integration-surface-v0.md)
- [LoopX Turn v0](../reference/protocols/loopx-turn-v0.md)
