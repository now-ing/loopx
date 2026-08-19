# LoopX for DeepSeek Harness

`dsh-loopx-plugin` adds a same-session `/loopx` command, five bounded model
tools, and a quota-gated continuation driver to the DeepSeek Harness `web`
profile. LoopX remains the only authority for Goal, Todo, quota, status,
evidence, and terminal state; DSH persists only a Host binding sidecar.

This package targets DSH `0.1.0-rc.7`, Node.js `^22.19.0 || >=24`, and a
locally installed `loopx` command. The plugin invokes that executable with
Node `execFile` and argv arrays. It does not invoke Python directly, start a
nested DSH process, or call `loopx turn run-once`.

## Prerequisites

Confirm both CLIs before installing the bundle:

```bash
dsh --version
command -v loopx
loopx --version
```

The LoopX binary resolution order is:

1. `loopxBin` in the `loopx-service` row config;
2. `LOOPX_BIN` in the DSH Host environment;
3. `loopx` on `PATH` (the normal default).

## Install from a local checkout

Build the package, then add its directory to the `web` profile:

```bash
cd packages/dsh-loopx-plugin
corepack pnpm install --frozen-lockfile --ignore-scripts
pnpm build
dsh plugin --profile web add "$PWD"
```

For a reviewable prebuilt artifact:

```bash
pnpm pack --pack-destination <artifact-directory>
dsh plugin --profile web add <artifact-directory>/dsh-loopx-plugin-0.1.0.tgz
```

Read back the composed profile before starting DSH:

```bash
dsh --profile web --dump-config
```

The dump must contain `loopx-service`, `loopx-command`, `loopx-tools`, and
`loopx-driver`, in that order, plus the `web` profile's `storage-domain` row
with `backend: json`. If the storage-domain service is unavailable, the LoopX
service stays pending; it never falls back to process memory.

To select an explicit executable without changing the profile, launch DSH
with `LOOPX_BIN=/path/to/loopx`. A profile-local override can instead replace
the bundle row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: loopx-service
      name: dsh-loopx-plugin/service
      config:
        loopxBin: /path/to/loopx
```

Optional service config also includes `project`, `runtimeRoot`, and an
explicit child-only `environment` mapping. Do not place credentials in that
mapping. Defaults are 15 seconds for reads, 30 seconds for writes, 1 MiB for
stdout, and 256 KiB for stderr.

## Use

Start a new Goal from the current visible DSH Session:

```text
/loopx implement the requested change
```

Start is deliberately two-phase. The command first asks LoopX for the exact
Goal/agent binding and queues a planning checkpoint on the same DSH Agent.
After the model has refreshed the bounded LoopX Todos, the
`loopx_goal_activate` tool performs authoritative readback and arms the local
driver. The model cannot supply another Session, a registry path, a task body,
or arbitrary CLI arguments.

Attach an existing Goal only with an explicit identity decision:

```text
/loopx attach <goal-id> <agent-id>
/loopx attach <goal-id> --new-peer
```

Inspect or control only the Host continuation layer:

```text
/loopx status
/loopx pause
/loopx resume
/loopx detach
```

`status` labels the DSH Host sidecar separately from live LoopX authority.
`pause` and `detach` do not complete, pause, delete, or otherwise rewrite the
LoopX Goal or its Todos. Resume revalidates the exact binding and refetches
the task body before arming a new generation.

At an idle boundary the driver asks LoopX quota whether the exact lane should
run. It reuses one turn identity for at most one certain, retryable quota
retry. Scheduler hints produce one per-Session timer and become quiet at the
unchanged limit. Only a LoopX-validated terminal closure stops without another
follow-up. Human input or another command preempts the automatic lane and
pauses that binding with a generation fence.

## Remove

```bash
dsh plugin --profile web remove dsh-loopx-plugin
dsh --profile web --dump-config
```

Removal deletes the bundle layer only. It does not delete LoopX state and v1
does not implicitly purge the storage-domain sidecar. Reinstalling still
performs Session lifecycle checks and cold-restores any formerly armed row as
paused, requiring an explicit `/loopx resume`.

## Authority and privacy boundary

- `ctx.loopx` is isolated from DSH `ctx.goals`; installing this bundle neither
  reads nor mutates the DSH Goal service.
- LoopX is authoritative for Goal, Todo, quota, status, evidence, scheduler,
  and terminal facts. DSH stores only Session identity, exact Goal/agent ids,
  Host locators, driver generation, scheduler hint bookkeeping, and lifecycle
  reason in its private sidecar.
- Goal text and task bodies are memory-only. Raw CLI stdout/stderr, transcripts,
  environment variables, credentials, and tool logs are not persisted in the
  sidecar or projected into model output.
- Installing the bundle adds commands and tools; it grants no filesystem,
  shell, network, credential, production, or cross-Session authority.

## v1 limits

The supported runbook is the DSH `web` profile on one protected local Host.
There is no Client-plane UI row, automatic sidecar purge, cross-machine
scheduler, shared multi-process storage-root coordination, or migration from
the external `deepseek-harness` / `dsh` LoopX Turn adapter.

See the canonical
[DeepSeek Harness native plugin integration guide](https://github.com/huangruiteng/loopx/blob/main/docs/integrations/deepseek-harness-native-plugin.md)
and the separate
[external DeepSeek Harness connector](https://github.com/huangruiteng/loopx/blob/main/docs/integrations/deepseek-harness-connector.md).
