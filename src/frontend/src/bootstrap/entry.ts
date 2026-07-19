import '@/bootstrap/criticalFonts'
import { registerServiceWorker } from '@/services/serviceWorkerRuntime'
import { installSafeConsoleGuard } from '@/services/safeConsole'
import {
  hasServerAotShell,
  isPublicSeoPath,
  showGlobalLoader
} from '@/bootstrap/publicShellPrimitives'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import {
  createBootstrapImportRecovery,
  runBootstrapImport
} from '@/bootstrap/bootstrapImportRecovery'

const root = document.getElementById('app')
const pathname = window.location.pathname
const bootstrapImportRecovery = createBootstrapImportRecovery({
  storage: sessionStorage,
  reload: () => window.location.reload(),
  buildId: import.meta.env.VITE_FSUSBLOG_BUILD_ID ?? 'unversioned'
})

installSafeConsoleGuard()
markStartup('entry')
measureStartup('server-spa-preload-to-entry', 'server-spa-preload', 'entry')
measureStartup('server-spa-entry-injected-to-entry', 'server-spa-entry-injected', 'entry')

void registerServiceWorker()

if (isPublicSeoPath(pathname) && hasServerAotShell(root)) {
  void runBootstrapImport(
    () => import('@/bootstrap/publicShell'),
    ({ bootstrapPublicShell }) => bootstrapPublicShell(),
    bootstrapImportRecovery
  )
} else {
  showGlobalLoader()
  void runBootstrapImport(
    () => import('@/bootstrap/fullApp'),
    ({ bootstrapFullApp }) => bootstrapFullApp(),
    bootstrapImportRecovery
  )
}
