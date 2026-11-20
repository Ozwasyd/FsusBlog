import { decodeApiError, decodeFrame } from '../../Contracts/aeds.ts'
import { FrameType } from '../../Contracts/wire.generated.ts'

const StorageKey = 'fsus:debug:aeds'

const frameNames = new Map<number, string>(
  Object.entries(FrameType)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value as number, name]),
)

declare global {
  interface Window {
    __fsusDebug?: {
      aeds: (enabled?: boolean) => boolean
    }
  }
}

function isEnabled(): boolean {
  try {
    return window.localStorage.getItem(StorageKey) === '1'
  } catch {
    return false
  }
}

function isAedsRequest(url: string): boolean {
  try {
    const pathname = new URL(url, window.location.origin).pathname
    return pathname.endsWith('.aeds') || pathname.startsWith('/api/v2/public/search-corpus')
  } catch {
    return false
  }
}

function collectFsusHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-fsus-')) out[key] = value
  })
  return out
}

export function installDevAedsInspector(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined' || window.__fsusDebug) return

  window.__fsusDebug = {
    aeds(enabled?: boolean) {
      if (typeof enabled === 'boolean') {
        try {
          if (enabled) window.localStorage.setItem(StorageKey, '1')
          else window.localStorage.removeItem(StorageKey)
        } catch { /* ignore storage restrictions */ }
      }
      const active = isEnabled()
      console.info(`[FsusBlog AEDS Debug] ${active ? 'enabled' : 'disabled'} (toggle via __fsusDebug.aeds(true|false))`)
      return active
    },
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isEnabled() || !isAedsRequest(rawUrl)) return nativeFetch(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const started = performance.now()
    const response = await nativeFetch(input, init)
    const elapsedMs = Math.round(performance.now() - started)

    try {
      const bytes = new Uint8Array(await response.clone().arrayBuffer())
      const fsusHeaders = collectFsusHeaders(response.headers)
      if (bytes.byteLength >= 16) {
        const frame = decodeFrame(bytes)
        const name = frameNames.get(frame.type) ?? `Unknown(${frame.type})`
        if (frame.type === FrameType.ApiError) {
          const err = decodeApiError(frame.payload, response.status)
          console.warn(
            `[AEDS] ${method} ${rawUrl} -> ${response.status} ${name} (${bytes.byteLength}B, ${elapsedMs}ms)`,
            { code: err.code, message: err.message, details: err.details, traceId: err.traceId, headers: fsusHeaders },
          )
        } else {
          console.debug(
            `[AEDS] ${method} ${rawUrl} -> ${response.status} ${name}(${frame.type}) payload=${frame.payload.byteLength}B total=${bytes.byteLength}B ${elapsedMs}ms`,
            fsusHeaders,
          )
        }
      } else {
        console.debug(`[AEDS] ${method} ${rawUrl} -> ${response.status} (${bytes.byteLength}B, ${elapsedMs}ms)`, fsusHeaders)
      }
    } catch (error) {
      console.debug(`[AEDS] ${method} ${rawUrl} -> ${response.status} (unparsed, ${elapsedMs}ms)`, error)
    }
    return response
  }
}
