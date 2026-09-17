import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '..', '..');
const entry = readFileSync(resolve(repoRoot, 'src/frontend/src/bootstrap/entry.ts'), 'utf8');
const recovery = readFileSync(resolve(repoRoot, 'src/frontend/src/bootstrap/bootstrapImportRecovery.ts'), 'utf8');

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(`[bootstrap-import-retry-privacy] ${message}`);
    }
}

assert(
    recovery.includes("BOOTSTRAP_IMPORT_RETRY_KEY = 'fsus:bootstrap-import-retry'"),
    'retry state must use one fixed key'
);
assert(!recovery.includes('window.location'), 'retry state must not read browser route data');
assert(!entry.includes('window.location.search'), 'entry must not feed query data into bootstrap retry state');
assert(!entry.includes('window.location.hash'), 'entry must not feed hash data into bootstrap retry state');
assert(
    !/(?:bootstrap|import|retry)[A-Za-z]*Key\s*=\s*`[^`]*\$\{[^}]*(?:location\.(?:pathname|search|hash)|pathname)/iu.test(entry),
    'bootstrap retry keys must not interpolate pathname, query, or hash'
);
assert(
    entry.match(/runBootstrapImport\(/gu)?.length === 2,
    'Public AOT and Full SPA must share the same import recovery runner'
);
assert(entry.includes('VITE_FSUSBLOG_BUILD_ID'), 'retry state must be invalidated by build version changes');
assert(recovery.includes('BOOTSTRAP_IMPORT_RETRY_TTL_MS'), 'retry state must have a bounded expiry');

console.log('[bootstrap-import-retry-privacy] fixed route-free retry state OK');
