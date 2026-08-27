#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const errors = [];

function read(relativePath)
{
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath))
    {
        errors.push(`missing required file: ${relativePath}`);
        return '';
    }
    return readFileSync(absolutePath, 'utf8');
}

function requireIncludes(relativePath, needles)
{
    const source = read(relativePath);
    for (const needle of needles)
    {
        if (!source.includes(needle))
        {
            errors.push(`${relativePath} missing contract token: ${needle}`);
        }
    }
}

function requireSectionIncludes(relativePath, startToken, endToken, needles)
{
    const source = read(relativePath);
    const start = source.indexOf(startToken);
    if (start < 0)
    {
        errors.push(`${relativePath} missing contract section: ${startToken}`);
        return;
    }
    const end = endToken === null ? source.length : source.indexOf(endToken, start + startToken.length);
    if (end < 0)
    {
        errors.push(`${relativePath} missing contract section boundary: ${endToken}`);
        return;
    }
    const section = source.slice(start, end);
    for (const needle of needles)
    {
        if (!section.includes(needle))
        {
            errors.push(`${relativePath} section ${startToken} missing contract token: ${needle}`);
        }
    }
}

const vitestConfigs = readdirSync(path.join(root, 'src/frontend'))
    .filter((name) => /^vitest(?:\..+)?\.config\.ts$/u.test(name))
    .sort();

read('src/frontend/vitest.shared.mjs');
for (const configName of vitestConfigs)
{
    if (configName === 'vitest.production.config.ts')
    {
        requireIncludes(`src/frontend/${configName}`, [
            "from './vitest.config'",
            "from './vitest.property.config'",
            "from './vitest.model.config'",
            "from './vitest.perf.config'",
            "from './vitest.shared.mjs'",
            "createVitestRuntimeOptions('production')",
            'deps: { optimizer: { ssr: { enabled: true } } }',
            'projects:'
        ]);
    }
    else
    {
        requireIncludes(`src/frontend/${configName}`, [
            "from './vitest.shared.mjs'",
            'createVitestRuntimeOptions('
        ]);
    }
}

const packageJson = JSON.parse(read('src/frontend/package.json') || '{}');
for (const scriptName of [
    'test:unit:fast',
    'test:unit:coverage',
    'coverage:unit-core',
    'coverage:public-renderers',
    'coverage:bootstrap-hydration',
    'coverage:workers',
    'coverage:wasm-bridges',
    'coverage:adapters-binary',
    'coverage:composables-state'
])
{
    const command = String(packageJson.scripts?.[scriptName] ?? '');
    if (!command.includes('check:public-page-manifest-sync'))
    {
        errors.push(`${scriptName} must validate the public page manifest before tests`);
    }
    if (command.includes('generate:public-page-manifest'))
    {
        errors.push(`${scriptName} must not generate tracked public page manifest sources`);
    }
}

for (const relativePath of [
    'tests/frontend/support/fixture-paths.mjs',
    'tools/test/run-once.mjs',
    'tools/test/run-command-manifest.mjs',
    'tools/test-matrix/command-groups.mjs',
    'tests/matrix.yml',
    'tests/backend/xunit.runner.json',
    'tests/backend/Fixtures/postgres-test-collections.json',
    'tools/check-postgres-test-collections.mjs',
    'tools/test/resolve-dotnet-test-processors.mjs',
    'tools/test/lanes/backend-build-governance.sh',
    'tools/test/lanes/backend-unit.sh',
    'tools/test/lanes/frontend-property-model-perf.sh'
])
{
    read(relativePath);
}

requireIncludes('tools/test-fixtures/producers/public-content-producer.mjs', [
    'transaction-fixture',
    'preparePublicContent',
    'buildPublicContentPlan',
    'refusing env discovery'
]);
requireIncludes('tests/frontend/fixtures/prepare-playwright-sessions.mjs', [
    'resolveSessionFixtureDirectory',
    'resolveWorkerTestSession',
    'runWithConcurrency(sessions, sessionPrepConcurrency',
    'FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY',
    'resolveSessionPrepConcurrency',
    'readPostgresPidSnapshot',
    "import { spawn } from 'node:child_process'",
    'process.env.FSUSBLOG_DEBUG_BACKEND_URL',
    'process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME',
    'process.env.FSUSBLOG_REDIS_CONTAINER_NAME',
    'FSUSBLOG_BASE_URL: backendBaseUrl',
    'FSUSBLOG_PG_CONTAINER: pgContainer',
    'FSUSBLOG_REDIS_CONTAINER: redisContainer',
    'FSUSBLOG_USER_USERNAME: `binaryuser-${session}`',
    'FSUSBLOG_ADMIN_USERNAME: `binaryadmin-${session}`',
    'FSUSBLOG_DEVICE_FP: `${session}-playwright`',
    "assertSafeFixtureContainer(redisContainer, 'FSUSBLOG_REDIS_CONTAINER')"
]);
if (read('tests/frontend/fixtures/prepare-playwright-sessions.mjs').includes('spawnSync'))
{
    errors.push('prepare-playwright-sessions.mjs must not serialize isolated session workers with spawnSync');
}
requireIncludes('tests/frontend/support/public-fixtures.mjs', [
    'resolvePublicFixtureFile'
]);
requireIncludes('tests/frontend/checks/resilience/check-runtime-resilience.mjs', [
    'readPublicFixtures'
]);
for (const relativePath of [
    'tests/frontend/support/public-fixtures.mjs',
    'tests/frontend/checks/resilience/check-runtime-resilience.mjs'
])
{
    if (read(relativePath).includes('.playwright-fixtures.aeds'))
    {
        errors.push(`${relativePath} must not fall back to tracked Playwright fixtures`);
    }
}
requireIncludes('tests/frontend/support/playwright/routeAuditFixtures.ts', [
    'readPublicFixtures',
    'requireCurrent: true'
]);
requireIncludes('tests/frontend/support/playwright/testSession.ts', [
    'resolveSessionFixtureFile',
    'resolveWorkerTestSession'
]);
requireIncludes('tests/frontend/support/auth-fixture-projection.mjs', [
    'readPrivateJson',
    'sourceReceiptDigest',
    'resolveAuthFixtureManifest',
    'createSessionAdminStepUpProofToken',
    'createAdminStepUpProofToken'
]);
requireIncludes('src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs', [
    'FSUSBLOG_FIXTURE_ROOT',
    'FSUSBLOG_TEST_NAMESPACE'
]);

requireIncludes('.gitignore', ['/package-lock.json']);
requireIncludes('tools/test/lanes/_suite-support.sh', [
    'RunOnceCommand',
    'EnsureWasmReceiptOnce() {',
    '--value ensure-wasm-receipt-v2)',
    'npm run ensure:wasm',
    'EnsureFrontendFsusUiBaseline() {',
    'frontend test lanes require the canonical local FsusUI baseline',
    'tests/browser-diagnostics/local-fsusui-identity.mjs',
    'RunFrontendFastBuildLane() {\n    EnsureFrontendFsusUiBaseline\n    EnsureWasmReceiptOnce',
    'RunFrontendRuntimeContractsLane() {\n    EnsureFrontendFsusUiBaseline\n    EnsureWasmReceiptOnce',
    'run-command-manifest.mjs',
    'resolve-dotnet-test-processors.mjs',
    '--no-build',
    'RunBackendBuildGovernanceLane',
    'RunBackendUnitLane',
    'RunBackendFastSummaryLane',
    'RunFrontendPropertyModelPerfLane',
    '--value "session-prefix=${FSUSBLOG_TEST_SESSION_PREFIX:-pw}"'
]);
if (read('tools/test/lanes/_suite-support.sh').includes('VerifyWasmReceiptOnce'))
{
    errors.push('frontend lanes must invoke the canonical WASM producer before receipt verification');
}
requireIncludes('tools/test/lanes/_lane-collect-support.sh', [
    'ResolveCollectAdmissionSnapshot "$total"',
    'resolveManifestAdmissionSnapshot',
    'FSUSBLOG_COLLECT_PARENT_CPU_UNITS',
    'FSUSBLOG_COLLECT_PARENT_MEMORY_GIB',
    'FSUSBLOG_PARALLEL_ACTIVE_WORKERS'
]);
const collectSupportSource = read('tools/test/lanes/_lane-collect-support.sh');
for (const retiredSplitResolver of ['ResolveCollectParallelWorkers', 'ResolveCollectChildEnvironment'])
{
    if (collectSupportSource.includes(retiredSplitResolver))
    {
        errors.push(`lane collect support must not split one admission across ${retiredSplitResolver}`);
    }
}
requireIncludes('tools/frontend/build.mjs', [
    'FSUSBLOG_VALIDATE_GENERATED_ONLY',
    "['--check']",
    'FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1',
    'await mkdir(backendWebRoot, { recursive: true })'
]);
const frontendBuildSource = read('tools/frontend/build.mjs');
if (frontendBuildSource.includes('skipping backend wwwroot sync because target is missing'))
{
    errors.push('tools/frontend/build.mjs must create and sync a missing backend wwwroot by default');
}

requireIncludes('tools/contracts/export-openapi.sh', [
    '--update-snapshot',
    'cmp -s "$OUT_FILE" "$SNAPSHOT_FILE"',
    'check-openapi-sync.mjs'
]);
if (read('tools/contracts/export-openapi.sh').includes('fsusblog.openapi.observed.json'))
{
    errors.push('export-openapi.sh must not own the observed-to-generated OpenAPI projection copy');
}
requireIncludes('tools/contracts/check-openapi-sync.mjs', [
    'writeGeneratedOpenApiProjection',
    'writeGeneratedOpenApiProjection(produced.observedOpenApiPath)'
]);
requireIncludes('src/frontend/wasm/build.sh', [
    'WASM_SOURCE_DIR="${WASM_ROOT}"',
    'WASM_POW_SOURCE_DIR="${WASM_ROOT}/pow"',
    '--check-source-paths',
    'RunEmcmake() {',
    '"${EMCMAKE_CMD[@]}" "$@"',
    'EMCC_BIN="$(dirname "${EMCMAKE_CMD[0]}")/emcc"',
    'EMSCRIPTEN_VERSION="$("${EMCC_BIN}" --version',
    'RunEmcmake "${CMAKE_BIN}" --fresh "${WASM_SOURCE_DIR}"',
    'RunEmcmake "${CMAKE_BIN}" --fresh "${WASM_POW_SOURCE_DIR}"',
    'COMMENT_PRIVACY_BUILD_CONTRACT="${REPOSITORY_ROOT}/tools/security/comment-privacy-build-contract.mjs"',
    '"${FSUSBLOG_NODE:-node}" "${COMMENT_PRIVACY_BUILD_CONTRACT}" --print-mode)',
    '"${FSUSBLOG_NODE:-node}" "${COMMENT_PRIVACY_BUILD_CONTRACT}" --print-proving-key)',
    'comment_privacy=%s circuit=fsus.anonymous.comment.v5 layout=6'
]);
const wasmBuildSource = read('src/frontend/wasm/build.sh');
for (const [sourceDirectory, expectedCalls] of [
    ['WASM_SOURCE_DIR', 2],
    ['WASM_POW_SOURCE_DIR', 2]
])
{
    const calls = wasmBuildSource.match(
        new RegExp(`RunEmcmake "\\$\\{CMAKE_BIN\\}" --fresh "\\$\\{${sourceDirectory}\\}"`, 'gu')
    ) ?? [];
    if (calls.length !== expectedCalls)
    {
        errors.push(
            `src/frontend/wasm/build.sh must configure ${sourceDirectory} through RunEmcmake --fresh exactly ${expectedCalls} times`
        );
    }
}
const commentPrivacySourceCheck = spawnSync(
    process.execPath,
    [
        path.join(root, 'tools/security/comment-privacy-build-contract.mjs'),
        '--validate-wasm-source',
        'src/frontend/wasm/build.sh'
    ],
    {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }
);
if (commentPrivacySourceCheck.status !== 0)
{
    errors.push(
        String(commentPrivacySourceCheck.stderr || commentPrivacySourceCheck.stdout).trim()
        || 'src/frontend/wasm/build.sh comment privacy validation failed'
    );
}
requireIncludes('tools/test/bundles/bundle-steps.mjs', [
    "step('cross-stack', 'FSUSBLOG_OPENAPI_BUILD=0 tools/test/lanes/cross-stack-contract.sh static'",
    "step('cross-stack-runtime', 'tools/test/lanes/cross-stack-contract.sh runtime'",
    'for (const resource of record.exclusiveResources ?? [])',
    'const conflictingResource = resources.find((resource) => resourceOwners.has(resource))',
    "holderState: 'admission-wave'",
    'exclusiveResource=${wait.resource}',
    'heldBy=${wait.heldBy}'
]);
const bundleStepSource = read('tools/test/bundles/bundle-steps.mjs');
if (bundleStepSource.includes('record.exclusive) return []'))
{
    errors.push('bundle weighted DAG must not restore global serialization for unrelated exclusive resource names');
}
requireIncludes('tools/test/bundles/bundle-steps.mjs', [
    'blockedByCountedResources',
    'countedResource=${wait.resource}'
]);
const runtimeStepsStart = bundleStepSource.indexOf('export function runtimeSteps()');
const runtimeStepsEnd = bundleStepSource.indexOf('export function performanceSteps()', runtimeStepsStart);
const runtimeStepsSource = bundleStepSource.slice(runtimeStepsStart, runtimeStepsEnd);
for (const forbidden of ['chromiumLane', 'countedResources'])
{
    if (runtimeStepsSource.includes(forbidden))
    {
        errors.push(`default runtime correctness must not declare counted Chromium admission: ${forbidden}`);
    }
}
const runBundleSource = read('tools/test/bundles/run-bundle.mjs');
for (const forbidden of [
    'resolveRuntimeBrowserLanePlan',
    'resolveChromiumLaneCapacity',
    'FSUSBLOG_CHROMIUM_LANE_MAX_SLOTS',
    'createBrowserLaneProxySet',
    'FSUSBLOG_BROWSER_LANE_',
    'fsusblog.runtime-browser-admission.v1',
    'browserAdmission'
])
{
    if (runBundleSource.includes(forbidden))
    {
        errors.push(`default bundle runner must not resolve, wrap, or emit counted Chromium admission: ${forbidden}`);
    }
}
requireIncludes('tests/browser-diagnostics/run.mjs', [
    'resolveDiagnosticResourceState',
    'requestedWorkerLimit: resources.requestedWorkers',
    'workerLimit: resources.effectiveWorkers',
    "status: 'skipped'",
    "status: 'incomplete'",
    'skippedProbeCount: plan.plannedProbeCount',
    'incompleteReason: resources.reason',
    "outerAdmissionMode: 'single-explicit-browser-diagnostics-tier'",
    'maxActiveBrowserLanes: 1',
    'dynamicInnerPool: false',
    'categoriesSerial: true'
]);
const browserDiagnosticsSource = read('tests/browser-diagnostics/run.mjs');
if (/options\.workers\s*!==\s*1[\s\S]{0,120}?throw/u.test(browserDiagnosticsSource))
{
    errors.push('browser diagnostics must emit skipped/incomplete evidence instead of rejecting a reduced worker request before receipt creation');
}
for (const forbidden of ['freemem(', 'loadavg(', 'availableParallelism(', 'FSUSBLOG_CHROMIUM_LANE_MAX_SLOTS'])
{
    if (browserDiagnosticsSource.includes(forbidden))
    {
        errors.push(`browser diagnostics inner runner must keep the fixed outer single-slot admission: ${forbidden}`);
    }
}
requireIncludes('tools/test/run-command-manifest.mjs', [
    'export function resolveNestedManifestMemoryGiBPerWorker',
    'inheritedMemoryGiB / workers',
    'orchestrationMemoryGiBPerWorker: resolveNestedManifestMemoryGiBPerWorker({ env })'
]);
requireIncludes('tools/test/lanes/cross-browser-smoke.sh', [
    'PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$browser_profile"'
]);
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "commandStep('privacy-zk-contract-prebuild',", "commandStep('privacy-zk-contract',", [
    "commandStep('privacy-zk-contract-prebuild', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-prebuild'",
    "dependsOn: ['privacy-zk-canonical-receipts']",
    'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
]);
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "commandStep('privacy-zk-contract',", "staticStageStep('postbuild',", [
    "commandStep('privacy-zk-contract', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-postbuild'",
    "dependsOn: ['frontend-build-ready', 'privacy-zk-contract-prebuild']",
    'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
]);
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "await executeStep(staticStageStep('blocking-prebuild',", 'const step =', [
    "await executeStep(staticStageStep('blocking-prebuild'",
    'resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }'
]);
requireIncludes('tools/test/bundles/run-bundle.mjs', [
    'function bundleDagCapacityForSteps(steps)',
    'const stepExclusiveResources = steps.flatMap((entry) => entry.resources?.exclusiveResources ?? [])',
    '() => bundleDagCapacityForSteps(steps)',
    'dotnet restore tests/FsusBlog.ProductionBackend.slnx --locked-mode'
]);
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "staticStageStep('concurrent',", "commandStep('static-governance-concurrent'", [
    "staticStageStep('concurrent'",
    "exclusiveResources: ['generated-contracts']"
]);
requireSectionIncludes('tools/test/bundles/run-bundle.mjs', "const step = commandStep('vitest-production-projects'", 'const frontendDagResults', [
    "dependsOn: ['frontend-early-test-capacity-ready']",
    'minCpuUnits: resolvedFrontendVitestAdmissionFloor()'
]);
if (read('tools/test/bundles/run-bundle.mjs').includes('FSUSBLOG_VITEST_TARGET_WORKERS'))
{
    errors.push('production frontend bundle must derive Vitest workers from the live admitted step grant');
}
requireSectionIncludes('tools/test/bundles/bundle-steps.mjs', "step('privacy-zk-project-functional'", "step('coverage-merge'", [
    'tools/test/lanes/privacy-zk-comment-matrix.sh project-functional',
    'resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }'
]);
const bundleStepsSource = read('tools/test/bundles/bundle-steps.mjs');
if (bundleStepsSource.includes("step('privacy-zk'"))
{
    errors.push('legacy monolithic privacy-zk step must not return to runtime-browser');
}
requireSectionIncludes('tools/test/bundles/bundle-steps.mjs', 'export function performanceSteps()', null, [
    "const benchmarkResources = { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['benchmark-window'] }",
    "step('privacy-zk-performance-ready'",
    "step('privacy-zk-benchmark'",
    "step('privacy-zk-finalize'"
]);
requireIncludes('tests/frontend/checks/runtime/zero-auth-probe-matrix.mjs', [
    'process.env.FSUSBLOG_DEBUG_FRONTEND_URL',
    "page.locator('a[href=\"/about\"]:visible').first()",
    "waitFor({ state: 'visible', timeout: 0 })"
]);
if (read('tools/test/lanes/rights-v3-test-matrix.sh').includes('generate:public-page-manifest'))
{
    errors.push('rights-v3 test lane must validate, not regenerate, the tracked public page manifest');
}
if (read('.github/workflows/quality-gate.yml').includes('docs --out docs/testing.generated.md'))
{
    errors.push('quality-gate tests must not rewrite tracked docs/testing.generated.md');
}
const fsusUiBaseline = {
    commit: execFileSync(
        process.execPath,
        [path.join(root, 'tools/test/fsusui-baseline.mjs'), '--commit'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    ).trim()
};
const screenshotManifest = JSON.parse(read('docs/assets/screenshots/manifest.json') || '{}');
if (screenshotManifest.fsusUi?.commit !== fsusUiBaseline.commit)
{
    errors.push('FsusUI test baseline must match the current screenshot evidence baseline');
}
for (const [job, nextJob] of [
    ['frontend-build', 'fast-frontend-unit'],
    ['fast-frontend-unit', 'frontend-runtime-contracts'],
    ['frontend-runtime-contracts', 'frontend-static-governance'],
    ['frontend-static-governance', 'fast-static-governance']
])
{
    requireSectionIncludes(
        '.github/workflows/quality-gate.yml',
        `    ${job}:`,
        `    ${nextJob}:`,
        [
            'FSUSBLOG_LOCAL_FSUSUI_ROOT: ${{ github.workspace }}/.tmp/local-fsusui',
            'id: fsusui-baseline',
            'node tools/test/fsusui-baseline.mjs --github-output "$GITHUB_OUTPUT"',
            'repository: Ozwasyd/FsusUI',
            'ref: ${{ steps.fsusui-baseline.outputs.commit }}',
            'corepack pnpm --dir "$FSUSBLOG_LOCAL_FSUSUI_ROOT" install --frozen-lockfile --ignore-scripts',
            'corepack pnpm --dir "$FSUSBLOG_LOCAL_FSUSUI_ROOT" run build:theme'
        ]
    );
}
requireSectionIncludes(
    '.github/workflows/quality-gate.yml',
    '    browser-contract:',
    '    resilience-runtime:',
    [
        'FSUSBLOG_LOCAL_FSUSUI_ROOT: ${{ github.workspace }}/.tmp/local-fsusui',
        'id: fsusui-baseline',
        'node tools/test/fsusui-baseline.mjs --github-output "$GITHUB_OUTPUT"',
        'repository: Ozwasyd/FsusUI',
        'ref: ${{ steps.fsusui-baseline.outputs.commit }}',
        'corepack pnpm --dir "$FSUSBLOG_LOCAL_FSUSUI_ROOT" install --frozen-lockfile --ignore-scripts',
        'corepack pnpm --dir "$FSUSBLOG_LOCAL_FSUSUI_ROOT" run build:theme'
    ]
);
if (read('tools/coverage/collect-frontend-coverage.sh').includes(
    'FSUSBLOG_USE_LOCAL_FSUSUI="${FSUSBLOG_USE_LOCAL_FSUSUI:-0}"'
))
{
    errors.push('frontend coverage must not force a package-only FsusUI source outside the matrix/workflow baseline');
}
requireIncludes('tests/frontend/checks/static/check-local-fsusui-public-shell-motion.mjs', [
    'execFileSync',
    "'scripts', 'fsusui-root.mjs'",
    "'--repository-root', repoRoot"
]);

const suiteSupportSource = read('tools/test/lanes/_suite-support.sh');
const backendTestRuntimeSupportSource = read('tools/test/lanes/_backend-test-runtime-support.sh');
const frontendBuildFingerprintStart = suiteSupportSource.indexOf('RunFrontendFastBuildGroup()');
const frontendBuildFingerprintEnd = suiteSupportSource.indexOf('WriteFrontendSplitSummary()', frontendBuildFingerprintStart);
const frontendBuildFingerprint = suiteSupportSource.slice(frontendBuildFingerprintStart, frontendBuildFingerprintEnd);
for (const token of [
    'for tsconfig in "$CLIENT_DIR"/tsconfig*.json',
    'fingerprintArgs+=(--path "${tsconfig#"$ROOT_DIR/"}")'
])
{
    if (!frontendBuildFingerprint.includes(token))
    {
        errors.push(`frontend fast build fingerprint does not cover existing tsconfig*.json files: ${token}`);
    }
}

// Auth/public fixtures run only through the unique FixtureOrchestrator (#1709).
// Session fixtures remain lane-local with secret-env fingerprinting.
const sessionFingerprintStart = suiteSupportSource.indexOf('PrepareSessionFixturesOnce()');
const sessionFingerprintEnd = suiteSupportSource.indexOf('InvokeLaneFixtureOrchestrator()', sessionFingerprintStart);
const sessionFingerprint = suiteSupportSource.slice(sessionFingerprintStart, sessionFingerprintEnd);
for (const secretName of [
    'Jwt__SecretKey',
    'FSUSBLOG_TEST_SESSION_SECRET',
    'AnonymousCredentialIssuer__SubjectHashPepper'
])
{
    if (!sessionFingerprint.includes(`--secret-env ${secretName}`))
    {
        errors.push(`session fixture fingerprint must hash ${secretName} through --secret-env`);
    }
    if (sessionFingerprint.includes(`--value "\${${secretName}`))
    {
        errors.push(`session fixture fingerprint must not pass raw ${secretName} through argv`);
    }
}
if (!suiteSupportSource.includes('tools/test-fixtures/cli.mjs'))
{
    errors.push('suite support must invoke tools/test-fixtures/cli.mjs as the unique fixture orchestrator');
}
if (/\bPrepareAuthFixturesOnce\s*\(|\bPreparePublicFixturesOnce\s*\(|\bPrepareRuntimeFixturesOnce\s*\(/u.test(suiteSupportSource))
{
    errors.push('suite support must not retain PrepareAuth/Public/RuntimeFixturesOnce dual orchestrators');
}
requireIncludes('tools/test/run-once.mjs', [
    "name === 'secret-env'",
    "createHash('sha256').update(String(env[name] ?? '')).digest('hex')",
    "fsusblog.physical-execution-receipt.v3",
    'runBoundExecution',
    'physicalExecutionReceiptDigest',
    'avoidedChildStartups'
]);
requireIncludes('tools/test/run-deterministic-command.mjs', [
    'FSUSBLOG_TEST_RUN_ID',
    'FSUSBLOG_TEST_SOURCE_COMMIT',
    'FSUSBLOG_TEST_SOURCE_FINGERPRINT',
    'contract.missing-run-identity',
    'qualificationEligible=false',
    'inputDigest',
    'environmentDigest',
    'worktreeFingerprint',
    'runBoundExecution'
]);
requireIncludes('tools/test/run-matrix-governance-once.sh', [
    '--key matrix-governance',
    '--execution-class correctness',
    '--producer-id "$CONSUMER_ID"',
    '--test-id matrix-validate',
    '--test-id matrix-preflight',
    '--test-id matrix-evidence-plan'
]);
requireIncludes('tools/bootstrap-acceptance-env.sh', [
    'tools/frontend',
    'FSUSBLOG_FIXTURE_SERVICE_GENERATION',
    'tools/test-fixtures/cli.mjs',
    'InvokeFixtureOrchestrator',
    'RunFrontendFastBuildGroup',
    'reusing digest-verified frontend release bundle produced by this build-static scheduler run'
]);
requireIncludes('tools/test/lanes/static-governance.sh', [
    'run-matrix-governance-once.sh" static-evidence-plan',
    'run-matrix-governance-once.sh" static-matrix-contract',
    'run-matrix-governance-once.sh" static-matrix-schema'
]);
requireIncludes('tools/run-test-matrix.mjs', [
    "evidencePlan(matrix, '.tmp/release-evidence/test-plan.json')"
]);
requireIncludes('tools/test/lanes/visual-public-playwright.sh', [
    'WriteVisualPlaywrightSkipEvidence public'
]);
requireIncludes('tools/test/lanes/visual-console-playwright.sh', [
    'WriteVisualPlaywrightSkipEvidence console'
]);
const bootstrapSource = read('tools/bootstrap-acceptance-env.sh');
for (const dualPath of [
    'PrepareAuthFixturesOnce',
    'PreparePublicFixturesOnce',
    'PrepareRuntimeFixturesOnce',
    'PrepareFixtures()',
    'npm run prepare:binary-smoke:auth-users',
    'npm run prepare:playwright:fixtures',
    'RunParallel "bootstrap-runtime-fixtures"'
])
{
    if (bootstrapSource.includes(dualPath))
    {
        errors.push(`bootstrap must not retain dual fixture path: ${dualPath}`);
    }
}
if (!bootstrapSource.includes('tools/test-fixtures/cli.mjs'))
{
    errors.push('bootstrap must call the unique fixture orchestrator CLI');
}
requireIncludes('tools/coverage/collect-backend-coverage.sh', [
    'EnsureBackendFilteredBuild',
    'ConfigureDotnetTestProcessors',
    'RunBackendDotnetTest coverage-backend',
    '--filter "$BACKEND_ORDINARY_TEST_FILTER"',
    'ORDINARY_RESULTS_DIR="$RESULTS_DIR/ordinary"',
    'rm -rf "$ORDINARY_RESULTS_DIR" "$SUMMARY_DIR"',
    'EXPECTED_RESULT_LANES=(ordinary special-api-integration special-auth-state-machine special-concurrency special-property special-golden)',
    'find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -print0',
    '--no-build'
]);
const ordinaryBackendFilter = 'Category!=Integration&Category!=ApiIntegration&Category!=Concurrency&Category!=Performance&Category!=Property&Category!=GoldenContract&Category!=SecurityStateMachine';
if (!suiteSupportSource.includes(`BACKEND_ORDINARY_TEST_FILTER="\${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-${ordinaryBackendFilter}}"`))
{
    errors.push('backend ordinary and coverage lanes must share a fail-closed filter that excludes every dedicated special suite');
}
if (!suiteSupportSource.includes('PrepareBackendPlatformPlan backend-unit "$BACKEND_ORDINARY_TEST_FILTER"')
    || !suiteSupportSource.includes('require(\'$(BackendPlatformPlanFile backend-unit)\').executionFilter')
    || !suiteSupportSource.includes('RunBackendDotnetFilterOnly "$platformFilter" backend-unit'))
{
    errors.push('backend ordinary lane must project BACKEND_ORDINARY_TEST_FILTER through the sealed platform plan');
}
for (const binding of [
    'RunBackendDotnetTest()',
    'CleanupBackendTestRuntimeOutput()',
    'BackendTestRuntimeOutputDirectory()',
    'FSUSBLOG_BACKEND_DB_NAMESPACE=',
    '"$outputDirectory/data"',
    '"$outputDirectory/storage"',
    'rm -rf -- "$runtimePath"'
])
{
    if (!backendTestRuntimeSupportSource.includes(binding))
    {
        errors.push(`backend dotnet tests must preserve the canonical build/runtime output boundary: ${binding}`);
    }
}
if (!suiteSupportSource.includes('. "$ROOT_DIR/tools/test/lanes/_backend-test-runtime-support.sh"'))
{
    errors.push('suite support must source the unique backend test runtime owner');
}
const backendTestRuntimeOwners = `${suiteSupportSource}\n${backendTestRuntimeSupportSource}`;
if ((backendTestRuntimeOwners.match(/"\$BUILD_ENV_RUNNER" dotnet test "\$SERVER_TEST_PROJ"/gu) ?? []).length !== 1)
{
    errors.push('backend dotnet tests must have exactly one canonical process owner');
}
if (read('tools/coverage/collect-backend-coverage.sh').includes('dotnet test "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"'))
{
    errors.push('backend coverage must not retain a second direct dotnet test process owner');
}
if (!suiteSupportSource.includes('FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0')
  || !suiteSupportSource.includes('FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server/bin/Debug/net10.0')
  || !suiteSupportSource.includes('outputContract="$debugOutputDir|$debugServerOutputDir"')
  || !suiteSupportSource.includes('outputContract="$releaseOutputDir"'))
{
    errors.push('backend shared build cache must require complete run-bound Debug and Release output directories');
}
for (const [lane, filter] of [
    ['api-integration', 'Category=ApiIntegration'],
    ['auth-state-machine', 'Category=SecurityStateMachine'],
    ['concurrency', 'Category=Concurrency'],
    ['property', 'Category=Property'],
    ['golden', 'Category=GoldenContract']
])
{
    if (!suiteSupportSource.includes(`RunBackendDotnetFilterWithCoverage ${lane} "${filter}"`))
    {
        errors.push(`backend dedicated ${lane} suite must execute exactly once while producing mergeable coverage`);
    }
}
requireIncludes('tests/backend/FsusBlog.Server.Tests.csproj', [
    'xunit.runner.json',
    'CopyToOutputDirectory'
]);

const postgresManifest = read('tests/backend/Fixtures/postgres-test-collections.json');
if (postgresManifest)
{
    try
    {
        const parsed = JSON.parse(postgresManifest);
        const entries = parsed.collections?.flatMap((collection) => collection.tests ?? []) ?? [];
        if (parsed.schema !== 'fsusblog.postgres-test-collections.v1')
        {
            errors.push('postgres test collection manifest schema mismatch');
        }
        if (parsed.collections?.length !== 2)
        {
            errors.push('postgres test collection manifest must declare exactly two collections');
        }
        if (entries.length < 28)
        {
            errors.push(`postgres test collection manifest must retain at least 28 classified classes, got ${entries.length}`);
        }
    }
    catch (error)
    {
        errors.push(`postgres test collection manifest is invalid JSON: ${error.message}`);
    }
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[test-execution-contract] ${error}`);
    }
    process.exit(1);
}

console.log(`[test-execution-contract] ok vitestConfigs=${vitestConfigs.length}`);
