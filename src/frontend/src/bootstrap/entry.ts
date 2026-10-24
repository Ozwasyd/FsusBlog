import {
    createBootstrapImportRecovery,
    runBootstrapImport
} from '@/bootstrap/bootstrapImportRecovery';
import {
    consumePublicBootHandoff,
    failClosedPublicBootNavigation,
    type PublicBootIntent
} from '@/bootstrap/publicBootHandoff';
import {
    hasServerAotShell,
    isPublicSeoPath,
    showGlobalLoader
} from '@/bootstrap/publicShellPrimitives';
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler';
import { resolveFrontendBuildIdentity } from '@/config/releaseStorage';
import { installSafeConsoleGuard } from '@/services/safeConsole';
import { registerServiceWorker } from '@/services/serviceWorkerRuntime';

const root = document.getElementById('app');
const pathname = window.location.pathname;
const frontendBuildIdentity = resolveFrontendBuildIdentity(
    import.meta.env.VITE_FSUSBLOG_BUILD_ID,
    import.meta.env.PROD
);
const bootstrapImportRecovery = createBootstrapImportRecovery({
    storage: sessionStorage,
    reload: () => window.location.reload(),
    buildId: frontendBuildIdentity
});

let publicBootIntent: PublicBootIntent | null = null;
const publicBootCarrier = document.getElementById('fsus-public-boot-handoff');
if (publicBootCarrier)
{
    const handoff = consumePublicBootHandoff(frontendBuildIdentity);
    document.getElementById('fsus-public-boot-config')?.remove();
    if (!handoff)
    {
        failClosedPublicBootNavigation(frontendBuildIdentity);
        throw new Error('public_boot_handoff_mismatch');
    }
    publicBootIntent = handoff.intent;
}

installSafeConsoleGuard();
markStartup('entry');
measureStartup('public-boot-preload-to-entry', 'public-boot-preload', 'entry');
measureStartup('public-boot-entry-injected-to-entry', 'public-boot-entry-injected', 'entry');

void registerServiceWorker();

if (isPublicSeoPath(pathname) && hasServerAotShell(root))
{
    void runBootstrapImport(
        () => import('@/bootstrap/publicShell'),
        ({ bootstrapPublicShell }) => bootstrapPublicShell({ bootIntent: publicBootIntent }),
        bootstrapImportRecovery
    );
}
else
{
    showGlobalLoader();
    void runBootstrapImport(
        () => import('@/bootstrap/fullApp'),
        async ({ bootstrapFullApp }) =>
        {
            await bootstrapFullApp();
        },
        bootstrapImportRecovery
    );
}
