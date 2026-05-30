import '@/bootstrap/criticalFonts'
import { registerServiceWorker } from '@/services/serviceWorkerRuntime'
import { ensureThemeRuntime } from '@/services/themeRuntime'
import {
  hasServerAotShell,
  isPublicSeoPath,
  showGlobalLoader
} from '@/bootstrap/publicShellPrimitives'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'

const root = document.getElementById('app')
const pathname = window.location.pathname
const bootstrapImportRetryKey = `fsus:bootstrap-import-retry:${pathname}${window.location.search}`

markStartup('entry')
measureStartup('server-spa-preload-to-entry', 'server-spa-preload', 'entry')
measureStartup('server-spa-entry-injected-to-entry', 'server-spa-entry-injected', 'entry')

ensureThemeRuntime()
void registerServiceWorker()

function isRecoverableBootstrapImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Failed to fetch dynamically imported module')
    || message.includes('Importing a module script failed')
    || message.includes('error loading dynamically imported module')
}

function retryBootstrapImportOnce(error: unknown): boolean {
  if (!isRecoverableBootstrapImportError(error)) {
    return false
  }

  try {
    if (sessionStorage.getItem(bootstrapImportRetryKey) === '1') {
      return false
    }
    sessionStorage.setItem(bootstrapImportRetryKey, '1')
  } catch {
    return false
  }

  window.location.reload()
  return true
}

function clearBootstrapImportRetry(): void {
  try {
    sessionStorage.removeItem(bootstrapImportRetryKey)
  } catch {
    // ignore storage access errors during early bootstrap
  }
}

if (isPublicSeoPath(pathname) && hasServerAotShell(root)) {
  void import('@/bootstrap/publicShell')
    .then(({ bootstrapPublicShell }) => bootstrapPublicShell())
    .then(clearBootstrapImportRetry)
    .catch((error: unknown) => {
      if (!retryBootstrapImportOnce(error)) {
        throw error
      }
    })
} else {
  showGlobalLoader()
  void import('@/bootstrap/fullApp')
    .then(({ bootstrapFullApp }) => bootstrapFullApp())
    .then(clearBootstrapImportRetry)
    .catch((error: unknown) => {
      if (!retryBootstrapImportOnce(error)) {
        throw error
      }
    })
}
