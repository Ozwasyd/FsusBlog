import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Run a child process bound to AbortSignal. On abort, SIGTERM then SIGKILL.
 * Strategy/capability are not read from env — only resource handles may be forwarded.
 */
export function runProcess(command, args, {
  cwd = repositoryRoot,
  env = process.env,
  signal = undefined,
  timeoutMs = 600_000
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killTree(child, 'SIGTERM')
        setTimeout(() => killTree(child, 'SIGKILL'), 750).unref?.()
        finish(new Error(`producer process timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`))
      }, timeoutMs)
      : null

    const onAbort = () => {
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 750).unref?.()
      finish(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish(error))
    child.on('close', (code, deathSignal) => {
      if (code === 0) finish(null, { code, stdout, stderr })
      else {
        finish(new Error(
          `producer process failed (code=${code}${deathSignal ? ` signal=${deathSignal}` : ''}): ${command} ${args.join(' ')}\n${stderr || stdout}`
        ))
      }
    })

    function finish(error, result) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
  })
}

function killTree(child, sig) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    try { child.kill(sig) } catch { /* already dead */ }
  }
}

/**
 * Env for producer children: only resource handles + identity, never strategy overrides.
 */
export function buildProducerChildEnv(context, extra = {}) {
  const handles = context.handles ?? {}
  const env = {
    ...process.env,
    ...extra
  }
  // Strip free-profile / strategy smuggling.
  env.FSUSBLOG_FIXTURE_PROFILE = ''
  delete env.FSUSBLOG_FIXTURE_PRODUCER_STRATEGY
  delete env.FSUSBLOG_PUBLIC_FIXTURE_STRATEGY
  delete env.FSUSBLOG_FORCE_DIRECT_DB_SEED

  if (handles.baseUrl) env.FSUSBLOG_BASE_URL = String(handles.baseUrl)
  if (handles.debugBackendUrl) env.FSUSBLOG_DEBUG_BACKEND_URL = String(handles.debugBackendUrl)
  if (handles.frontendUrl) {
    env.PLAYWRIGHT_BASE_URL = String(handles.frontendUrl)
    env.FSUSBLOG_DEBUG_FRONTEND_URL = String(handles.frontendUrl)
  }
  if (handles.pgContainer) env.FSUSBLOG_PG_CONTAINER = String(handles.pgContainer)
  if (handles.redisContainer) {
    env.FSUSBLOG_REDIS_CONTAINER = String(handles.redisContainer)
    env.FSUSBLOG_REDIS_CONTAINER_NAME = String(handles.redisContainer)
  }
  if (handles.pgUser) env.FSUSBLOG_PG_USER = String(handles.pgUser)
  if (handles.pgDb) env.FSUSBLOG_PG_DB = String(handles.pgDb)
  if (context.namespace) env.FSUSBLOG_TEST_NAMESPACE = String(context.namespace)
  if (context.runIdentity) env.FSUSBLOG_TEST_RUN_ID = String(context.runIdentity)
  if (handles.jwt) {
    for (const [key, value] of Object.entries(handles.jwt)) {
      if (value != null && value !== '') env[key] = String(value)
    }
  }
  return env
}
