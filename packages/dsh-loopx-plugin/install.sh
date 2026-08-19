#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_JSON="$SCRIPT_DIR/package.json"
OUTPUT_DIR="$SCRIPT_DIR/output"
PACKAGE_NAME="dsh-loopx-plugin"
PROFILE_NAME="web"

usage() {
  cat <<'EOF'
Usage: ./install.sh [--help]

Build and install the current dsh-loopx-plugin package into the DSH web
profile. The package version is always read from package.json, and the packed
tarball is retained under output/.

Environment:
  LOOPX_BIN=/path/to/loopx  Override the LoopX CLI used for the preflight.
  DSH_BIN=/path/to/dsh      Override the package-local DSH CLI.
EOF
}

case "${1:-}" in
  -h|--help)
    if [[ "$#" -ne 1 ]]; then
      echo 'install: --help does not accept additional arguments' >&2
      usage >&2
      exit 2
    fi
    usage
    exit 0
    ;;
  '')
    ;;
  *)
    echo "install: unsupported argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "$#" -gt 1 ]]; then
  echo 'install: positional arguments are not supported' >&2
  usage >&2
  exit 2
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install: required command not found on PATH: $1" >&2
    if [[ "$1" == 'pnpm' ]]; then
      echo 'install: install pnpm or enable its Corepack shim first' >&2
    fi
    exit 2
  fi
}

resolve_command() {
  command -v "$1" 2>/dev/null
}

need node
need pnpm

PACKAGE_VERSION="$(
  node -e '
    const fs = require("node:fs")
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (manifest.name !== "dsh-loopx-plugin") {
      throw new TypeError("package.json name must be dsh-loopx-plugin")
    }
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      throw new TypeError("package.json version must be a non-empty string")
    }
    process.stdout.write(manifest.version)
  ' "$PACKAGE_JSON"
)"

if [[ ! "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "install: package.json contains an invalid semantic version: $PACKAGE_VERSION" >&2
  exit 2
fi

requested_loopx="${LOOPX_BIN:-loopx}"
if ! loopx_bin="$(resolve_command "$requested_loopx")"; then
  echo "install: LoopX CLI not found: $requested_loopx" >&2
  echo 'install: install LoopX first or set LOOPX_BIN=/path/to/loopx' >&2
  exit 2
fi
if ! "$loopx_bin" --version >/dev/null 2>&1; then
  echo "install: LoopX CLI preflight failed: $requested_loopx --version" >&2
  exit 2
fi

echo "install: preparing $PACKAGE_NAME@$PACKAGE_VERSION"
CI=true pnpm --dir "$SCRIPT_DIR" install --frozen-lockfile --ignore-scripts

if [[ -n "${DSH_BIN:-}" ]]; then
  if ! dsh_bin="$(resolve_command "$DSH_BIN")"; then
    echo "install: explicit DSH_BIN is not executable: $DSH_BIN" >&2
    exit 2
  fi
else
  dsh_bin="$SCRIPT_DIR/node_modules/.bin/dsh"
  if [[ ! -x "$dsh_bin" ]]; then
    echo "install: package-local DSH CLI is missing after pnpm install: $dsh_bin" >&2
    exit 2
  fi
fi
if ! "$dsh_bin" --version >/dev/null 2>&1; then
  echo 'install: DSH CLI preflight failed' >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"
tarball="$OUTPUT_DIR/$PACKAGE_NAME-$PACKAGE_VERSION.tgz"

echo "install: packing $tarball"
pnpm --dir "$SCRIPT_DIR" pack --out "$tarball"
if [[ ! -s "$tarball" ]]; then
  echo "install: pnpm did not create the expected tarball: $tarball" >&2
  exit 1
fi

echo "install: installing or updating $PACKAGE_NAME in DSH profile $PROFILE_NAME"
"$dsh_bin" plugin --profile "$PROFILE_NAME" add "$tarball" --ignore-scripts

if ! profile_dump="$("$dsh_bin" --profile "$PROFILE_NAME" --dump-config)"; then
  echo "install: DSH profile $PROFILE_NAME could not be read back" >&2
  exit 1
fi

if ! printf '%s' "$profile_dump" | node -e '
  const fs = require("node:fs")
  const dump = fs.readFileSync(0, "utf8")
  const rows = [
    ["loopx-service", "dsh-loopx-plugin/service"],
    ["loopx-command", "dsh-loopx-plugin/command"],
    ["loopx-tools", "dsh-loopx-plugin/tools"],
    ["loopx-driver", "dsh-loopx-plugin/driver"],
  ]
  let previous = -1
  for (const [id, name] of rows) {
    const position = dump.indexOf(`id: ${id}`)
    if (position < 0) throw new Error(`missing bundle row ${id}`)
    if (position <= previous) throw new Error(`unordered bundle row ${id}`)
    if (!dump.includes(`name: ${name}`)) throw new Error(`missing bundle module ${name}`)
    previous = position
  }
  if (!/id: storage-domain[\s\S]{0,240}backend: json/u.test(dump)) {
    throw new Error("storage-domain backend is not json")
  }
'; then
  echo 'install: DSH profile readback failed; the full profile was not printed or persisted' >&2
  exit 1
fi

echo "install: installed $PACKAGE_NAME@$PACKAGE_VERSION"
echo "install: verified $PROFILE_NAME rows loopx-service -> loopx-command -> loopx-tools -> loopx-driver"
echo "install: artifact retained at $tarball"
