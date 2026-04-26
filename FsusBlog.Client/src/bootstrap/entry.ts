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

markStartup('entry')
measureStartup('server-spa-preload-to-entry', 'server-spa-preload', 'entry')
measureStartup('server-spa-entry-injected-to-entry', 'server-spa-entry-injected', 'entry')

ensureThemeRuntime()
void registerServiceWorker()

if (isPublicSeoPath(pathname) && hasServerAotShell(root)) {
  void import('@/bootstrap/publicShell').then(({ bootstrapPublicShell }) => bootstrapPublicShell())
} else {
  showGlobalLoader()
  void import('@/bootstrap/fullApp').then(({ bootstrapFullApp }) => bootstrapFullApp())
}
