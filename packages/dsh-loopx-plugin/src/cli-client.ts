import { execFile as nodeExecFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import type { ChildProcess, ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'
import type { ZodType } from 'zod'
import { failure } from './errors.ts'
import type { LoopXFailure } from './types.ts'

export const DEFAULT_READ_TIMEOUT_MS = 15_000
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000
export const DEFAULT_STDOUT_CAP_BYTES = 1_048_576
export const DEFAULT_STDERR_CAP_BYTES = 262_144

export type LoopXCliOperationKind = 'read' | 'idempotent-write' | 'write'
export type LoopXBinarySource = 'config' | 'environment' | 'path'

export interface LoopXCliClientConfig {
  readonly loopxBin?: string
  readonly readTimeoutMs?: number
  readonly writeTimeoutMs?: number
  readonly stdoutCapBytes?: number
  readonly stderrCapBytes?: number
  /** Explicit child-only environment additions. Parent variables are not inherited. */
  readonly environment?: Readonly<Record<string, string>>
}

export interface LoopXCliRequest<T> {
  readonly operation: string
  readonly kind: LoopXCliOperationKind
  readonly args: readonly string[]
  readonly cwd: string
  readonly schema: ZodType<T>
  readonly signal?: AbortSignal | undefined
  readonly scopeKey?: string | undefined
}

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => ChildProcess

export interface LoopXCliClientInternals {
  readonly execFile?: ExecFileLike
  readonly parentEnv?: NodeJS.ProcessEnv
}

class TimeoutReason extends Error {
  constructor() {
    super('loopx CLI operation timed out')
    this.name = 'LoopXCliTimeout'
  }
}

class ShutdownReason extends Error {
  constructor() {
    super('loopx CLI client is closing')
    this.name = 'LoopXCliShutdown'
  }
}

export class LoopXCliError extends Error {
  readonly failure: LoopXFailure

  constructor(value: LoopXFailure) {
    super(value.message)
    this.name = 'LoopXCliError'
    this.failure = value
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return resolved
}

function resolveBinary(config: LoopXCliClientConfig, env: NodeJS.ProcessEnv): {
  readonly file: string
  readonly source: LoopXBinarySource
} {
  const configured = config.loopxBin?.trim()
  if (configured) return Object.freeze({ file: configured, source: 'config' })
  const fromEnvironment = env.LOOPX_BIN?.trim()
  if (fromEnvironment) return Object.freeze({ file: fromEnvironment, source: 'environment' })
  return Object.freeze({ file: 'loopx', source: 'path' })
}

function childEnvironment(
  parent: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR'] as const) {
    if (parent[key] !== undefined) env[key] = parent[key]
  }
  if (parent.LOOPX_BIN !== undefined) env.LOOPX_BIN = parent.LOOPX_BIN
  for (const [key, value] of Object.entries(explicit ?? {})) env[key] = value
  return env
}

function outcomeUncertain(kind: LoopXCliOperationKind): boolean {
  return kind === 'write'
}

function abortFailure(
  operation: string,
  kind: LoopXCliOperationKind,
  reason: unknown,
): LoopXFailure {
  if (reason instanceof TimeoutReason) {
    return failure('LOOPX_CLI_TIMEOUT', 'LoopX did not finish within the configured timeout.', {
      operation,
      retryable: kind !== 'write',
      outcomeUncertain: outcomeUncertain(kind),
    })
  }
  if (reason instanceof ShutdownReason) {
    return failure('LOOPX_SERVICE_CLOSED', 'The LoopX Host service is shutting down.', {
      operation,
      outcomeUncertain: outcomeUncertain(kind),
    })
  }
  return failure('LOOPX_CLI_ABORTED', 'The LoopX operation was cancelled.', {
    operation,
    retryable: kind !== 'write',
    outcomeUncertain: outcomeUncertain(kind),
  })
}

function schemaFailure(
  operation: string,
  kind: LoopXCliOperationKind,
): LoopXCliError {
  return new LoopXCliError(failure(
    'LOOPX_SCHEMA_UNSUPPORTED',
    'LoopX returned JSON that does not match the supported contract version.',
    {
      operation,
      outcomeUncertain: outcomeUncertain(kind),
    },
  ))
}

/** Safe argv-only process boundary for the locally installed LoopX executable. */
export class LoopXCliClient {
  readonly binarySource: LoopXBinarySource
  private readonly file: string
  private readonly execFile: ExecFileLike
  private readonly env: NodeJS.ProcessEnv
  private readonly readTimeoutMs: number
  private readonly writeTimeoutMs: number
  private readonly stdoutCapBytes: number
  private readonly stderrCapBytes: number
  private readonly controllers = new Set<AbortController>()
  private readonly scopeControllers = new Map<string, Set<AbortController>>()
  private readonly active = new Set<Promise<unknown>>()
  private closed = false

  constructor(config: LoopXCliClientConfig = {}, internals: LoopXCliClientInternals = {}) {
    const parentEnv = internals.parentEnv ?? process.env
    const binary = resolveBinary(config, parentEnv)
    this.file = binary.file
    this.binarySource = binary.source
    this.execFile = internals.execFile ?? nodeExecFile as ExecFileLike
    this.env = childEnvironment(parentEnv, config.environment)
    this.readTimeoutMs = positiveInteger(config.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs')
    this.writeTimeoutMs = positiveInteger(config.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 'writeTimeoutMs')
    this.stdoutCapBytes = positiveInteger(config.stdoutCapBytes, DEFAULT_STDOUT_CAP_BYTES, 'stdoutCapBytes')
    this.stderrCapBytes = positiveInteger(config.stderrCapBytes, DEFAULT_STDERR_CAP_BYTES, 'stderrCapBytes')
  }

  async runJson<T>(request: LoopXCliRequest<T>): Promise<T> {
    if (this.closed) {
      throw new LoopXCliError(failure(
        'LOOPX_SERVICE_CLOSED',
        'The LoopX Host service is not accepting new operations.',
        { operation: request.operation },
      ))
    }
    if (request.operation.trim().length === 0 || request.args.some(arg => arg.includes('\0'))) {
      throw new LoopXCliError(failure(
        'LOOPX_INVALID_REQUEST',
        'The LoopX operation contains an invalid argument.',
        { operation: request.operation },
      ))
    }

    const controller = new AbortController()
    const unlink = this.linkAbort(request.signal, controller)
    this.controllers.add(controller)
    if (request.scopeKey !== undefined) {
      const scoped = this.scopeControllers.get(request.scopeKey) ?? new Set<AbortController>()
      scoped.add(controller)
      this.scopeControllers.set(request.scopeKey, scoped)
    }
    const operation = this.execute(request, controller)
    this.active.add(operation)
    try {
      return await operation
    } finally {
      unlink()
      this.controllers.delete(controller)
      this.active.delete(operation)
      if (request.scopeKey !== undefined) {
        const scoped = this.scopeControllers.get(request.scopeKey)
        scoped?.delete(controller)
        if (scoped?.size === 0) this.scopeControllers.delete(request.scopeKey)
      }
    }
  }

  abortScope(scopeKey: string, reason: Error = new Error('LoopX Session operation invalidated')): void {
    for (const controller of this.scopeControllers.get(scopeKey) ?? []) controller.abort(reason)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.controllers) controller.abort(new ShutdownReason())
    await Promise.allSettled([...this.active])
  }

  private execute<T>(request: LoopXCliRequest<T>, controller: AbortController): Promise<T> {
    const timeoutMs = request.kind === 'read' ? this.readTimeoutMs : this.writeTimeoutMs
    const timer = setTimeout(() => controller.abort(new TimeoutReason()), timeoutMs)
    const maxBuffer = Math.max(this.stdoutCapBytes, this.stderrCapBytes) + 1
    const argv = ['--format', 'json', ...request.args]

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = (operation: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        operation()
      }
      try {
        this.execFile(this.file, argv, {
          cwd: request.cwd,
          env: this.env,
          encoding: 'utf8',
          maxBuffer,
          shell: false,
          signal: controller.signal,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          settle(() => {
            if (controller.signal.aborted) {
              reject(new LoopXCliError(abortFailure(
                request.operation,
                request.kind,
                controller.signal.reason,
              )))
              return
            }
            const stdoutBytes = Buffer.byteLength(stdout)
            const stderrBytes = Buffer.byteLength(stderr)
            const maxBufferFailure = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            if (maxBufferFailure
              || stdoutBytes > this.stdoutCapBytes
              || stderrBytes > this.stderrCapBytes) {
              reject(new LoopXCliError(failure(
                'LOOPX_CLI_OUTPUT_LIMIT',
                'LoopX exceeded the configured output limit.',
                {
                  operation: request.operation,
                  retryable: request.kind !== 'write',
                  outcomeUncertain: outcomeUncertain(request.kind),
                },
              )))
              return
            }

            let decoded: unknown
            try {
              decoded = JSON.parse(stdout) as unknown
            } catch {
              if (error !== null) {
                reject(this.processFailure(request, error))
              } else {
                reject(schemaFailure(request.operation, request.kind))
              }
              return
            }
            const parsed = request.schema.safeParse(decoded)
            if (!parsed.success) {
              reject(schemaFailure(request.operation, request.kind))
              return
            }
            resolve(parsed.data)
          })
        })
      } catch (error) {
        settle(() => reject(this.processFailure(request, error)))
      }
    })
  }

  private processFailure<T>(request: LoopXCliRequest<T>, error: unknown): LoopXCliError {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : ''
    if (code === 'ENOENT') {
      return new LoopXCliError(failure(
        'LOOPX_CLI_NOT_FOUND',
        'The configured LoopX executable could not be found.',
        { operation: request.operation },
      ))
    }
    return new LoopXCliError(failure(
      'LOOPX_CLI_FAILED',
      'LoopX did not return a valid result for this operation.',
      {
        operation: request.operation,
        retryable: request.kind !== 'write',
        outcomeUncertain: outcomeUncertain(request.kind),
      },
    ))
  }

  private linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (signal === undefined) return () => {}
    if (signal.aborted) {
      controller.abort(signal.reason)
      return () => {}
    }
    const abort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  }
}
