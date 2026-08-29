import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { inspectMeasurementNoiseAuthorityManifest, measurementNoiseAuthorityManifestSchema } = await import(new URL("../test/measurement-noise-envelope.mjs", import.meta.url));

export const productionFreshOutputPartitions = Object.freeze([
    'bundles', 'reports', 'coverage', 'release-evidence', 'runtime', 'logs', 'artifacts', 'summary'
]);
export const productionFreshForbiddenOutputRoots = Object.freeze([
    '.tmp/local-production',
    '.tmp/release-evidence',
    '.tmp/test-results',
    '.tmp/coverage',
    '.tmp/perf',
    '.tmp/security',
    '.tmp/frontend',
    '.tmp/scale',
    '.tmp/ux',
    '.tmp/acceptance',
    '.tmp/runtime-scenario-host',
    '.tmp/runtime',
    '.tmp/contracts',
    '.tmp/fault-injection',
    '.tmp/fuzz',
    '.tmp/physical-execution-projections',
    '.tmp/docs',
    '.tmp/test-asset-audit',
    '.tmp/test-governance',
    '.tmp/env',
    '.tmp/fixtures',
    '.tmp/data',
    '.tmp/public-aot-cache-resilience',
    'src/frontend/coverage',
    'src/frontend/test-results',
    'src/frontend/playwright-report',
    'BenchmarkDotNet.Artifacts'
]);
const attemptPattern = /^attempt-(\d{4})$/u;
const measurementAuthorityManifestFilePattern =
    /^(\d{6})-([a-f0-9]{64})\.measurement-noise-manifest\.json$/u;
const terminalAuthorityFilePattern =
    /^(\d{6})-([a-f0-9]{64})\.terminal-authority\.json$/u;
const productionFreshRunAuthoritySchema =
    'fsusblog.production-fresh.run-output-authority.v1';
const productionFreshTerminalAuthoritySchema =
    'fsusblog.production-fresh.terminal-authority.v1';
const runtimeCleanupReceiptPattern =
    /^runtime\/runtime-cleanup-receipts\/(?:preflight|postflight)-[a-f0-9]{32}\.json$/u;
const bootstrapParallelLifecycleOutputPattern =
    /^logs\/acceptance\/[^/]+\/parallel-[A-Za-z0-9_.-]+-\d+-\d+\/(?:wave-\d+-\d+\.env|\d+\.status(?:\.pending-\d+)?)$/u;

export function isProductionFreshRuntimeCleanupOutput(relative)
{
    return relative === 'runtime/runtime-cleanup.json'
    || runtimeCleanupReceiptPattern.test(relative);
}

export function isProductionFreshExpectedLifecycleRemoval(relative)
{
    return bootstrapParallelLifecycleOutputPattern.test(safeRelative(relative));
}

export const productionFreshProducerInventory = Object.freeze({
    schema: 'fsusblog.production-fresh.producer-inventory.v1',
    schedulerProducers: Object.freeze([
        'managed-production-build-gc',
        'logical-tier-projection',
        'production-resource-utilization',
        'production-build-layout',
        'forbidden-output-observation',
        'runtime-cleanup',
        'sensitive-fixture-cleanup',
        'run-summary'
    ]),
    schedulerSuccessOnlyProducers: Object.freeze([
        'logical-tier-projection'
    ]),
    bundles: Object.freeze({
        'build-static': Object.freeze([
            'backend-tests-ready', 'frontend-build', 'validate-matrix', 'public-hydration-fast',
            'perception-redteam', 'risk-control', 'viewport-plan-progress', 'sync-static-assets',
            'production-build-artifacts', 'frontend-runtime-contracts', 'wasm-fuzz'
        ]),
        'backend-tests': Object.freeze([
            'services', 'dotnet-restore', 'backend-server-build', 'backend-tests-build',
            'backend-benchmark-build', 'dotnet-production-union', 'perception-matrix',
            'perception-evidence-finalize', 'backend-coverage-summary'
        ]),
        'frontend-tests': Object.freeze([
            'frontend-static-blocking-prebuild', 'frontend-build-ready',
            'frontend-early-test-capacity-ready',
            'vitest-production-projects', 'vitest-production-perf-isolated',
            'frontend-static-concurrent', 'static-governance-concurrent',
            'privacy-zk-canonical-receipts', 'privacy-zk-contract-prebuild',
            'privacy-zk-contract', 'frontend-static-postbuild', 'vitest-settled',
            'static-governance-post-vitest', 'frontend-coverage-summary',
            'frontend-static-isolated', 'frontend-static-final-ready', 'frontend-static-final',
            'frontend-static-cross-stack-owner', 'frontend-render-structure', 'frontend-tests-join'
        ]),
        'runtime-browser': Object.freeze([
            'backend-build-ready', 'frontend-build-ready', 'production-build-artifacts-ready',
            'security-static', 'bootstrap',
            'release-public-hydration', 'security-runtime-core', 'authenticated-dast',
            'runtime-integration', 'release-public', 'endpoint-depth', 'zap-baseline',
            'cross-stack', 'cross-stack-runtime', 'rights-matrix', 'csrf-matrix',
            'resilience', 'local-runtime-exposure', 'security-join', 'cross-stack-join',
            'runtime-state-stable'
        ]),
        'performance-evidence': Object.freeze([
            'backend-coverage-ready', 'frontend-coverage-ready', 'frontend-build-ready',
            'benchmark-build-ready', 'runtime-state-ready', 'backend-quiet-ready',
            'frontend-quiet-ready', 'build-static-quiet-ready', 'resident-handoff-ready',
            'privacy-zk-project-functional', 'coverage-merge', 'coverage-threshold',
            'privacy-zk-performance-ready', 'data-scale-xs', 'data-scale-s',
            'data-scale-summary', 'fault-injection', 'performance-measurement-ready',
            'backend-perf', 'privacy-zk-benchmark', 'privacy-zk-finalize',
            'mixed-performance-window', 'aeds-frame-cost', 'aeds-compression',
            'performance-summary', 'release-evidence', 'production-summary'
        ])
    })
});

export function assertProductionFreshBundleProducerWiring(
    bundleId,
    executedProducerIds,
    { status = 'success' } = {}
)
{
    const expected = productionFreshProducerInventory.bundles[bundleId];
    if (!expected)
    {
        throw new Error(`Production Fresh physical bundle is absent from producer inventory: ${bundleId}`);
    }
    const executed = [...new Set(executedProducerIds)].sort();
    const missing = status === 'success'
        ? expected.filter((producerId) => !executed.includes(producerId))
        : [];
    const unexpected = executed.filter((producerId) => !expected.includes(producerId));
    if (missing.length > 0 || unexpected.length > 0)
    {
        throw new Error(
            `Production Fresh physical producer wiring mismatch for ${bundleId}:`
      + ` missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
        );
    }
    return true;
}

export function resolveProductionFreshSchedulerProducerIds(
    declarations,
    { status = 'success', producerLifecycles = {} } = {}
)
{
    const expected = productionFreshProducerInventory.schedulerProducers;
    const successOnly = new Set(productionFreshProducerInventory.schedulerSuccessOnlyProducers);
    const required = new Set(status === 'success'
        ? expected
        : expected.filter((producerId) => !successOnly.has(producerId)));
    if (status !== 'success')
    {
        const managedGcLifecycle = producerLifecycles['managed-production-build-gc'];
        const failedBeforeSpawn = managedGcLifecycle?.status === 'failure'
      && managedGcLifecycle.producerSpawnCount === 0;
        const explicitlyBlocked = managedGcLifecycle?.status === 'blocked';
        if (failedBeforeSpawn || explicitlyBlocked)
        {
            required.delete('managed-production-build-gc');
        }
    }
    const actual = Object.keys(declarations).sort();
    const missing = [...required].filter((producerId) => !Array.isArray(declarations[producerId])
    || declarations[producerId].length === 0);
    const unexpected = actual.filter((producerId) => !expected.includes(producerId));
    if (missing.length > 0 || unexpected.length > 0)
    {
        throw new Error(
            'Production Fresh scheduler producer wiring mismatch:'
      + ` missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
        );
    }
    return expected.filter((producerId) => (
        required.has(producerId)
    || (Array.isArray(declarations[producerId]) && declarations[producerId].length > 0)
    ));
}

export function assertProductionFreshSchedulerProducerWiring(declarations, options = {})
{
    resolveProductionFreshSchedulerProducerIds(declarations, options);
    return true;
}

function digest(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function structuredDigest(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function directoryIdentity(directory)
{
    const stat = fs.statSync(directory, { bigint: true });
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: Number(stat.mode & 0o777n),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs)
    };
}

export function beginProductionFreshForbiddenOutputObservation({ repositoryRoot })
{
    const root = path.resolve(repositoryRoot);
    const guards = [];
    try
    {
        for (const relative of productionFreshForbiddenOutputRoots)
        {
            const directory = path.join(root, relative);
            assertContained(root, directory);
            assertNoSymlinkComponents(root, path.dirname(directory), { createDirectories: true });
            if (fs.existsSync(directory))
            {
                throw new Error(`forbidden Production Fresh output root existed before producer spawn: ${relative}`);
            }
            fs.mkdirSync(directory);
            fs.chmodSync(directory, 0o555);
            guards.push({ relative, directory, identity: directoryIdentity(directory) });
        }
    }
    catch (error)
    {
        for (const guard of guards.reverse())
        {
            fs.chmodSync(guard.directory, 0o755);
            fs.rmdirSync(guard.directory);
        }
        throw error;
    }
    return {
        schema: 'fsusblog.production-fresh.forbidden-output-observation.v1',
        repositoryRoot: root,
        startedAt: new Date().toISOString(),
        guards
    };
}

export function finishProductionFreshForbiddenOutputObservation({ observation, layout, receiptFile })
{
    const violations = [];
    try
    {
        for (const guard of observation.guards)
        {
            if (!fs.existsSync(guard.directory))
            {
                violations.push(`${guard.relative}:removed`);
                continue;
            }
            const stat = fs.lstatSync(guard.directory);
            if (stat.isSymbolicLink() || !stat.isDirectory())
            {
                violations.push(`${guard.relative}:replaced`);
                continue;
            }
            const current = directoryIdentity(guard.directory);
            if (JSON.stringify(current) !== JSON.stringify(guard.identity))
            {
                violations.push(`${guard.relative}:metadata-changed`);
            }
            const entries = fs.readdirSync(guard.directory).sort();
            if (entries.length > 0)
            {
                violations.push(`${guard.relative}:entries=${entries.join(',')}`);
            }
        }
        const receipt = {
            schema: observation.schema,
            runId: layout.runId,
            attemptId: layout.attemptId,
            outputRoot: layout.relativeOutputRoot,
            status: violations.length === 0 ? 'complete' : 'failed',
            forbiddenOutputRoots: productionFreshForbiddenOutputRoots,
            violations,
            startedAt: observation.startedAt,
            completedAt: new Date().toISOString()
        };
        const file = outputPath(layout, receiptFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    }
    finally
    {
        for (const guard of observation.guards.reverse())
        {
            if (!fs.existsSync(guard.directory) || fs.lstatSync(guard.directory).isSymbolicLink())
            {
                continue;
            }
            fs.chmodSync(guard.directory, 0o755);
            fs.rmSync(guard.directory, { recursive: true, force: true });
        }
    }
    if (violations.length > 0)
    {
        throw new Error(`Production Fresh wrote or locked forbidden global correctness output: ${violations.join(', ')}`);
    }
    return true;
}

function safeRelative(value)
{
    const normalized = String(value ?? '').replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    {
        throw new Error(`output path must be a safe non-empty relative path: ${value}`);
    }
    return normalized;
}

function assertContained(root, candidate)
{
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`output escapes run root: ${candidate}`);
    }
    return resolved;
}

function assertNoSymlinkComponents(root, candidate, { createDirectories = false } = {})
{
    const contained = assertContained(path.resolve(root), candidate);
    const relative = path.relative(path.resolve(root), contained);
    let current = path.resolve(root);
    const rootStat = fs.lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    {
        throw new Error(`correctness output ancestor must be a real directory: ${current}`);
    }
    for (const segment of relative.split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        let stat;
        try
        {
            stat = fs.lstatSync(current);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
        }
        if (!stat)
        {
            if (!createDirectories)
            {
                continue;
            }
            fs.mkdirSync(current);
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink())
        {
            throw new Error(`symlink is not allowed in a correctness output path: ${path.relative(root, current)}`);
        }
        if (current !== contained && !stat.isDirectory())
        {
            throw new Error(`correctness output ancestor must be a directory: ${path.relative(root, current)}`);
        }
    }
    return contained;
}

function walk(root, directory = root, entries = [])
{
    if (!fs.existsSync(directory))
    {
        return entries;
    }
    for (const name of fs.readdirSync(directory))
    {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink())
        {
            throw new Error(`symlink is not allowed in a correctness output root: ${path.relative(root, file)}`);
        }
        if (stat.isDirectory())
        {
            walk(root, file, entries);
        }
        else if (stat.isFile())
        {
            entries.push(path.relative(root, file).replaceAll(path.sep, '/'));
        }
        else
        {
            throw new Error(`non-regular correctness output is not allowed: ${path.relative(root, file)}`);
        }
    }
    return entries;
}

function nextAttemptId(attemptsRoot)
{
    if (!fs.existsSync(attemptsRoot))
    {
        return 'attempt-0001';
    }
    const indexes = fs.readdirSync(attemptsRoot)
        .map((name) => Number(attemptPattern.exec(name)?.[1]))
        .filter(Number.isInteger);
    return `attempt-${String(Math.max(0, ...indexes) + 1).padStart(4, '0')}`;
}

export function createProductionFreshOutputRoot({ root, runId, resume = false, attemptId = null })
{
    const repositoryRoot = path.resolve(root);
    assertNoSymlinkComponents(repositoryRoot, repositoryRoot);
    const safeRun = safeRelative(runId);
    if (safeRun.includes('/'))
    {
        throw new Error(`runId must be one path segment: ${runId}`);
    }
    const runOutputRoot = path.join(repositoryRoot, '.tmp', 'test-runs', safeRun, 'outputs');
    const canonicalRunsRoot = path.join(repositoryRoot, '.tmp', 'test-runs');
    assertContained(canonicalRunsRoot, runOutputRoot);
    const authorityLayout = { repositoryRoot, runId: safeRun, runOutputRoot };
    initializeProductionFreshRunAuthority(authorityLayout, { resume });
    assertNoSymlinkComponents(repositoryRoot, runOutputRoot, { createDirectories: true });
    for (const partition of productionFreshOutputPartitions)
    {
        assertNoSymlinkComponents(repositoryRoot, path.join(runOutputRoot, partition), { createDirectories: true });
    }
    const attemptsRoot = path.join(runOutputRoot, 'attempts');
    assertNoSymlinkComponents(repositoryRoot, attemptsRoot, { createDirectories: true });
    if (resume)
    {
        verifyTerminalProductionFreshOutputs({
            repositoryRoot,
            runId: safeRun,
            runOutputRoot
        }, { requireProtection: true });
    }
    const selectedAttempt = attemptId ?? (resume ? nextAttemptId(attemptsRoot) : 'attempt-0001');
    if (!attemptPattern.test(selectedAttempt))
    {
        throw new Error(`attemptId must match ${attemptPattern}: ${selectedAttempt}`);
    }
    const outputRoot = path.join(attemptsRoot, selectedAttempt);
    if (fs.existsSync(outputRoot))
    {
        throw new Error(`production Fresh output attempt already exists: ${path.relative(repositoryRoot, outputRoot)}`);
    }
    assertNoSymlinkComponents(repositoryRoot, outputRoot, { createDirectories: true });
    for (const partition of productionFreshOutputPartitions)
    {
        assertNoSymlinkComponents(repositoryRoot, path.join(outputRoot, partition), { createDirectories: true });
    }
    return {
        repositoryRoot,
        runId: safeRun,
        attemptId: selectedAttempt,
        runOutputRoot,
        outputRoot,
        relativeRunOutputRoot: path.relative(repositoryRoot, runOutputRoot).replaceAll(path.sep, '/'),
        relativeOutputRoot: path.relative(repositoryRoot, outputRoot).replaceAll(path.sep, '/')
    };
}

export function resolveProductionFreshOutputAttempt({ root, runId, attemptId = null })
{
    const repositoryRoot = path.resolve(root);
    assertNoSymlinkComponents(repositoryRoot, repositoryRoot);
    const safeRun = safeRelative(runId);
    const runOutputRoot = path.join(repositoryRoot, '.tmp', 'test-runs', safeRun, 'outputs');
    const attemptsRoot = path.join(runOutputRoot, 'attempts');
    const attempts = fs.existsSync(attemptsRoot)
        ? fs.readdirSync(attemptsRoot).filter((name) => attemptPattern.test(name)).sort()
        : [];
    const selectedAttempt = attemptId ?? attempts.at(-1);
    if (!selectedAttempt || !attemptPattern.test(selectedAttempt))
    {
        throw new Error(`production Fresh output attempt is missing for run ${safeRun}`);
    }
    const outputRoot = path.join(attemptsRoot, selectedAttempt);
    assertNoSymlinkComponents(repositoryRoot, outputRoot);
    if (!fs.existsSync(outputRoot) || !fs.lstatSync(outputRoot).isDirectory()
    || fs.lstatSync(outputRoot).isSymbolicLink())
    {
        throw new Error(`production Fresh output attempt is invalid: ${selectedAttempt}`);
    }
    return {
        repositoryRoot,
        runId: safeRun,
        attemptId: selectedAttempt,
        runOutputRoot,
        outputRoot,
        relativeRunOutputRoot: path.relative(repositoryRoot, runOutputRoot).replaceAll(path.sep, '/'),
        relativeOutputRoot: path.relative(repositoryRoot, outputRoot).replaceAll(path.sep, '/')
    };
}

export function outputPath(layout, relativeOutput)
{
    const relative = safeRelative(relativeOutput);
    const file = assertContained(path.resolve(layout.outputRoot), path.join(layout.outputRoot, relative));
    const partition = relative.split('/')[0];
    if (!productionFreshOutputPartitions.includes(partition))
    {
        throw new Error(`output must use a declared partition: ${relative}`);
    }
    assertNoSymlinkComponents(path.resolve(layout.repositoryRoot ?? layout.runOutputRoot), file);
    return file;
}

export function productionFreshRuntimeDataRoot(layout, tierId)
{
    const repositoryRoot = path.resolve(layout.repositoryRoot);
    const runRoot = path.dirname(path.resolve(layout.runOutputRoot));
    const runsRoot = path.join(repositoryRoot, '.tmp', 'test-runs');
    assertContained(runsRoot, runRoot);
    if (!attemptPattern.test(layout.attemptId))
    {
        throw new Error(`Production Fresh runtime data requires a valid attempt: ${layout.attemptId}`);
    }
    const tier = safeRelative(tierId).replaceAll('/', '-');
    return path.join(runRoot, 'runtime-data', layout.attemptId, tier);
}

export function productionFreshOutputEnvironment(layout, tierId)
{
    const root = path.resolve(layout.outputRoot);
    const tier = safeRelative(tierId).replaceAll('/', '-');
    return {
        FSUSBLOG_PRODUCTION_FRESH_RUN_ID: layout.runId,
        FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: root,
        FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: layout.attemptId,
        FSUSBLOG_TEST_RESULTS_ROOT: path.join(root, 'reports'),
        FSUSBLOG_COVERAGE_ROOT: path.join(root, 'coverage'),
        FSUSBLOG_COVERAGE_EVIDENCE_DIR: path.join(root, 'coverage'),
        FSUSBLOG_BACKEND_TRX_DIR: path.join(root, 'reports', 'trx', 'backend'),
        PLAYWRIGHT_OUTPUT_DIR: path.join(root, 'artifacts', 'playwright', tier),
        FSUSBLOG_BENCHMARK_ARTIFACT_ROOT: path.join(root, 'artifacts', 'benchmarkdotnet', tier),
        FSUSBLOG_PERFORMANCE_OUTPUT_ROOT: path.join(root, 'reports', 'performance'),
        FSUSBLOG_PERF_EVIDENCE_DIR: path.join(root, 'reports', 'performance'),
        FSUSBLOG_SECURITY_OUTPUT_ROOT: path.join(root, 'artifacts', 'security'),
        FSUSBLOG_SECURITY_EVIDENCE_DIR: path.join(root, 'artifacts', 'security'),
        FSUSBLOG_ZAP_OUT_DIR: path.join(root, 'artifacts', 'security', 'zap'),
        FSUSBLOG_FRONTEND_OUTPUT_ROOT: path.join(root, 'artifacts', 'frontend'),
        FSUSBLOG_DATA_SCALE_ROOT: path.join(root, 'artifacts', 'data-scale'),
        FSUSBLOG_UX_OUTPUT_ROOT: path.join(root, 'artifacts', 'ux'),
        FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT: path.join(root, 'logs', 'acceptance'),
        FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT: path.join(root, 'runtime', 'scenarios'),
        FSUSBLOG_RUNTIME_OUTPUT_ROOT: path.join(root, 'runtime', 'lane-evidence'),
        FSUSBLOG_CONTRACT_OUTPUT_ROOT: path.join(root, 'artifacts', 'contracts'),
        FSUSBLOG_FAULT_EVIDENCE_DIR: path.join(root, 'artifacts', 'fault-injection'),
        FSUSBLOG_FUZZ_EVIDENCE_DIR: path.join(root, 'artifacts', 'fuzz'),
        FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR: path.join(root, 'artifacts', 'operations'),
        FSUSBLOG_SOAK_EVIDENCE_DIR: path.join(root, 'artifacts', 'soak'),
        FSUSBLOG_DOWNLOADED_ARTIFACTS_ROOT: path.join(root, 'runtime', 'downloaded-artifacts'),
        FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR: path.join(root, 'artifacts', 'governance', 'projections'),
        FSUSBLOG_DOCS_EVIDENCE_DIR: path.join(root, 'artifacts', 'governance', 'docs'),
        FSUSBLOG_TEST_ASSET_AUDIT_DIR: path.join(root, 'artifacts', 'governance', 'test-asset-audit'),
        FSUSBLOG_TEST_GOVERNANCE_DIR: path.join(root, 'artifacts', 'governance', 'test-governance'),
        FSUSBLOG_ACCEPTANCE_ENV_ROOT: path.join(root, 'runtime', 'acceptance-env'),
        FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.join(root, 'runtime', 'acceptance-fixtures'),
        FSUSBLOG_DATA_ROOT: productionFreshRuntimeDataRoot(layout, tier),
        FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: path.join(root, 'artifacts', 'production-build'),
        FSUSBLOG_RELEASE_EVIDENCE_DIR: path.join(root, 'release-evidence'),
        FSUSBLOG_RELEASE_EVIDENCE_SOURCE_DIR: path.join(root, 'release-evidence'),
        FSUSBLOG_RELEASE_EVIDENCE_COLLECTION_DIR: path.join(root, 'release-evidence', tier),
        FSUSBLOG_PUBLIC_HYDRATION_MATRIX_SUMMARY_FILE: path.join(root, 'release-evidence', 'public-hydration-matrix-fast-summary.json'),
        FSUSBLOG_PERCEPTION_V2_OUT: path.join(root, 'artifacts', 'perception-v2', tier),
        FSUSBLOG_GATE_LOG_DIR: path.join(root, 'logs', 'gate'),
        FSUSBLOG_GATE_LOG_SOURCE_DIR: path.join(root, 'logs', 'gate'),
        FSUSBLOG_COLLECT_LIVE_GRANT_EVIDENCE_FILE: path.join(root, 'reports', 'live-grant', `${tier}.json`),
        FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE: path.join(root, 'runtime', 'perception-v2-e2e-runtime.json'),
        FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE: path.join(root, 'artifacts', 'perception-v2-test-matrix.json'),
        FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE: path.join(root, 'release-evidence', 'perception-v2-release-evidence.json')
    };
}

export function assertProductionFreshProducerConfiguration(layout, environment)
{
    const required = [
        'FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT',
        'FSUSBLOG_TEST_RESULTS_ROOT',
        'FSUSBLOG_COVERAGE_ROOT',
        'FSUSBLOG_BACKEND_TRX_DIR',
        'PLAYWRIGHT_OUTPUT_DIR',
        'FSUSBLOG_BENCHMARK_ARTIFACT_ROOT',
        'FSUSBLOG_PERFORMANCE_OUTPUT_ROOT',
        'FSUSBLOG_SECURITY_OUTPUT_ROOT',
        'FSUSBLOG_SECURITY_EVIDENCE_DIR',
        'FSUSBLOG_FRONTEND_OUTPUT_ROOT',
        'FSUSBLOG_DATA_SCALE_ROOT',
        'FSUSBLOG_UX_OUTPUT_ROOT',
        'FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT',
        'FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT',
        'FSUSBLOG_RUNTIME_OUTPUT_ROOT',
        'FSUSBLOG_CONTRACT_OUTPUT_ROOT',
        'FSUSBLOG_FAULT_EVIDENCE_DIR',
        'FSUSBLOG_FUZZ_EVIDENCE_DIR',
        'FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR',
        'FSUSBLOG_SOAK_EVIDENCE_DIR',
        'FSUSBLOG_DOWNLOADED_ARTIFACTS_ROOT',
        'FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR',
        'FSUSBLOG_DOCS_EVIDENCE_DIR',
        'FSUSBLOG_TEST_ASSET_AUDIT_DIR',
        'FSUSBLOG_TEST_GOVERNANCE_DIR',
        'FSUSBLOG_ACCEPTANCE_ENV_ROOT',
        'FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT',
        'FSUSBLOG_RELEASE_EVIDENCE_DIR'
    ];
    const outputRoot = path.resolve(layout.outputRoot);
    const errors = [];
    for (const name of required)
    {
        const value = String(environment?.[name] ?? '').trim();
        if (!value)
        {
            errors.push(`${name}=missing`);
            continue;
        }
        const resolved = path.resolve(value);
        if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`))
        {
            errors.push(`${name}=${value}`);
            continue;
        }
        try
        {
            assertNoSymlinkComponents(path.resolve(layout.repositoryRoot ?? layout.runOutputRoot), resolved);
        }
        catch (error)
        {
            errors.push(`${name}=${error.message}`);
        }
    }
    const runtimeDataRoot = String(environment?.FSUSBLOG_DATA_ROOT ?? '').trim();
    const expectedRuntimeDataRoot = path.join(
        path.dirname(path.resolve(layout.runOutputRoot)),
        'runtime-data',
        layout.attemptId
    );
    if (!runtimeDataRoot)
    {
        errors.push('FSUSBLOG_DATA_ROOT=missing');
    }
    else
    {
        const resolved = path.resolve(runtimeDataRoot);
        if (!resolved.startsWith(`${expectedRuntimeDataRoot}${path.sep}`)
      || resolved === outputRoot
      || resolved.startsWith(`${outputRoot}${path.sep}`))
        {
            errors.push(`FSUSBLOG_DATA_ROOT=${runtimeDataRoot}`);
        }
        else
        {
            try
            {
                assertNoSymlinkComponents(path.resolve(layout.repositoryRoot), resolved);
            }
            catch (error)
            {
                errors.push(`FSUSBLOG_DATA_ROOT=${error.message}`);
            }
        }
    }
    if (errors.length > 0)
    {
        throw new Error(`Production Fresh producer has fixed or escaping correctness output: ${errors.join(', ')}`);
    }
    return true;
}

export function verifyProducerOutputs({ layout, producerId, relativeOutputs })
{
    if (!String(producerId ?? '').trim())
    {
        throw new Error('producerId is required');
    }
    if (!Array.isArray(relativeOutputs) || relativeOutputs.length === 0)
    {
        throw new Error(`${producerId} must declare relativeOutputs`);
    }
    const declared = [...new Set(relativeOutputs.map(safeRelative))].sort();
    if (declared.length !== relativeOutputs.length)
    {
        throw new Error(`${producerId} declares duplicate outputs`);
    }
    const actual = walk(path.resolve(layout.outputRoot)).sort();
    const undeclared = actual.filter((file) => !declared.includes(file));
    const missing = declared.filter((file) => !actual.includes(file));
    if (undeclared.length || missing.length)
    {
        throw new Error(`${producerId} output inventory mismatch: undeclared=${undeclared.join(',') || 'none'} missing=${missing.join(',') || 'none'}`);
    }
    const perOutputDigest = Object.fromEntries(declared.map((relative) => [relative, digest(outputPath(layout, relative))]));
    return {
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId,
        outputRoot: layout.relativeOutputRoot,
        relativeOutputs: declared,
        perOutputDigest,
        outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
    };
}

export function captureProductionFreshOutputInventory(layout)
{
    const root = path.resolve(layout.outputRoot);
    return Object.fromEntries(walk(root).sort().map((relative) => [relative, digest(path.join(root, relative))]));
}

export function verifyProducerOutputDelta({
    layout,
    producerId,
    before = {},
    after = null,
    relativeOutputs,
    allowedConcurrentOutputs = [],
    ownedOutputRoots = [],
    allowedRemovedOutputs = [],
    receiptFile = null
})
{
    const declared = [...new Set(relativeOutputs.map(safeRelative))].sort();
    const concurrent = new Set(allowedConcurrentOutputs.map(safeRelative));
    const ownedRoots = [...new Set(ownedOutputRoots.map(safeRelative))].sort();
    const allowedRemoved = new Set(allowedRemovedOutputs.map(safeRelative));
    const invalidAllowedRemovals = [...allowedRemoved]
        .filter((relative) => !isProductionFreshExpectedLifecycleRemoval(relative));
    if (invalidAllowedRemovals.length > 0)
    {
        throw new Error(
            `${producerId} allows non-lifecycle output removal: ${invalidAllowedRemovals.join(',')}`
        );
    }
    if (ownedRoots.length > 0)
    {
        const outsideOwnedRoots = declared.filter((relative) => !ownedRoots.some(
            (ownedRoot) => relative === ownedRoot || relative.startsWith(`${ownedRoot}/`)
        ));
        if (outsideOwnedRoots.length > 0)
        {
            throw new Error(
                `${producerId} declares outputs outside its owner roots: ${outsideOwnedRoots.join(',')}`
            );
        }
    }
    const settled = after ?? captureProductionFreshOutputInventory(layout);
    const changed = Object.keys(settled)
        .filter((relative) => before[relative] !== settled[relative])
        .sort();
    const removed = Object.keys(before).filter((relative) => !Object.hasOwn(settled, relative)).sort();
    const ownedChanges = ownedRoots.length === 0
        ? changed
        : changed.filter((relative) => ownedRoots.some(
      (ownedRoot) => relative === ownedRoot || relative.startsWith(`${ownedRoot}/`)
    ));
    const ownedRemovals = ownedRoots.length === 0
        ? removed
        : removed.filter((relative) => ownedRoots.some(
      (ownedRoot) => relative === ownedRoot || relative.startsWith(`${ownedRoot}/`)
    ));
    const undeclared = ownedChanges.filter(
        (relative) => !declared.includes(relative) && !concurrent.has(relative)
    );
    const missing = declared.filter((relative) => !changed.includes(relative));
    const unexpectedRemoved = ownedRemovals.filter((relative) => !allowedRemoved.has(relative));
    if (undeclared.length || missing.length || unexpectedRemoved.length)
    {
        throw new Error(
            `${producerId} output delta mismatch: undeclared=${undeclared.join(',') || 'none'}`
      + ` missing=${missing.join(',') || 'none'}`
      + ` removed=${unexpectedRemoved.join(',') || 'none'}`
        );
    }
    const perOutputDigest = Object.fromEntries(declared.map((relative) => [relative, settled[relative]]));
    const receipt = {
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId,
        outputRoot: layout.relativeOutputRoot,
        relativeOutputs: declared,
        perOutputDigest,
        outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
    };
    if (receiptFile)
    {
        const file = outputPath(layout, receiptFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    }
    return receipt;
}

export function verifyProductionFreshReceiptInventory({
    layout,
    receipts,
    governanceOutputs = [],
    requiredReceiptStatus = null
})
{
    if (!Array.isArray(receipts) || receipts.length === 0)
    {
        throw new Error('production Fresh output inventory requires producer receipts');
    }
    const owners = new Map();
    for (const receipt of receipts)
    {
        if (requiredReceiptStatus !== null && receipt?.status !== requiredReceiptStatus)
        {
            throw new Error(
                `producer receipt status is not ${requiredReceiptStatus}: ${
                    receipt?.producerId ?? 'missing'
                } (${receipt?.status ?? 'missing'})`
            );
        }
        if (receipt?.runId !== layout.runId || receipt?.attemptId !== layout.attemptId
      || receipt?.outputRoot !== layout.relativeOutputRoot || !String(receipt?.producerId ?? '').trim()
      || !Array.isArray(receipt.relativeOutputs) || receipt.relativeOutputs.length === 0)
        {
            throw new Error(`producer receipt identity is invalid: ${receipt?.producerId ?? 'missing'}`);
        }
        const expectedDigests = {};
        for (const relative of receipt.relativeOutputs.map(safeRelative))
        {
            if (owners.has(relative))
            {
                throw new Error(`producer output has multiple owners: ${relative} (${owners.get(relative)}, ${receipt.producerId})`);
            }
            const file = outputPath(layout, relative);
            if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
            {
                throw new Error(`producer receipt output is missing or invalid: ${relative}`);
            }
            owners.set(relative, receipt.producerId);
            expectedDigests[relative] = digest(file);
        }
        if (JSON.stringify(expectedDigests) !== JSON.stringify(receipt.perOutputDigest)
      || `sha256:${crypto.createHash('sha256').update(JSON.stringify(expectedDigests)).digest('hex')}`
        !== receipt.outputInventoryDigest)
        {
            throw new Error(`producer receipt digest mismatch: ${receipt.producerId}`);
        }
    }
    const governanceEntries = Array.isArray(governanceOutputs)
        ? governanceOutputs.map((relative) => [safeRelative(relative), 'production-fresh-governance'])
        : Object.entries(governanceOutputs).map(([relative, owner]) => [safeRelative(relative), String(owner ?? '').trim()]);
    if (governanceEntries.some(([, owner]) => !owner))
    {
        throw new Error('governance output owner is required');
    }
    const governance = new Map(governanceEntries);
    for (const [relative, owner] of governance)
    {
        if (owners.has(relative))
        {
            throw new Error(`governance output conflicts with producer owner: ${relative} (${owners.get(relative)}, ${owner})`);
        }
    }
    const actual = walk(path.resolve(layout.outputRoot)).sort();
    const undeclared = actual.filter((relative) => !owners.has(relative) && !governance.has(relative));
    const missingGovernance = [...governance.keys()].filter((relative) => !actual.includes(relative));
    if (undeclared.length || missingGovernance.length)
    {
        throw new Error(
            `production Fresh output inventory mismatch: undeclared=${undeclared.join(',') || 'none'}`
      + ` missingGovernance=${missingGovernance.join(',') || 'none'}`
        );
    }
    const perOutputDigest = Object.fromEntries(actual.map((relative) => [relative, digest(outputPath(layout, relative))]));
    return {
        runId: layout.runId,
        attemptId: layout.attemptId,
        producerId: 'production-fresh-output-inventory',
        outputRoot: layout.relativeOutputRoot,
        relativeOutputs: actual,
        perOutputDigest,
        outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(perOutputDigest)).digest('hex')}`
    };
}

export function productionFreshGovernanceOutputs(layout)
{
    const actual = Object.keys(captureProductionFreshOutputInventory(layout));
    const partialBundles = new Set(actual.flatMap((relative) =>
    {
        const match = /^bundles\/([^/]+)\/summary\.json$/u.exec(relative);
        if (!match)
        {
            return [];
        }
        try
        {
            const summary = JSON.parse(fs.readFileSync(outputPath(layout, relative), 'utf8'));
            return summary?.status === 'partial' ? [match[1]] : [];
        }
        catch
        {
            return [];
        }
    }));
    const rules = [
        [/^artifacts\/producer-receipts\/[^/]+\/[^/]+\.json$/u, 'producer-receipt-registry'],
        [/^bundles\/[^/]+\/member-summaries\/[^/]+\.json$/u, 'bundle-member-receipts'],
        [/^bundles\/[^/]+\/(?:summary|resource-utilization)\.json$/u, 'bundle-finalizer'],
        [/^bundles\/performance-evidence\/deadline-evidence\.json$/u, 'performance-bundle-finalizer'],
        [/^logs\/acceptance\//u, 'runtime-service-log-finalizer'],
        [/^runtime\/acceptance-env\/[^/]+\.env$/u, 'runtime-environment-coordinator'],
        [
            /^runtime\/acceptance-fixtures\/[^/]+\/planned-profile\.json$/u,
            'runtime-environment-coordinator'
        ],
        [
            /^runtime\/acceptance-fixtures\/[^/]+\/execution-envelope-services\.json$/u,
            'runtime-environment-coordinator'
        ],
        [/^bundles\/runtime-browser\/steps\/+[^/]+$/u, 'runtime-schedule-step-runner'],
        [/^reports\/trx\/backend\/production\/discovery\/+[^/]+$/u, 'backend-discovery-runner'],
        [/^artifacts\/security\/sbom\/+[^/]+$/u, 'security-static'],
        [/^artifacts\/security\/supply-chain\/+[^/]+$/u, 'security-static'],
        [/^artifacts\/perception-v2\/+[^/]+$/u, 'build-static'],
        [/^release-evidence\/public-hydration-matrix-fast-summary\.json$/u, 'release-public-hydration'],
        [/^release-evidence\/ux-viewport-summary\.json$/u, 'ux-viewport-runner']
    ];
    return Object.fromEntries(actual.flatMap((relative) =>
    {
        const bundleFinalizer = /^bundles\/([^/]+)\/(?:summary|resource-utilization)\.json$/u.exec(relative);
        if (bundleFinalizer && partialBundles.has(bundleFinalizer[1]))
        {
            return [];
        }
        const rule = rules.find(([pattern]) => pattern.test(relative));
        return rule ? [[relative, rule[1]]] : [];
    }));
}

function protectionFile(layout)
{
    return path.join(layout.runOutputRoot, 'terminal-attempts.json');
}

const terminalAttemptProtectionSchema = 'fsusblog.production-fresh.terminal-attempts.v2';

function runDirectory(layout)
{
    return path.dirname(path.resolve(layout.runOutputRoot));
}

function runAuthorityFile(layout)
{
    return path.join(runDirectory(layout), 'production-fresh-output-authority.json');
}

function terminalAuthorityRoot(layout)
{
    return path.join(runDirectory(layout), 'production-fresh-terminal-authority');
}

function documentWithoutDigest(document)
{
    const candidate = structuredClone(document);
    delete candidate.contentDigest;
    return candidate;
}

function readProductionFreshRunAuthority(layout)
{
    const file = runAuthorityFile(layout);
    if (!fs.existsSync(file))
    {
        throw new Error(`Production Fresh run authority is missing for run ${layout.runId}`);
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`Production Fresh run authority is invalid for run ${layout.runId}`);
    }
    const authority = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expectedRelativeOutputRoot = path.relative(
        path.resolve(layout.repositoryRoot),
        path.resolve(layout.runOutputRoot)
    ).replaceAll(path.sep, '/');
    if (authority?.schema !== productionFreshRunAuthoritySchema
    || authority.runId !== layout.runId
    || authority.relativeRunOutputRoot !== expectedRelativeOutputRoot
    || !String(authority.authorityId ?? '').trim()
    || authority.contentDigest !== structuredDigest(documentWithoutDigest(authority)))
    {
        throw new Error(`Production Fresh run authority changed for run ${layout.runId}`);
    }
    return authority;
}

export function productionFreshSchedulerRunDirectoryPreservation(layout)
{
    const directory = runDirectory(layout);
    const outputRoot = path.resolve(layout.runOutputRoot);
    if (path.dirname(outputRoot) !== directory)
    {
        throw new Error(`Production Fresh run output root is not a direct run entry: ${layout.runId}`);
    }
    readProductionFreshRunAuthority(layout);
    return {
        entries: [
            { name: path.basename(runAuthorityFile(layout)), type: 'file' },
            { name: path.basename(outputRoot), type: 'directory' }
        ]
    };
}

function initializeProductionFreshRunAuthority(layout, { resume })
{
    const directory = runDirectory(layout);
    assertContained(
        path.join(path.resolve(layout.repositoryRoot), '.tmp', 'test-runs'),
        directory
    );
    assertNoSymlinkComponents(path.resolve(layout.repositoryRoot), directory, {
        createDirectories: true
    });
    const file = runAuthorityFile(layout);
    if (fs.existsSync(file))
    {
        const authority = readProductionFreshRunAuthority(layout);
        if (!resume)
        {
            throw new Error(`Production Fresh run output is already initialized: ${layout.runId}`);
        }
        return authority;
    }
    if (resume)
    {
        throw new Error(`Production Fresh resume requires an existing run authority: ${layout.runId}`);
    }
    const authority = {
        schema: productionFreshRunAuthoritySchema,
        runId: layout.runId,
        relativeRunOutputRoot: path.relative(
            path.resolve(layout.repositoryRoot),
            path.resolve(layout.runOutputRoot)
        ).replaceAll(path.sep, '/'),
        authorityId: crypto.randomUUID(),
        contentDigest: null
    };
    authority.contentDigest = structuredDigest(documentWithoutDigest(authority));
    fs.writeFileSync(file, `${JSON.stringify(authority, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o400
    });
    return authority;
}

function readTerminalAuthoritySequence(layout, runAuthority)
{
    const root = terminalAuthorityRoot(layout);
    if (!fs.existsSync(root))
    {
        return [];
    }
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        throw new Error(`Production Fresh terminal authority root is invalid for run ${layout.runId}`);
    }
    let previous = null;
    return fs.readdirSync(root).sort().map((name, index) =>
    {
        const match = terminalAuthorityFilePattern.exec(name);
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        if (!match || !stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error(`Production Fresh terminal authority contains an invalid entry: ${file}`);
        }
        const authority = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (authority?.schema !== productionFreshTerminalAuthoritySchema
      || authority.runId !== layout.runId
      || authority.runAuthorityDigest !== runAuthority.contentDigest
      || authority.sequence !== index + 1
      || Number(match[1]) !== authority.sequence
      || authority.previousAuthorityDigest !== (previous?.contentDigest ?? null)
      || authority.contentDigest !== `sha256:${match[2]}`
      || authority.contentDigest !== structuredDigest(documentWithoutDigest(authority)))
        {
            throw new Error(`Production Fresh terminal authority chain is invalid: ${file}`);
        }
        previous = authority;
        return authority;
    });
}

function verifyTerminalAuthority(layout, protection, {
    protectionExists,
    requireProtection
})
{
    const runAuthority = readProductionFreshRunAuthority(layout);
    const sequence = readTerminalAuthoritySequence(layout, runAuthority);
    if (requireProtection && (!protectionExists || sequence.length === 0))
    {
        throw new Error(`Production Fresh resume requires non-empty terminal authority: ${layout.runId}`);
    }
    if (sequence.length !== protection.attempts.length)
    {
        throw new Error(`Production Fresh terminal authority roster changed: ${layout.runId}`);
    }
    for (const [index, authority] of sequence.entries())
    {
        const attempt = protection.attempts[index];
        if (authority.attemptId !== attempt.attemptId
      || authority.attemptProtectionDigest !== attempt.contentDigest
      || authority.outputInventoryDigest !== attempt.outputInventoryDigest
      || authority.measurementAuthorityAnchorDigest
        !== structuredDigest(attempt.measurementAuthorityAnchors))
        {
            throw new Error(`Production Fresh terminal authority binding changed: ${layout.runId}`);
        }
    }
    if (sequence.length > 0)
    {
        if (!protectionExists
      || sequence.at(-1).terminalProtectionFileDigest !== digest(protectionFile(layout)))
        {
            throw new Error(`Production Fresh terminal protection digest changed: ${layout.runId}`);
        }
    }
    return { runAuthority, sequence };
}

function appendTerminalAuthority(layout, protection, attemptProtection)
{
    const runAuthority = readProductionFreshRunAuthority(layout);
    const previous = readTerminalAuthoritySequence(layout, runAuthority).at(-1) ?? null;
    const sequence = (previous?.sequence ?? 0) + 1;
    const authority = {
        schema: productionFreshTerminalAuthoritySchema,
        runId: layout.runId,
        runAuthorityDigest: runAuthority.contentDigest,
        sequence,
        attemptId: attemptProtection.attemptId,
        attemptProtectionDigest: attemptProtection.contentDigest,
        outputInventoryDigest: attemptProtection.outputInventoryDigest,
        measurementAuthorityAnchorDigest: structuredDigest(
            attemptProtection.measurementAuthorityAnchors
        ),
        terminalProtectionFileDigest: digest(protectionFile(layout)),
        previousAuthorityDigest: previous?.contentDigest ?? null,
        contentDigest: null
    };
    authority.contentDigest = structuredDigest(documentWithoutDigest(authority));
    const root = terminalAuthorityRoot(layout);
    assertNoSymlinkComponents(path.resolve(layout.repositoryRoot), root, {
        createDirectories: true
    });
    const file = path.join(
        root,
        `${String(sequence).padStart(6, '0')}-`
      + `${authority.contentDigest.slice('sha256:'.length)}.terminal-authority.json`
    );
    fs.writeFileSync(file, `${JSON.stringify(authority, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o400
    });
    if (protection.attempts.length !== sequence)
    {
        throw new Error(`Production Fresh terminal authority append is out of sequence: ${layout.runId}`);
    }
}

function attemptDirectories(layout)
{
    const attemptsRoot = path.join(layout.runOutputRoot, 'attempts');
    if (!fs.existsSync(attemptsRoot))
    {
        return [];
    }
    const stat = fs.lstatSync(attemptsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink())
    {
        throw new Error(`Production Fresh attempts root is invalid for run ${layout.runId}`);
    }
    return fs.readdirSync(attemptsRoot).sort().map((attemptId) =>
    {
        const directory = path.join(attemptsRoot, attemptId);
        const entry = fs.lstatSync(directory);
        if (!attemptPattern.test(attemptId) || !entry.isDirectory() || entry.isSymbolicLink())
        {
            throw new Error(`Production Fresh attempts root contains an invalid entry: ${attemptId}`);
        }
        return attemptId;
    });
}

function manifestWithoutDigest(manifest)
{
    const candidate = structuredClone(manifest);
    delete candidate.contentDigest;
    return candidate;
}

function manifestAuthorityRoots(layout, manifest)
{
    if (!Array.isArray(manifest.authorityRoots))
    {
        throw new Error('measurement authority manifest root roster is invalid');
    }
    return manifest.authorityRoots.map((rootRoster) =>
    {
        const authorityRoot = path.resolve(String(rootRoster?.authorityRoot ?? ''));
        assertContained(path.resolve(layout.runOutputRoot), authorityRoot);
        const relativeAuthorityRoot = path.relative(
            path.resolve(layout.runOutputRoot),
            authorityRoot
        ).replaceAll(path.sep, '/');
        if (!/^attempts\/attempt-\d{4}\//u.test(relativeAuthorityRoot)
      || !Array.isArray(rootRoster.receipts)
      || rootRoster.authorityRootDigest !== structuredDigest({
          authorityRoot,
          receipts: rootRoster.receipts
      }))
        {
            throw new Error(`measurement authority manifest root roster is invalid: ${authorityRoot}`);
        }
        const stat = fs.existsSync(authorityRoot) ? fs.lstatSync(authorityRoot) : null;
        if (!stat?.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`measurement authority root is missing or invalid: ${authorityRoot}`);
        }
        const receipts = rootRoster.receipts.map((receipt) =>
        {
            const authorityFile = safeRelative(receipt?.authorityFile);
            const file = assertContained(authorityRoot, path.join(authorityRoot, authorityFile));
            const entry = fs.existsSync(file) ? fs.lstatSync(file) : null;
            if (!entry?.isFile() || entry.isSymbolicLink())
            {
                throw new Error(`measurement authority receipt is missing or invalid: ${file}`);
            }
            const document = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (document?.authority?.contentDigest !== receipt.receiptDigest)
            {
                throw new Error(`measurement authority receipt digest changed: ${file}`);
            }
            return {
                authorityFile,
                attemptSequence: receipt.attemptSequence,
                eventSequence: receipt.eventSequence,
                receiptDigest: receipt.receiptDigest
            };
        });
        const actual = walk(authorityRoot).sort();
        const expected = receipts.map(({ authorityFile }) => authorityFile).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
        {
            throw new Error(`measurement authority root roster changed: ${authorityRoot}`);
        }
        return {
            relativeAuthorityRoot,
            authorityRootDigest: rootRoster.authorityRootDigest,
            receipts
        };
    });
}

function measurementManifestSequence(layout, windowDirectory)
{
    const files = fs.readdirSync(windowDirectory).sort();
    if (files.length === 0)
    {
        throw new Error(`measurement authority manifest window is empty: ${windowDirectory}`);
    }
    let previous = null;
    return files.map((name, index) =>
    {
        const match = measurementAuthorityManifestFilePattern.exec(name);
        const file = path.join(windowDirectory, name);
        const stat = fs.lstatSync(file);
        if (!match || !stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error(`measurement authority manifest contains an invalid entry: ${file}`);
        }
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        const expectedContentDigest = `sha256:${match[2]}`;
        if (manifest?.schema !== measurementNoiseAuthorityManifestSchema
      || manifest.runId !== layout.runId
      || !String(manifest.windowId ?? '').trim()
      || manifest.manifestSequence !== index + 1
      || Number(match[1]) !== manifest.manifestSequence
      || manifest.previousManifestDigest !== (previous?.contentDigest ?? null)
      || manifest.contentDigest !== expectedContentDigest
      || manifest.contentDigest !== structuredDigest(manifestWithoutDigest(manifest)))
        {
            throw new Error(`measurement authority manifest chain is invalid: ${file}`);
        }
        previous = manifest;
        return { file, manifest };
    });
}

function captureMeasurementAuthorityAnchors(layout)
{
    const root = path.join(
        layout.runOutputRoot,
        'runtime',
        'measurement-noise-authority-manifests'
    );
    if (!fs.existsSync(root))
    {
        return [];
    }
    assertNoSymlinkComponents(path.resolve(layout.runOutputRoot), root);
    const anchors = [];
    for (const bundleId of fs.readdirSync(root).sort())
    {
        safeRelative(bundleId);
        const bundleDirectory = path.join(root, bundleId);
        const bundleStat = fs.lstatSync(bundleDirectory);
        if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink())
        {
            throw new Error(`measurement authority manifest bundle is invalid: ${bundleDirectory}`);
        }
        for (const stepId of fs.readdirSync(bundleDirectory).sort())
        {
            safeRelative(stepId);
            const stepDirectory = path.join(bundleDirectory, stepId);
            const stepStat = fs.lstatSync(stepDirectory);
            if (!stepStat.isDirectory() || stepStat.isSymbolicLink())
            {
                throw new Error(`measurement authority manifest step is invalid: ${stepDirectory}`);
            }
            for (const windowDirectoryName of fs.readdirSync(stepDirectory).sort())
            {
                const windowDirectory = path.join(stepDirectory, windowDirectoryName);
                const windowStat = fs.lstatSync(windowDirectory);
                if (!/^[a-f0-9]{64}$/u.test(windowDirectoryName)
          || !windowStat.isDirectory()
          || windowStat.isSymbolicLink())
                {
                    throw new Error(`measurement authority manifest window is invalid: ${windowDirectory}`);
                }
                const sequence = measurementManifestSequence(layout, windowDirectory);
                const { file, manifest } = sequence.at(-1);
                const inspected = inspectMeasurementNoiseAuthorityManifest({
                    authorityManifestRoot: stepDirectory,
                    runId: layout.runId,
                    windowId: manifest.windowId
                });
                if (inspected.head?.contentDigest !== manifest.contentDigest)
                {
                    throw new Error(`measurement authority manifest head changed: ${file}`);
                }
                const expectedWindowDirectory = structuredDigest({
                    runId: manifest.runId,
                    windowId: manifest.windowId
                }).slice('sha256:'.length);
                if (windowDirectoryName !== expectedWindowDirectory)
                {
                    throw new Error(`measurement authority manifest window identity changed: ${windowDirectory}`);
                }
                anchors.push({
                    bundleId,
                    stepId,
                    windowId: manifest.windowId,
                    manifestSequence: manifest.manifestSequence,
                    manifestContentDigest: manifest.contentDigest,
                    relativeManifestFile: path.relative(
                        layout.runOutputRoot,
                        file
                    ).replaceAll(path.sep, '/'),
                    manifestFileDigest: digest(file),
                    authorityRoots: manifestAuthorityRoots(layout, manifest)
                });
            }
        }
    }
    return anchors;
}

function verifyMeasurementAuthorityAnchors(layout, anchors)
{
    if (!Array.isArray(anchors))
    {
        throw new Error('terminal measurement authority anchors are invalid');
    }
    for (const anchor of anchors)
    {
        const relativeManifestFile = safeRelative(anchor?.relativeManifestFile);
        const file = assertContained(
            path.resolve(layout.runOutputRoot),
            path.join(layout.runOutputRoot, relativeManifestFile)
        );
        const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
        if (!stat?.isFile() || stat.isSymbolicLink() || digest(file) !== anchor.manifestFileDigest)
        {
            throw new Error(`terminal measurement authority manifest changed: ${relativeManifestFile}`);
        }
        const bundleId = safeRelative(anchor?.bundleId);
        const stepId = safeRelative(anchor?.stepId);
        const expectedPrefix = [
            'runtime',
            'measurement-noise-authority-manifests',
            bundleId,
            stepId
        ].join('/');
        if (!relativeManifestFile.startsWith(`${expectedPrefix}/`))
        {
            throw new Error(`terminal measurement authority manifest path changed: ${relativeManifestFile}`);
        }
        const windowDirectory = path.dirname(file);
        const sequence = measurementManifestSequence(layout, windowDirectory);
        const inspected = inspectMeasurementNoiseAuthorityManifest({
            authorityManifestRoot: path.dirname(windowDirectory),
            runId: layout.runId,
            windowId: anchor.windowId
        });
        if (!inspected.head)
        {
            throw new Error(`terminal measurement authority manifest chain is missing: ${relativeManifestFile}`);
        }
        const anchored = sequence.find(({ manifest }) =>
            manifest.manifestSequence === anchor.manifestSequence
      && manifest.contentDigest === anchor.manifestContentDigest);
        if (!anchored || path.resolve(anchored.file) !== file)
        {
            throw new Error(`terminal measurement authority manifest head is missing: ${relativeManifestFile}`);
        }
        const expectedRoots = manifestAuthorityRoots(layout, anchored.manifest);
        if (JSON.stringify(expectedRoots) !== JSON.stringify(anchor.authorityRoots)
      || anchored.manifest.windowId !== anchor.windowId)
        {
            throw new Error(`terminal measurement authority anchor changed: ${relativeManifestFile}`);
        }
    }
}

function readProtection(layout)
{
    const file = protectionFile(layout);
    if (!fs.existsSync(file))
    {
        return {
            protectionExists: false,
            document: {
                schema: terminalAttemptProtectionSchema,
                runId: layout.runId,
                attempts: []
            }
        };
    }
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (document.schema !== terminalAttemptProtectionSchema
    || document.runId !== layout.runId
    || !Array.isArray(document.attempts)
    || document.attempts.some((attempt) =>
        !attemptPattern.test(String(attempt?.attemptId ?? ''))
      || typeof attempt?.relativeOutputRoot !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt?.outputInventoryDigest ?? ''))
      || !Array.isArray(attempt?.measurementAuthorityAnchors)
      || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt?.contentDigest ?? ''))))
    {
        throw new Error(`terminal attempt protection is invalid for run ${layout.runId}`);
    }
    let previous = null;
    for (const attempt of document.attempts)
    {
        const candidate = structuredClone(attempt);
        delete candidate.contentDigest;
        if (attempt.previousAttemptDigest !== (previous?.contentDigest ?? null)
      || attempt.contentDigest !== structuredDigest(candidate))
        {
            throw new Error(`terminal attempt protection chain is invalid for run ${layout.runId}`);
        }
        previous = attempt;
    }
    return { protectionExists: true, document };
}

export function verifyTerminalProductionFreshOutputs(layout, {
    allowCurrentAttempt = false,
    requireProtection = false
} = {})
{
    const { protectionExists, document } = readProtection(layout);
    verifyTerminalAuthority(layout, document, { protectionExists, requireProtection });
    const protectedAttemptIds = document.attempts.map(({ attemptId }) => attemptId);
    const expectedAttemptIds = [...protectedAttemptIds];
    if (allowCurrentAttempt
    && layout.attemptId
    && !protectedAttemptIds.includes(layout.attemptId))
    {
        expectedAttemptIds.push(layout.attemptId);
    }
    if (new Set(protectedAttemptIds).size !== protectedAttemptIds.length
    || JSON.stringify(attemptDirectories(layout)) !== JSON.stringify(expectedAttemptIds))
    {
        throw new Error(`terminal Production Fresh attempt roster changed: ${layout.runId}`);
    }
    for (const attempt of document.attempts)
    {
        const protectedLayout = resolveProductionFreshOutputAttempt({
            root: layout.repositoryRoot,
            runId: layout.runId,
            attemptId: attempt.attemptId
        });
        const current = captureProductionFreshOutputInventory(protectedLayout);
        const currentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex')}`;
        if (protectedLayout.relativeOutputRoot !== attempt.relativeOutputRoot
      || currentDigest !== attempt.outputInventoryDigest)
        {
            throw new Error(`terminal Production Fresh attempt changed: ${layout.runId}/${attempt.attemptId}`);
        }
        verifyMeasurementAuthorityAnchors(layout, attempt.measurementAuthorityAnchors);
    }
    return document;
}

export function mutateProductionFreshOutput({ layout, target, operation, destination = null, contents = '', mode = 0o644 })
{
    verifyTerminalProductionFreshOutputs(layout, { allowCurrentAttempt: true });
    const resolvedTarget = path.resolve(target);
    const ownRoot = path.resolve(layout.outputRoot);
    assertContained(ownRoot, resolvedTarget);
    assertNoSymlinkComponents(layout.repositoryRoot, resolvedTarget);
    if (destination)
    {
        const resolvedDestination = path.resolve(destination);
        assertContained(ownRoot, resolvedDestination);
        assertNoSymlinkComponents(layout.repositoryRoot, resolvedDestination);
    }
    if (operation === 'delete')
    {
        fs.rmSync(resolvedTarget, { recursive: true, force: true });
    }
    else if (operation === 'overwrite')
    {
        fs.writeFileSync(resolvedTarget, contents);
    }
    else if (operation === 'rename')
    {
        fs.renameSync(resolvedTarget, path.resolve(destination));
    }
    else if (operation === 'chmod')
    {
        fs.chmodSync(resolvedTarget, mode);
    }
    else
    {
        throw new Error(`unsupported Production Fresh output mutation: ${operation}`);
    }
}

export function sealTerminalProductionFreshOutputs(layout)
{
    const root = path.resolve(layout.outputRoot);
    const protection = verifyTerminalProductionFreshOutputs(layout, { allowCurrentAttempt: true });
    if (protection.attempts.some((attempt) => attempt.attemptId === layout.attemptId))
    {
        throw new Error(`production Fresh output attempt is already terminal: ${layout.attemptId}`);
    }
    const inventory = captureProductionFreshOutputInventory(layout);
    const attemptProtection = {
        attemptId: layout.attemptId,
        relativeOutputRoot: layout.relativeOutputRoot,
        outputInventoryDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`,
        measurementAuthorityAnchors: captureMeasurementAuthorityAnchors(layout),
        previousAttemptDigest: protection.attempts.at(-1)?.contentDigest ?? null,
        contentDigest: null
    };
    attemptProtection.contentDigest = structuredDigest(
        Object.fromEntries(Object.entries(attemptProtection).filter(([key]) => key !== 'contentDigest'))
    );
    protection.attempts.push(attemptProtection);
    const file = protectionFile(layout);
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(protection, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o444);
    appendTerminalAuthority(layout, protection, attemptProtection);
    for (const file of walk(root).map((relative) => path.join(root, relative)))
    {
        fs.chmodSync(file, 0o444);
    }
    const directories = [root];
    const visit = (directory) =>
    {
        for (const name of fs.readdirSync(directory))
        {
            const child = path.join(directory, name);
            if (fs.lstatSync(child).isDirectory())
            {
                directories.push(child);
                visit(child);
            }
        }
    };
    visit(root);
    for (const directory of directories.reverse())
    {
        fs.chmodSync(directory, 0o555);
    }
}

export async function finalizeProductionFreshAttempt(layout, operation)
{
    try
    {
        return await operation();
    }
    finally
    {
        sealTerminalProductionFreshOutputs(layout);
    }
}
