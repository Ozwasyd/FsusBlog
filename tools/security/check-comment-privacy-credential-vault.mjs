#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const REQUIRED_FILES = [
    'src/frontend/src/privacy/commentPrivacyCredentialLifecycle.ts',
    'src/frontend/src/privacy/commentPrivacyCredentialVault.ts',
    'src/frontend/src/privacy/commentPrivacyCredentialProvider.ts',
    'src/frontend/src/privacy/commentPrivacyRuntime.ts',
    'src/frontend/src/privacy/commentPrivacyWorkerClient.ts',
    'src/frontend/src/workers/privacy/commentPrivacy.worker.ts',
    'src/frontend/src/services/authBroadcastRuntime.ts',
    'src/frontend/src/services/serviceWorkerRuntime.ts',
    'src/frontend/public/sw.js',
    'docs/security/comment-privacy-credential-vault.md',
    'security/evidence-contracts/comment-privacy-credential-vault.release-plan.json',
    'src/frontend/package.json',
    'tools/test/lanes/project-privacy-zk-production.mjs',
    'src/frontend/src/views/user/IdentityCenter.vue',
    'src/frontend/src/composables/useCommentModerationActions.ts',
    'src/frontend/src/views/admin/moderation/AnonymousGovernancePage.vue',
    'src/frontend/src/composables/useArticleDetailView.ts',
    'src/frontend/src/security/trustedTypesRuntime.ts',
    'src/frontend/src/privacy/commentPrivacyWasmProver.ts',
    'src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs',
    'ops/gateway/production-openresty.conf',
    'src/frontend/src/components/ui/MarkdownRenderer.vue',
    'src/frontend/vite.config.ts'
];

const REQUIRED_RELEASE_EVIDENCE_IDS = new Set([
    'credential-vault-cross-account-negative',
    'credential-vault-legacy-indexeddb-dump',
    'credential-vault-two-tab-purge',
    'credential-vault-trusted-types-boundary'
]);

export function validateCommentPrivacyCredentialVault(root = DEFAULT_ROOT)
{
    const sources = Object.fromEntries(REQUIRED_FILES.map(file => [
        file,
        readFileSync(path.join(root, file), 'utf8')
    ]));
    const result = validateCommentPrivacyCredentialVaultSources(sources);
    return { ...result, sources };
}

export function validateCommentPrivacyCredentialVaultSources(sources)
{
    const errors = [];
    const checks = [];
    const expectSource = (file, pattern, detail) =>
    {
        if (!pattern.test(sources[file] ?? ''))
        {
            errors.push(`${file}: ${detail}`);
            return;
        }
        checks.push({ id: detail, status: 'ok', file });
    };
    const rejectSource = (file, pattern, detail) =>
    {
        if (pattern.test(sources[file] ?? ''))
        {
            errors.push(`${file}: ${detail}`);
            return;
        }
        checks.push({ id: detail, status: 'ok', file });
    };

    const vaultFile = REQUIRED_FILES[1];
    expectSource(vaultFile, /COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE\s*=\s*'disabled'/, 'credential persistence is explicitly disabled');
    expectSource(vaultFile, /createMemoryOnlyCommentPrivacyCredentialVault[\s\S]*new Map</, 'production vault is memory only');
    expectSource(vaultFile, /deleteLegacyCredentialDatabases/, 'legacy credential database is deleted');
    rejectSource(vaultFile, /indexedDb\.open|createObjectStore|objectStore\s*\(/i, 'runtime must not open or write a credential database');

    const lifecycleFile = REQUIRED_FILES[0];
    for (const reason of [
        'logout', 'account-switch', 'account-deletion', 'credential-revoked',
        'issuer-key-rotation', 'root-retired', 'epoch-changed', 'feature-disabled',
        'panic', 'migration-failure'
    ])
    {
        expectSource(lifecycleFile, new RegExp(`['\"]${reason}['\"]`), `lifecycle includes ${reason}`);
    }
    rejectSource(lifecycleFile, /userId|accountId|sessionId/, 'local generation and broadcast contain no server identity');

    const providerFile = REQUIRED_FILES[2];
    expectSource(providerFile, /metadataBinding\(lastMetadata\)[\s\S]*purgeCommentPrivacyCredentialState[\s\S]*const partition[\s\S]*vault\.get/, 'metadata rotation purges before cache lookup');
    rejectSource(providerFile, /localVaultGeneration/, 'local generation never enters provider network material');

    expectSource(REQUIRED_FILES[3], /zeroizeCredentialMaterial[\s\S]*workerClient\.dispose/, 'runtime zeroizes credentials and terminates worker');
    expectSource(REQUIRED_FILES[5], /finally\s*{\s*zeroizeProofRequest/, 'privacy worker zeroizes transferred proof input');
    expectSource(REQUIRED_FILES[6], /broadcastLogin\(\)[\s\S]*clearPrivateBrowserState\('account-switch'\)[\s\S]*this\.broadcast/, 'login rotates and purges before broadcast');
    expectSource(REQUIRED_FILES[7], /purgeCommentPrivacyCredentialState[\s\S]*deleteLegacyCommentPrivacyCredentialDatabases/, 'browser purge covers memory and legacy IndexedDB');
    expectSource(REQUIRED_FILES[7], /reason === 'panic'[\s\S]*cacheName\.startsWith\('fsus-'\)/, 'panic purge clears every FsusBlog cache');
    expectSource(REQUIRED_FILES[8], /clearPrivateBrowserStateCaches\(message\.reason\)/, 'service worker receives purge reason');

    const releasePlanFile = 'security/evidence-contracts/comment-privacy-credential-vault.release-plan.json';
    const packageFile = 'src/frontend/package.json';
    const projectorFile = 'tools/test/lanes/project-privacy-zk-production.mjs';
    let releasePlan;
    let frontendPackage;
    try
    {
        releasePlan = JSON.parse(sources[releasePlanFile] ?? '');
    }
    catch
    {
        errors.push(`${releasePlanFile}: release plan must be valid JSON`);
    }
    try
    {
        frontendPackage = JSON.parse(sources[packageFile] ?? '');
    }
    catch
    {
        errors.push(`${packageFile}: frontend package must be valid JSON`);
    }
    if (releasePlan)
    {
        if (releasePlan.schema !== 'fsusblog.comment-privacy-credential-vault-release-plan.v1'
        || releasePlan.releaseTier !== 'privacy-zk-comment-matrix'
        || releasePlan.frontendLane !== 'check:privacy-zk-frontend')
        {
            errors.push(`${releasePlanFile}: release plan schema, tier, and frontend lane must stay production-bound`);
        }
        const evidence = Array.isArray(releasePlan.requiredEvidence) ? releasePlan.requiredEvidence : [];
        const ids = new Set(evidence.map(entry => entry?.id));
        if (evidence.length !== REQUIRED_RELEASE_EVIDENCE_IDS.size
        || [...REQUIRED_RELEASE_EVIDENCE_IDS].some(id => !ids.has(id))
        || evidence.some(entry => typeof entry?.file !== 'string' || typeof entry?.testName !== 'string'))
        {
            errors.push(`${releasePlanFile}: release plan must declare the cross-account, fake-IndexedDB dump, two-tab purge, and Trusted Types behavior evidence IDs`);
        }
        else
        {
            checks.push({
                id: 'credential vault behavior evidence is declared in the production privacy release plan',
                status: 'ok',
                file: releasePlanFile
            });
        }
        const frontendLane = frontendPackage?.scripts?.[releasePlan.frontendLane] ?? '';
        if (evidence.some(entry => !frontendLane.includes(`../../${entry.file}`)))
        {
            errors.push(`${packageFile}: production privacy frontend lane must execute every credential vault behavior evidence file`);
        }
        else
        {
            checks.push({
                id: 'production privacy frontend lane executes credential vault behavior evidence',
                status: 'ok',
                file: packageFile
            });
        }
    }
    expectSource(
        projectorFile,
        /requiredFrontendEvidence[\s\S]*selectedAssertions[\s\S]*requires exactly one passing assertion[\s\S]*evidenceDigests/,
        'production projection binds exact behavior test IDs to run-bound passing evidence'
    );
    expectSource(
        'src/frontend/src/views/user/IdentityCenter.vue',
        /deleteCurrentAccount[\s\S]*clearPrivateBrowserState\('account-deletion'\)/,
        'account deletion triggers unified credential cleanup'
    );
    expectSource(
        'src/frontend/src/composables/useCommentModerationActions.ts',
        /revokeAnonymousCredential[\s\S]*clearPrivateBrowserState\('credential-revoked'\)/,
        'credential revocation triggers unified credential cleanup'
    );
    expectSource(
        'src/frontend/src/views/admin/moderation/AnonymousGovernancePage.vue',
        /zkAnonymousEnabled[\s\S]*clearPrivateBrowserState\('feature-disabled'\)[\s\S]*clearPrivateBrowserState\('credential-revoked'\)/,
        'admin feature disable and revocation trigger unified credential cleanup'
    );
    expectSource(
        'src/frontend/src/composables/useArticleDetailView.ts',
        /wasZkAnonymousEnabled[\s\S]*clearPrivateBrowserState\('feature-disabled'\)/,
        'client feature transition triggers unified credential cleanup'
    );

    const trustedTypesFile = 'src/frontend/src/security/trustedTypesRuntime.ts';
    expectSource(
        trustedTypesFile,
        /APP_POLICY_NAME\s*=\s*['"]fsusblog['"][\s\S]*createPolicy\(APP_POLICY_NAME,[\s\S]*createHTML:[\s\S]*createScript:[\s\S]*createScriptURL:/,
        'Trusted Types uses one private fsusblog policy for the audited sink wrappers'
    );
    rejectSource(trustedTypesFile, /createPolicy\(\s*['"](?:default|\*)['"]|allow-duplicates/, 'Trusted Types policy must not use default, wildcard, or duplicate escape hatches');
    expectSource(trustedTypesFile, /COMMENT_PRIVACY_PROVER_MODULE_PATH\s*=\s*['"]\/wasm\/comment-privacy-prover\.js['"][\s\S]*resolved\.origin\s*!==\s*expectedOrigin/, 'prover module URL is exact-path and same-origin only');
    expectSource(trustedTypesFile, /MARKDOWN_RENDERER_WORKER_PATH\s*=\s*\/\^\\\/assets\\\/markdown-renderer\\\.worker-[\s\S]*toTrustedMarkdownWorkerScriptUrl[\s\S]*!MARKDOWN_RENDERER_WORKER_PATH\.test\(resolved\.pathname\)[\s\S]*resolved\.search[\s\S]*resolved\.hash/, 'Markdown worker URL is hashed-asset-path, same-origin, and query-free only');
    expectSource(trustedTypesFile, /APPLICATION_WORKER_PATH\s*=\s*\/\^\\\/assets\\\/[\s\S]*toTrustedApplicationWorkerScriptUrl[\s\S]*APPLICATION_WORKER_PATH\.test\(resolved\.pathname\)[\s\S]*APPLICATION_WORKER_DEV_SOURCE_PATH\.test\(resolved\.pathname\)[\s\S]*resolved\.search[\s\S]*resolved\.hash/, 'application worker URLs are named hashed assets, same-origin, and query-free only');
    expectSource(trustedTypesFile, /SERVICE_WORKER_MODULE_PATH\s*=\s*['"]\/sw\.js['"][\s\S]*toTrustedServiceWorkerScriptUrl[\s\S]*searchParams\.getAll\(['"]build['"]\)[\s\S]*IMMUTABLE_BUILD_ID[\s\S]*MUTABLE_BUILD_IDS/, 'service worker URL is exact-path, same-origin, and immutable-build only');
    expectSource(trustedTypesFile, /toTrustedMarkdownHtml\(safeHtml:\s*MarkdownSafeHtml\)/, 'Markdown TrustedHTML adapter accepts only the FsusUI opaque safe HTML brand');
    rejectSource(trustedTypesFile, /toTrustedMarkdownHtml\([^)]*:\s*string\)/, 'Markdown TrustedHTML adapter must not accept plain strings');
    expectSource('src/frontend/src/components/ui/MarkdownRenderer.vue', /:initial-render="props\.initialRender"[\s\S]*:trusted-html-factory="toTrustedMarkdownHtml"/, 'Markdown renderer passes only an authorized FsusUI initial result and opaque HTML brand');
    expectSource('src/frontend/src/privacy/commentPrivacyWasmProver.ts', /setCommentPrivacyProverScriptUrl\(script,\s*moduleUrl\)/, 'browser prover script URL enters the audited TrustedScriptURL boundary');
    rejectSource('src/frontend/src/privacy/commentPrivacyWasmProver.ts', /script\.src\s*=/, 'privacy prover must not assign a raw string to script.src');
    expectSource('src/frontend/src/components/ui/MarkdownRenderer.vue', /:trusted-script-url-factory="toTrustedMarkdownWorkerScriptUrl"/, 'Markdown renderer worker enters the audited TrustedScriptURL boundary');
    expectSource('src/frontend/src/services/serviceWorkerRuntime.ts', /serviceWorker\.register\(toTrustedServiceWorkerScriptUrl\([\s\S]*scriptUrl/, 'service worker registration enters the audited TrustedScriptURL boundary');
    expectSource('src/frontend/vite.config.ts', /build:\s*\{[\s\S]*?modulePreload:\s*false/, 'Vite runtime modulepreload injection stays disabled under production Trusted Types');
    for (const cspFile of [
        'src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs',
        'ops/gateway/production-openresty.conf'
    ])
    {
        expectSource(cspFile, /require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature;/, 'production CSP enforces exact Vue, app, and fixed SPA entry Trusted Types policies');
        rejectSource(cspFile, /trusted-types\s+(?:\*|default)|allow-duplicates/, 'production CSP must not allow wildcard, default, or duplicate Trusted Types policies');
    }

    const allRuntimeSources = REQUIRED_FILES.slice(0, 9).map(file => sources[file] ?? '').join('\n');
    if (/indexedDB\s*\.\s*open|indexedDb\s*\.\s*open|createObjectStore|\.put\s*\([^)]*credentialSecret/i.test(allRuntimeSources))
    {
        errors.push('production runtime contains an IndexedDB open/put path for credential material');
    }
    else
    {
        checks.push({ id: 'production runtime has no IndexedDB secret write path', status: 'ok' });
    }
    if (/(?:window|globalThis)\s*(?:\.|\[)[^\n=]*(?:commentPrivacy|credentialVault|credentialSecret)[^\n=]*=/i.test(allRuntimeSources))
    {
        errors.push('credential vault or secret must not be exported on window/globalThis');
    }
    else
    {
        checks.push({ id: 'credential state has no window or globalThis export', status: 'ok' });
    }
    if (/WebAuthn PRF|hmac-secret|AES-GCM|AEAD persistence/i.test(allRuntimeSources))
    {
        errors.push('runtime must not claim an unimplemented user-verified persistent vault');
    }
    else
    {
        checks.push({ id: 'persistent wrapping mode is not fabricated', status: 'ok' });
    }

    return { errors, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
{
    const rootArgIndex = process.argv.indexOf('--root');
    const root = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1] ?? '') : DEFAULT_ROOT;
    const { errors } = validateCommentPrivacyCredentialVault(root);
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[comment-privacy-credential-vault] ${error}`);
        }
        process.exit(1);
    }
    console.log('[comment-privacy-credential-vault] ok: memory-only vault and lifecycle purge boundary verified');
}
