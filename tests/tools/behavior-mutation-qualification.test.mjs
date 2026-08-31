import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadCatalog, root } from '../../tools/contracts/behavior-contract-catalog.mjs';
import { scanBehaviorTestBindings } from '../../tools/contracts/behavior-test-binding.mjs';
import { scanBehaviorMutationGovernance } from '../../tools/governance/check-behavior-mutation-governance.mjs';
import {
    attachExpectedTestEvidence,
    attributeMutantsToBehaviors,
    expectedAttributionMutantIdsByBehavior,
    qualifyBehaviorMutations
} from '../../tools/test/changed-critical-mutation-attribution.mjs';
import { createChangedCriticalMutationAuthority } from '../../tools/test/changed-critical-mutation-evidence.mjs';
import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation,
    selectRequiredBehaviorMutations,
    validateToolPolicy
} from '../../tools/test/changed-critical-mutation.mjs';
import { digestValue as receiptDigestValue, sealMutationEvidenceReceipt } from '../../tools/test/mutation-evidence-receipt.mjs';
import {
    deriveBehaviorMutationOwners,
    loadBehaviorMutationOwnerCatalog,
    loadFactExtractorRegistry,
    validateBehaviorMutationOwnerCatalog
} from '../../tools/test-matrix/behavior-mutation-owner.mjs';
import {
    produceBehaviorMutationQualification,
    produceBehaviorMutationQualificationCommand
} from '../../tools/test-matrix/produce-behavior-mutation-qualification.mjs';
import { loadTestPlan } from '../../tools/test-matrix/produce-behavior-test-evidence.mjs';
import { verifyBehaviorMutationQualification } from '../../tools/test-matrix/verify-behavior-mutation-qualification.mjs';

const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const RUN_ID = 'bmq-fixture-run';
const REQUIRED_BEHAVIORS = Object.freeze([
    'binary-api-aeds-contract',
    'authentication-session-permission',
    'configuration-error-security-policy',
    'article-comment-lifecycle-outbox'
]);
const TERMINAL_OUTCOME = Object.freeze({ Killed: 'failed', Survived: 'passed', Timeout: 'timeout' });

function sha256(data)
{
    return createHash('sha256').update(data).digest('hex');
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function sha256Canonical(value)
{
    return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

function repoRelative(absolute)
{
    return path.relative(root, absolute).split(path.sep).join('/');
}

const fixtureBase = path.join(root, '.tmp', 'bmq-tests');
function newFixtureDir(name)
{
    const dir = path.join(fixtureBase, `${name}-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Shared read-only inputs (repo does not change while tests run).
const sharedCatalog = loadCatalog();
const sharedRawToolPolicy = fs.readFileSync(
    path.join(root, 'config/testing/mutation/changed-critical-domains.v1.json')
);
const sharedToolPolicy = JSON.parse(sharedRawToolPolicy);
const sharedScan = scanBehaviorTestBindings({ repositoryRoot: root, catalog: sharedCatalog });
if (sharedScan.errors.length > 0)
{
    throw new Error(`binding scan fixture: ${sharedScan.errors.join('; ')}`);
}
const sharedScanBytes = Buffer.from(`${JSON.stringify(sharedScan, null, 2)}\n`, 'utf8');
const sharedOwnerClosureResult = deriveBehaviorMutationOwners({
    behaviorCatalog: sharedCatalog,
    factExtractorRegistry: loadFactExtractorRegistry(root),
    ownerCatalog: loadBehaviorMutationOwnerCatalog(root),
    worktreeDigest: FINGERPRINT
});
if (sharedOwnerClosureResult.errors.length > 0)
{
    throw new Error(`owner closure fixture: ${sharedOwnerClosureResult.errors.join('; ')}`);
}
const sharedOwnerClosure = sharedOwnerClosureResult.closure;

const EXPECTED_MUTATION_OWNER_FILES = Object.freeze({
    'authentication-session-permission': [
        'src/backend/Entities/UserSessionAuthenticationContext.cs',
        'src/backend/Infrastructure/Auth/AdminPermissions.cs',
        'src/backend/Infrastructure/Auth/AuthCookieService.cs',
        'src/backend/Infrastructure/Helpers/JwtHelper.cs',
        'src/backend/Services/Security/AdminPrincipalService.cs',
        'src/backend/Services/Security/MfaChallengeService.cs',
        'src/backend/Services/Security/PasskeyService.cs',
        'src/backend/Services/Security/RecoveryKeyService.cs',
        'src/backend/Services/Security/UserSecurityStepUpService.cs',
        'src/backend/Services/UserLoginWorkflowService.cs',
        'src/backend/Services/UserSessionCommandService.cs'
    ],
    'configuration-error-security-policy': [
        'src/backend/Entities/AnonymousCommentPolicy.cs',
        'src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs',
        'src/backend/Infrastructure/Cache/CachePolicyRegistry.cs',
        'src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs',
        'src/backend/Models/Security/SecurityAdminModels.cs',
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.SecurityChallenge.cs',
        'src/backend/Services/Security/RedisPowService.cs',
        'src/backend/Services/Security/SecurityAdminPolicyService.cs',
        'src/backend/Services/Security/SecurityChallengeOrchestrator.cs',
        'src/backend/Services/Security/SecurityChallengeVerifyRateLimiter.cs',
        'src/core/Common/ErrorCode.cs'
    ]
});

function ownerReceiptFixture()
{
    const payload = {
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        catalogDigest: sharedCatalog.digest,
        bindings: [],
        errors: []
    };
    return { ...payload, contentDigest: receiptDigestValue(payload) };
}

/**
 * Build physical Stryker report/trace/config fixtures for every source-project
 * closure of a selection. Returns run records in the shape consumed by
 * `createChangedCriticalMutationAuthority`.
 */
function buildPhysicalRuns({
    selection,
    toolPolicy,
    scan,
    baseDir,
    specialStatus = null,
    specialStatusSourceFile = null
})
{
    const bindingByBehavior = new Map();
    for (const binding of scan.bindings)
    {
        if (!bindingByBehavior.has(binding.behaviorId))
        {
            bindingByBehavior.set(binding.behaviorId, []);
        }
        bindingByBehavior.get(binding.behaviorId).push(binding);
    }
    const testFilesByBehavior = new Map();
    const rawIdByCanonical = new Map();
    let rawIdOrdinal = 0;
    for (const behavior of selection.behaviors)
    {
        const testFiles = (bindingByBehavior.get(behavior.behaviorId) ?? []).map((binding) => ({
            id: (() =>
            {
                if (!rawIdByCanonical.has(binding.canonicalTestId))
                {
                    rawIdOrdinal += 1;
                    rawIdByCanonical.set(
                        binding.canonicalTestId,
                        `00000000-0000-0000-0000-${String(rawIdOrdinal).padStart(12, '0')}`
                    );
                }
                return rawIdByCanonical.get(binding.canonicalTestId);
            })(),
            name: binding.fullyQualifiedName
        }));
        testFilesByBehavior.set(behavior.behaviorId, testFiles);
    }

    const behaviorByFile = new Map();
    for (const behavior of selection.behaviors)
    {
        for (const file of behavior.mutateFiles)
        {
            if (!behaviorByFile.has(file))
            {
                behaviorByFile.set(file, []);
            }
            behaviorByFile.get(file).push(behavior.behaviorId);
        }
    }

    function mutantFor(behaviorId, index)
    {
        const test = (testFilesByBehavior.get(behaviorId) ?? [])[0];
        return {
            id: `raw-${index}`,
            status: 'Killed',
            mutatorName: 'Boolean mutation',
            replacement: 'return value != 1;',
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 18 } },
            coveredBy: test ? [test.id] : [],
            killedBy: test ? [test.id] : []
        };
    }

    const runs = [];
    let index = 0;
    for (const closure of selection.projectClosures)
    {
        const config = createChangedCriticalStrykerConfig(selection, toolPolicy, closure.sourceProject);
        const rawConfig = Buffer.from(JSON.stringify(config));
        const files = {};
        const testFiles = {};
        const mutantsByRaw = [];
        for (const relativeFile of closure.mutateFiles)
        {
            const fullPath = `${closure.sourceProject}/${relativeFile}`;
            const behaviorIds = behaviorByFile.get(fullPath) ?? [];
            assert.equal(behaviorIds.length, 1, `expected a unique behavior owner for ${fullPath}`);
            const isSpecial = specialStatus
        && (specialStatusSourceFile
            ? fullPath === specialStatusSourceFile
            : index === 0);
            const mutant = mutantFor(behaviorIds[0], index);
            if (isSpecial)
            {
                mutant.status = specialStatus;
                if (specialStatus !== 'Killed')
                {
                    mutant.killedBy = [];
                }
                if (specialStatus === 'NoCoverage')
                {
                    mutant.coveredBy = [];
                }
            }
            index += 1;
            mutantsByRaw.push({ rawMutantId: mutant.id, status: mutant.status });
            files[relativeFile] = {
                language: 'cs',
                source: 'return value + 1;\nreturn value + 2;\nreturn value + 3;',
                mutants: [mutant]
            };
        }
        for (const behavior of closure.behaviors)
        {
            for (const test of testFilesByBehavior.get(behavior.behaviorId) ?? [])
            {
                const key = `tests/backend/Unit/${behavior.behaviorId.replaceAll('-', '_')}Tests.cs`;
                testFiles[key] = { tests: [...(testFiles[key]?.tests ?? []), test] };
            }
        }
        const report = {
            schemaVersion: '2',
            thresholds: { high: 85, low: 70 },
            files,
            testFiles
        };
        const rawReport = Buffer.from(JSON.stringify(report));

        const reportName = 'changed-critical-mutation';
        const physicalDir = path.join(baseDir, 'physical', closure.sourceProject.replaceAll('/', '-'));
        const reportAbsolutePath = path.join(physicalDir, 'reports', `${reportName}.json`);
        const configPath = path.join(baseDir, 'configs', `${closure.sourceProject.replaceAll('/', '-')}.json`);
        const tracePath = path.join(physicalDir, 'logs', 'log-fixture.txt');
        const lines = [
            '2026-08-08T00:59:59.0000000Z  [DBG] Stryker starting, version: "4.14.2" (e60f399b)',
            '2026-08-08T01:00:00.0000000Z  [DBG] Stryker started with options: '
        + `StrykerOptions { ReportPath: "${path.dirname(reportAbsolutePath)}", `
        + `ReportFileName: "${reportName}", `
        + `TestCaseFilter: "${closure.testFilter}" } (fac41b16)`
        ];
        const executed = mutantsByRaw.filter((entry) =>
            ['Killed', 'Survived', 'Timeout'].includes(entry.status));
        executed.forEach((entry, offset) =>
        {
            const startMs = Date.parse('2026-08-08T01:00:01.000Z') + offset * 100;
            const endMs = startMs + 25;
            const startedAt = new Date(startMs).toISOString().replace('.000Z', '.0000000Z');
            const completedAt = new Date(endMs).toISOString().replace('.025Z', '.0250000Z');
            const description = `${entry.rawMutantId}: mutation`;
            lines.push(`${startedAt}  [DBG] "Runner 0": Testing ${JSON.stringify([description])} (445b8f48)`);
            lines.push(`${completedAt}  [DBG] Test run for "${description}" is "${TERMINAL_OUTCOME[entry.status]}" (26093294)`);
        });
        const killed = executed.filter((entry) => entry.status === 'Killed').length;
        const scoreable = executed.length;
        const score = scoreable > 0 ? Number(((killed / scoreable) * 100).toFixed(2)) : 0;
        lines.push(`2026-08-08T01:00:10.0000000Z  [INF] The final mutation score is ${score.toFixed(2)} % (2ef58de4)`);
        const rawTrace = Buffer.from(`${lines.join('\n')}\n`);

        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
        fs.mkdirSync(path.dirname(tracePath), { recursive: true });
        fs.writeFileSync(configPath, rawConfig);
        fs.writeFileSync(reportAbsolutePath, rawReport);
        fs.writeFileSync(tracePath, rawTrace);
        runs.push({
            sourceProject: closure.sourceProject,
            config,
            rawConfig,
            report,
            rawReport,
            reportAbsolutePath,
            rawTrace,
            configPath,
            reportPath: reportAbsolutePath,
            tracePath,
            paths: {
                config: repoRelative(configPath),
                report: repoRelative(reportAbsolutePath),
                trace: repoRelative(tracePath)
            }
        });
    }
    return runs;
}

function buildMutationFixture({
    name,
    scope = 'release',
    changedPaths = null,
    specialStatus = null,
    specialStatusSourceFile = null,
    evidenceRetry = false,
    evidenceDiagnostic = false,
    evidenceSkipped = false,
    seal = {}
})
{
    const fixtureDir = newFixtureDir(name);
    validateToolPolicy(sharedToolPolicy);
    const ownerReceipt = ownerReceiptFixture();
    const ownerReceiptPath = path.join(fixtureDir, 'owner-receipt.json');
    fs.writeFileSync(ownerReceiptPath, `${JSON.stringify(ownerReceipt, null, 2)}\n`);

    const bindingScanPath = path.join(fixtureDir, 'binding-scan.json');
    fs.writeFileSync(bindingScanPath, sharedScanBytes);
    const testBindingScan = JSON.parse(sharedScanBytes);

    const sourceState = { commit: COMMIT, worktreeFingerprint: FINGERPRINT };
    const common = {
        toolPolicy: sharedToolPolicy,
        rawToolPolicy: sharedRawToolPolicy,
        sourceState,
        ownerReceipt,
        implementationOwnerClosure: sharedOwnerClosure,
        behaviorCatalog: sharedCatalog,
        testBindingScan,
        rawTestBindingScan: sharedScanBytes
    };
    const selection = scope === 'release'
        ? selectRequiredBehaviorMutations(common)
        : selectChangedCriticalMutation({ ...common, changedPaths: changedPaths ?? [] });
    const selectionPath = path.join(fixtureDir, 'selection.json');
    fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
    const rawSelection = fs.readFileSync(selectionPath);

    const runs = buildPhysicalRuns({
        selection,
        toolPolicy: sharedToolPolicy,
        scan: sharedScan,
        baseDir: fixtureDir,
        specialStatus,
        specialStatusSourceFile
    });
    const authority = createChangedCriticalMutationAuthority({
        selection,
        rawSelection,
        catalog: sharedToolPolicy,
        rawCatalog: sharedRawToolPolicy,
        runs,
        selectionPath: repoRelative(selectionPath),
        runId: RUN_ID,
        generatedAt: '2026-08-08T01:02:03.000Z',
        repositoryRoot: root
    });
    const authorityPath = path.join(fixtureDir, 'authority.json');
    fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);

    const plan = {
        schema: 'fsusblog.release-evidence.test-plan.v1',
        generatedAt: '2026-08-08T00:00:00.000Z',
        commit: COMMIT,
        namespace: null,
        tiers: [{
            id: 'fixture-tier',
            evidence: [...new Set(sharedScan.bindings.map((binding) => binding.sourcePath))].sort()
        }]
    };
    const planPath = path.join(fixtureDir, 'test-plan.json');
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const planResult = loadTestPlan(repoRelative(planPath), { repositoryRoot: root });
    assert.equal(planResult.errors.length, 0, `test plan: ${planResult.errors.join('; ')}`);

    const evidenceEntries = [];
    for (const binding of sharedScan.bindings)
    {
        evidenceEntries.push({
            canonicalTestId: binding.canonicalTestId,
            discovered: !evidenceSkipped,
            executed: !evidenceSkipped,
            outcome: evidenceSkipped ? 'skipped' : 'passed',
            run: {
                id: RUN_ID,
                attemptKind: evidenceRetry ? 'retry' : (evidenceDiagnostic ? 'diagnostic' : 'primary'),
                evidenceClass: 'correctness'
            }
        });
    }
    const btePayload = {
        schema: 'fsusblog.behavior-test-evidence-receipt.v1',
        producer: { command: 'node tools/test-matrix/produce-behavior-test-evidence.mjs' },
        sourceState: { commit: COMMIT, worktreeFingerprint: `sha256:${FINGERPRINT}` },
        run: { id: RUN_ID, attemptKind: evidenceRetry ? 'retry' : 'primary', evidenceClass: 'correctness' },
        testPlanDigest: planResult.testPlanDigest,
        evidence: evidenceEntries
    };
    const bteReceipt = { ...btePayload, contentDigest: sha256Canonical(btePayload) };
    const btePath = path.join(fixtureDir, 'behavior-test-evidence.json');
    fs.writeFileSync(btePath, `${JSON.stringify(bteReceipt, null, 2)}\n`);

    const mergedOwner = {
        ...ownerReceipt,
        bindings: [...ownerReceipt.bindings, ...sharedOwnerClosure.bindings]
    };
    const attributed = runs.map((run) => attributeMutantsToBehaviors({
        report: run.report,
        sourceProject: run.sourceProject,
        ownerReceipt: mergedOwner,
        selection
    }));
    const attributions = attachExpectedTestEvidence({
        attributions: attributed.flatMap(({ attributions: entries }) => entries),
        selection
    });
    const blocked = attributed.flatMap(({ blocked: entries }) => entries);
    const expectedByBehavior = expectedAttributionMutantIdsByBehavior(selection, authority);
    const bindingByTestId = Object.fromEntries(
        [...new Map(testBindingScan.bindings.map((binding) => [binding.canonicalTestId, binding])).values()]
            .map((binding) => [binding.canonicalTestId, binding])
    );
    const testIdentityByRawId = Object.fromEntries(
        (authority.testIdentities ?? []).map((entry) => [entry.rawTestId, entry.fullyQualifiedName])
    );
    const cleanCanonical = new Set(
        bteReceipt.evidence
            .filter((entry) => entry.discovered && entry.executed && entry.outcome === 'passed'
        && entry.run?.attemptKind !== 'retry' && entry.run?.attemptKind !== 'diagnostic')
            .map((entry) => entry.canonicalTestId)
    );
    const cleanTestIdsByBehavior = {};
    for (const behavior of selection.behaviors)
    {
        cleanTestIdsByBehavior[behavior.behaviorId] = (behavior.testBindings ?? [])
            .map((binding) => binding.canonicalTestId)
            .filter((testId) => cleanCanonical.has(testId));
    }
    const qualification = qualifyBehaviorMutations({
        attributions,
        blocked,
        behaviorCatalog: sharedCatalog,
        behaviorIds: selection.behaviors.map(({ behaviorId }) => behaviorId),
        qualificationOptions: {
            expectedMutantIdsByBehavior: expectedByBehavior,
            cleanTestIdsByBehavior,
            bindingByTestId,
            testIdentityByRawId
        }
    });

    const receiptPath = path.join(fixtureDir, 'mutation-evidence.json');

    function sealWith(sealOptions)
    {
        const droppedMutantIds = new Set(sealOptions.dropAttributionMutantIds ?? []);
        const droppedBehaviorIds = new Set(sealOptions.dropAttributionBehaviorIds ?? []);
        const duplicatedMutantIds = new Set(sealOptions.duplicateAttributionMutantIds ?? []);
        let sealedAttributions = attributions.filter((entry) =>
            !droppedMutantIds.has(entry.mutantId) && !droppedBehaviorIds.has(entry.behaviorId));
        if (duplicatedMutantIds.size > 0)
        {
            sealedAttributions = [
                ...sealedAttributions,
                ...attributions.filter((entry) => duplicatedMutantIds.has(entry.mutantId))
            ];
        }
        let failureReasons = [
            ...blocked.map((entry) => `${entry.mutantId} attribution blocked: ${entry.reason}`),
            ...qualification.qualifications.flatMap((entry) => entry.failures),
            ...(sealOptions.extraFailureReasons ?? [])
        ].sort();
        const status = sealOptions.forceStatus
      ?? (qualification.failed || blocked.length > 0 ? 'failed' : 'ok');
        const sealedQualifications = qualification.qualifications.filter(
            (entry) => !droppedBehaviorIds.has(entry.behaviorId)
        );
        let sealedBlockedCount = blocked.length;
        if (status === 'ok')
        {
            // A dishonest forced-ok receipt must not carry failure reasons or
            // blocked mutants; the verifier rejects the hidden failures anyway by
            // recomputing qualification from the raw authority.
            failureReasons = [];
            sealedBlockedCount = 0;
        }
        if (status === 'failed' && failureReasons.length === 0)
        {
            failureReasons = ['fixture qualification failed'];
        }
        const sealed = sealMutationEvidenceReceipt({
            sourceCommit: COMMIT,
            worktreeFingerprint: FINGERPRINT,
            catalogDigest: selection.behaviorCatalogDigest,
            selectionDigest: selection.closureDigest,
            ownerReceiptDigest: ownerReceipt.contentDigest,
            testBindingScanDigest: selection.testBindingScanDigest,
            rawReportDigest: authority.rawReportDigest,
            rawTraceDigest: authority.rawTraceDigest,
            attributions: sealedAttributions.map((entry) => ({
                ...entry,
                rawResult: {
                    project: runs.find((run) => entry.sourcePath.startsWith(`${run.sourceProject}/`))?.sourceProject ?? null,
                    report: runs.find((run) => entry.sourcePath.startsWith(`${run.sourceProject}/`))?.paths.report ?? null,
                    trace: runs.find((run) => entry.sourcePath.startsWith(`${run.sourceProject}/`))?.paths.trace ?? null
                },
                attempt: 'attempt-0001',
                provenance: RUN_ID
            })),
            qualifications: sealedQualifications,
            blockedCount: sealedBlockedCount,
            status,
            failureReasons,
            runId: RUN_ID,
            attemptId: 'attempt-0001',
            scope,
            testPlanDigest: planResult.testPlanDigest,
            behaviorTestEvidenceDigest: bteReceipt.contentDigest,
            implementationOwnerClosureDigest: sharedOwnerClosure.contentDigest
        });
        fs.writeFileSync(receiptPath, `${JSON.stringify(sealed, null, 2)}\n`);
        return sealed;
    }

    const receipt = sealWith(seal);

    return {
        fixtureDir,
        scope,
        selection,
        authority,
        receipt,
        attributions,
        qualification,
        blocked,
        expectedByBehavior,
        runs,
        ownerReceipt,
        bteReceipt,
        testBindingScan,
        planResult,
        paths: {
            receipt: repoRelative(receiptPath),
            selection: repoRelative(selectionPath),
            authority: repoRelative(authorityPath),
            ownerReceipt: repoRelative(ownerReceiptPath),
            testBindings: repoRelative(bindingScanPath),
            testPlan: repoRelative(planPath),
            bte: repoRelative(btePath)
        },
        sealWith
    };
}

function verifyOptions(fixture, overrides = {})
{
    return {
        repositoryRoot: root,
        receipt: fixture.paths.receipt,
        selection: fixture.paths.selection,
        authority: fixture.paths.authority,
        ownerReceipt: fixture.paths.ownerReceipt,
        testBindings: fixture.paths.testBindings,
        testPlan: fixture.paths.testPlan,
        behaviorTestEvidence: fixture.paths.bte,
        sourceCommit: COMMIT,
        worktreeFingerprint: FINGERPRINT,
        runId: RUN_ID,
        scope: fixture.scope,
        ...overrides
    };
}

function producerOptions(fixture, overrides = {})
{
    return {
        scope: fixture.scope,
        sourceCommit: COMMIT,
        worktreeFingerprint: FINGERPRINT,
        outputRoot: fixture.fixtureDir,
        runId: RUN_ID,
        ownerReceipt: fixture.paths.ownerReceipt,
        testBindings: fixture.paths.testBindings,
        testPlan: fixture.paths.testPlan,
        behaviorTestEvidence: fixture.paths.bte,
        repositoryRoot: root,
        ...overrides
    };
}

function fakePhysicalRunner(options)
{
    return {
        status: 0,
        physicalRuns: buildPhysicalRuns({
            selection: options.selection,
            toolPolicy: options.toolPolicy,
            scan: sharedScan,
            baseDir: options.runDirectory,
            specialStatus: options.specialStatus,
            specialStatusSourceFile: options.specialStatusSourceFile
        })
    };
}

function matrixFixture({ manualOnly = false, cadence = 'pr', requiredFor = 'production', nightlyOnly = false } = {})
{
    return [
        'version: 3',
        'tiers:',
        '    - id: backend-mutation-changed-critical',
        '      owner: ServerContractAgent',
        '      command: tools/test/lanes/backend-mutation-changed-critical.sh',
        '      cadence: ' + cadence,
        '      requiredFor: ' + requiredFor,
        '      manualOnly: ' + manualOnly,
        '      nightlyOnly: ' + nightlyOnly,
        '      phase: 5',
        '      risk: critical',
        '      localOnly: false',
        ''
    ].join('\n');
}

test('mutation-owner catalog has an exact disjoint C# source closure for required security behaviors', () =>
{
    const bindingsByBehavior = new Map();
    const ownerBySource = new Map();
    for (const binding of sharedOwnerClosure.bindings)
    {
        if (!bindingsByBehavior.has(binding.behaviorId))
        {
            bindingsByBehavior.set(binding.behaviorId, []);
        }
        bindingsByBehavior.get(binding.behaviorId).push(binding.sourcePath);
        assert.equal(ownerBySource.has(binding.sourcePath), false, `duplicate mutation owner for ${binding.sourcePath}`);
        ownerBySource.set(binding.sourcePath, binding.behaviorId);
    }

    for (const [behaviorId, expectedSources] of Object.entries(EXPECTED_MUTATION_OWNER_FILES))
    {
        assert.deepEqual(
            [...(bindingsByBehavior.get(behaviorId) ?? [])].sort(),
            [...expectedSources].sort(),
            `${behaviorId} mutation-owner source closure drifted`
        );
    }
    for (const behaviorId of REQUIRED_BEHAVIORS)
    {
        assert.ok((bindingsByBehavior.get(behaviorId) ?? []).length > 0, `${behaviorId} must select C# mutants`);
    }
});

test('mutation-owner catalog rejects every missing security owner and shared-source ambiguity', () =>
{
    const ownerCatalog = loadBehaviorMutationOwnerCatalog(root);
    const factExtractorRegistry = loadFactExtractorRegistry(root);
    for (const [behaviorId, sources] of Object.entries(EXPECTED_MUTATION_OWNER_FILES))
    {
        for (const sourcePath of sources)
        {
            const mutated = structuredClone(ownerCatalog);
            const entry = mutated.behaviors.find((candidate) => candidate.behaviorId === behaviorId);
            entry.sourceFiles = entry.sourceFiles.filter((candidate) => candidate !== sourcePath);
            const result = validateBehaviorMutationOwnerCatalog({
                behaviorCatalog: sharedCatalog,
                factExtractorRegistry,
                ownerCatalog: mutated,
                repositoryRoot: root
            });
            assert.equal(result.ok, false, `removing ${sourcePath} must fail closed`);
            assert.ok(
                result.errors.some((error) => error.includes(sourcePath)),
                `${sourcePath} removal must produce a source-specific error:\n${result.errors.join('\n')}`
            );
        }
    }

    const ambiguous = structuredClone(ownerCatalog);
    ambiguous.behaviors
        .find((entry) => entry.behaviorId === 'configuration-error-security-policy')
        .sourceFiles.push('src/backend/Services/Security/PasskeyService.cs');
    const ambiguousResult = validateBehaviorMutationOwnerCatalog({
        behaviorCatalog: sharedCatalog,
        factExtractorRegistry,
        ownerCatalog: ambiguous,
        repositoryRoot: root
    });
    assert.equal(ambiguousResult.ok, false);
    assert.ok(
        ambiguousResult.errors.some((error) => error.includes('shared by multiple behaviors')
            && error.includes('src/backend/Services/Security/PasskeyService.cs')),
        ambiguousResult.errors.join('\n')
    );
});

test('behavior mutation qualification: producer + verifier seal and accept a complete release fixture', () =>
{
    const fixture = buildMutationFixture({ name: 'release-ok', scope: 'release' });
    assert.equal(fixture.receipt.schema, 'fsusblog.mutation-evidence-receipt.v1');
    assert.equal(fixture.receipt.scope, 'release');
    assert.equal(fixture.receipt.status, 'ok');
    assert.deepEqual(
        fixture.qualification.qualifications.map((entry) => entry.behaviorId).sort(),
        [...REQUIRED_BEHAVIORS].sort()
    );
    assert.equal(fixture.qualification.failed, false);
    for (const entry of fixture.qualification.qualifications)
    {
        assert.equal(entry.qualified, true);
    }

    const result = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.errors, []);

    const produced = produceBehaviorMutationQualification(
        producerOptions(fixture, { physicalRunner: fakePhysicalRunner })
    );
    assert.notEqual(produced.receipt, null, produced.errors.join('\n'));
    assert.equal(produced.receipt.status, 'ok');
    assert.deepEqual(produced.errors, []);
    const producedDir = path.join(fixture.fixtureDir, RUN_ID);
    const verifyProduced = verifyBehaviorMutationQualification(verifyOptions(fixture, {
        receipt: repoRelative(path.join(producedDir, 'mutation-evidence.json')),
        selection: repoRelative(path.join(producedDir, 'selection.json')),
        authority: repoRelative(path.join(producedDir, 'authority.json'))
    }));
    assert.equal(verifyProduced.ok, true, verifyProduced.errors.join('\n'));
});

test('one required behavior/mutant omitted fails closed', () =>
{
    const fixture = buildMutationFixture({ name: 'omitted-mutant', scope: 'release' });
    const firstBehavior = fixture.qualification.qualifications[0].behaviorId;
    const omittedMutant = fixture.expectedByBehavior[firstBehavior][0];
    fixture.sealWith({
        forceStatus: 'ok',
        dropAttributionMutantIds: [omittedMutant]
    });
    const result = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('missing required mutant result(s)')), result.errors.join('\n'));
    assert.ok(result.errors.some((error) => error.includes('recordedMutants mismatch')), result.errors.join('\n'));

    const fixtureBehavior = buildMutationFixture({ name: 'omitted-behavior', scope: 'release' });
    fixtureBehavior.sealWith({
        forceStatus: 'ok',
        dropAttributionBehaviorIds: [REQUIRED_BEHAVIORS[0]]
    });
    const behaviorResult = verifyBehaviorMutationQualification(verifyOptions(fixtureBehavior));
    assert.equal(behaviorResult.ok, false);
    assert.ok(behaviorResult.errors.some((error) => error.includes('missing qualification record')), behaviorResult.errors.join('\n'));
    assert.ok(behaviorResult.errors.some((error) => error.includes('missing required mutant result(s)')), behaviorResult.errors.join('\n'));
});

test('survived mutant with passing domain total score fails closed per behavior', () =>
{
    const fixture = buildMutationFixture({ name: 'survived', scope: 'release', specialStatus: 'Survived' });
    const survivedEntry = fixture.qualification.qualifications.find((entry) => entry.survived > 0);
    assert.ok(survivedEntry, 'expected a survived mutant');
    assert.ok(survivedEntry.score >= survivedEntry.minimumMutationScore,
        `domain total score ${survivedEntry.score} should pass; masking must not apply`);
    assert.equal(survivedEntry.qualified, false);
    assert.equal(fixture.receipt.status, 'failed');
    assert.ok(fixture.receipt.failureReasons.some((reason) => reason.includes('survived mutant(s)')));

    const result = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('survived mutant(s)')), result.errors.join('\n'));

    // A dishonest receipt that hides the survived mutant (score-masked 'ok') is
    // still rejected because the exact required mutant set comes from the raw
    // authority, not from the receipt status.
    const survivedMutantId = fixture.attributions.find((entry) => entry.status === 'Survived').mutantId;
    fixture.sealWith({
        forceStatus: 'ok',
        dropAttributionMutantIds: [survivedMutantId]
    });
    const masked = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(masked.ok, false);
    assert.ok(masked.errors.some((error) => error.includes('missing required mutant result(s)')), masked.errors.join('\n'));
});

test('manualOnly/requiredFor none rejected by static governance, producer and verifier', () =>
{
    const manualOnly = matrixFixture({ manualOnly: true, cadence: 'release-manual', requiredFor: 'none' });
    const governance = scanBehaviorMutationGovernance({ matrixYaml: manualOnly });
    assert.equal(governance.ok, false);
    assert.ok(governance.violations.some((v) => v.includes('must not be manualOnly')), governance.violations.join('\n'));
    assert.ok(governance.violations.some((v) => v.includes('cadence must be pr')), governance.violations.join('\n'));
    assert.ok(governance.violations.some((v) => v.includes('requiredFor must be production')), governance.violations.join('\n'));

    const nightlyOnly = matrixFixture({ nightlyOnly: true });
    const nightlyGovernance = scanBehaviorMutationGovernance({ matrixYaml: nightlyOnly });
    assert.equal(nightlyGovernance.ok, false);
    assert.ok(nightlyGovernance.violations.some((v) => v.includes('must not be nightlyOnly')), nightlyGovernance.violations.join('\n'));

    const missingTier = 'version: 3\ntiers:\n    - id: backend-mutation\n      cadence: nightly\n';
    const missingGovernance = scanBehaviorMutationGovernance({ matrixYaml: missingTier });
    assert.equal(missingGovernance.ok, false);
    assert.ok(missingGovernance.violations.some((v) => v.includes('is missing')), missingGovernance.violations.join('\n'));

    const fixture = buildMutationFixture({ name: 'governance', scope: 'release' });
    const verifierResult = verifyBehaviorMutationQualification(
        verifyOptions(fixture, { governanceMatrixYaml: manualOnly })
    );
    assert.equal(verifierResult.ok, false);
    assert.ok(verifierResult.errors.some((error) => error.includes('static behavior-mutation governance failed')),
        verifierResult.errors.join('\n'));

    const matrixPath = path.join(fixture.fixtureDir, 'matrix-fixture.yml');
    fs.writeFileSync(matrixPath, manualOnly);
    const producerResult = produceBehaviorMutationQualification(
        producerOptions(fixture, { governanceMatrix: repoRelative(matrixPath) })
    );
    assert.equal(producerResult.receipt, null);
    assert.ok(producerResult.errors.some((error) => error.includes('static behavior-mutation governance failed')),
        producerResult.errors.join('\n'));
    assert.ok(producerResult.canonicalCommand.includes(produceBehaviorMutationQualificationCommand));
});

test('changed-only docs/binding/catalog change triggers the full required closure', () =>
{
    const common = {
        toolPolicy: sharedToolPolicy,
        rawToolPolicy: sharedRawToolPolicy,
        sourceState: { commit: COMMIT, worktreeFingerprint: FINGERPRINT },
        ownerReceipt: ownerReceiptFixture(),
        implementationOwnerClosure: sharedOwnerClosure,
        behaviorCatalog: sharedCatalog,
        testBindingScan: JSON.parse(sharedScanBytes),
        rawTestBindingScan: sharedScanBytes
    };
    for (const changedPath of [
        'docs/testing.md',
        'tests/tools/behavior-test-binding.test.mjs',
        'config/contracts/behavior-contracts.json'
    ])
    {
        const selection = selectChangedCriticalMutation({ ...common, changedPaths: [changedPath] });
        assert.equal(selection.status, 'selected');
        assert.equal(selection.scope, 'pr');
        assert.deepEqual(
            selection.behaviors.map((behavior) => behavior.behaviorId).sort(),
            [...REQUIRED_BEHAVIORS].sort()
        );
        assert.equal(selection.implementationOwnerClosureDigest, sharedOwnerClosure.contentDigest);
        for (const behavior of selection.behaviors)
        {
            assert.ok(behavior.mutateFiles.length > 0, `${behavior.behaviorId} must select C# mutate files`);
        }
    }
    const unrelated = selectChangedCriticalMutation({ ...common, changedPaths: ['docs/architecture.md'] });
    assert.equal(unrelated.status, 'empty');

    const fixture = buildMutationFixture({
        name: 'docs-change',
        scope: 'pr',
        changedPaths: ['docs/testing.md']
    });
    assert.equal(fixture.selection.status, 'selected');
    assert.deepEqual(
        fixture.selection.behaviors.map((behavior) => behavior.behaviorId).sort(),
        [...REQUIRED_BEHAVIORS].sort()
    );
    const result = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(result.ok, true, result.errors.join('\n'));
});

test('main/old-run mutation receipt and evidence are rejected', () =>
{
    const fixture = buildMutationFixture({ name: 'old-run', scope: 'release' });
    const runMismatch = verifyBehaviorMutationQualification(verifyOptions(fixture, { runId: 'old-run' }));
    assert.equal(runMismatch.ok, false);
    assert.ok(runMismatch.errors.some((error) => error.includes('run identity mismatch')), runMismatch.errors.join('\n'));

    const commitMismatch = verifyBehaviorMutationQualification(
        verifyOptions(fixture, { sourceCommit: 'f'.repeat(40) })
    );
    assert.equal(commitMismatch.ok, false);
    assert.ok(commitMismatch.errors.some((error) => error.includes('source commit mismatch')), commitMismatch.errors.join('\n'));

    const produced = produceBehaviorMutationQualification(
        producerOptions(fixture, { runId: 'old-run', physicalRunner: fakePhysicalRunner })
    );
    assert.equal(produced.receipt, null);
    assert.ok(produced.errors.some((error) => error.includes('behavior-test evidence run identity mismatch')),
        produced.errors.join('\n'));
});

test('skipped/recovered/diagnostic tests cannot kill mutants (clean-first-attempt only)', () =>
{
    const retry = buildMutationFixture({ name: 'retry', scope: 'release', evidenceRetry: true });
    const retryResult = verifyBehaviorMutationQualification(verifyOptions(retry));
    assert.equal(retryResult.ok, false);
    assert.ok(retryResult.errors.some((error) => error.includes('retry evidence cannot satisfy clean mutation qualification')),
        retryResult.errors.join('\n'));
    assert.ok(retryResult.errors.some((error) => error.includes('required test(s) not clean this round')),
        retryResult.errors.join('\n'));

    const diagnostic = buildMutationFixture({ name: 'diagnostic', scope: 'release', evidenceDiagnostic: true });
    const diagnosticResult = verifyBehaviorMutationQualification(verifyOptions(diagnostic));
    assert.equal(diagnosticResult.ok, false);
    assert.ok(diagnosticResult.errors.some((error) => error.includes('diagnostic evidence cannot satisfy clean mutation qualification')),
        diagnosticResult.errors.join('\n'));

    const skipped = buildMutationFixture({ name: 'skipped', scope: 'release', evidenceSkipped: true });
    const skippedResult = verifyBehaviorMutationQualification(verifyOptions(skipped));
    assert.equal(skippedResult.ok, false);
    assert.ok(skippedResult.errors.some((error) => error.includes('required test(s) not clean this round')),
        skippedResult.errors.join('\n'));
});

test('mutation timeout and error fail closed (never a warning)', () =>
{
    const timeout = buildMutationFixture({ name: 'timeout', scope: 'release', specialStatus: 'Timeout' });
    const timeoutResult = verifyBehaviorMutationQualification(verifyOptions(timeout));
    assert.equal(timeoutResult.ok, false);
    assert.ok(timeoutResult.errors.some((error) => error.includes('timeout mutant(s)')), timeoutResult.errors.join('\n'));
    assert.ok(timeoutResult.canonicalCommand.includes(produceBehaviorMutationQualificationCommand));

    const compileError = buildMutationFixture({ name: 'compile-error', scope: 'release', specialStatus: 'CompileError' });
    const compileResult = verifyBehaviorMutationQualification(verifyOptions(compileError));
    assert.equal(compileResult.ok, false);
    assert.ok(compileResult.errors.some((error) => error.includes('compile-error')), compileResult.errors.join('\n'));
    assert.ok(compileResult.errors.some((error) => error.includes('error')), compileResult.errors.join('\n'));
});

test('duplicate/multiple and zero mutant results fail closed', () =>
{
    const fixture = buildMutationFixture({ name: 'duplicate', scope: 'release' });
    const firstBehavior = fixture.qualification.qualifications[0].behaviorId;
    const duplicatedMutant = fixture.expectedByBehavior[firstBehavior][0];
    fixture.sealWith({
        forceStatus: 'ok',
        duplicateAttributionMutantIds: [duplicatedMutant]
    });
    const duplicateResult = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(duplicateResult.ok, false);
    assert.ok(duplicateResult.errors.some((error) => error.includes('duplicate/multiple mutant result(s)')),
        duplicateResult.errors.join('\n'));

    const zero = buildMutationFixture({ name: 'zero', scope: 'release' });
    const authorityPath = path.resolve(root, zero.paths.authority);
    const tamperedAuthority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
    tamperedAuthority.mutants.executed = 0;
    fs.writeFileSync(authorityPath, `${JSON.stringify(tamperedAuthority, null, 2)}\n`);
    const zeroResult = verifyBehaviorMutationQualification(verifyOptions(zero));
    assert.equal(zeroResult.ok, false);
    assert.ok(zeroResult.errors.some((error) => error.includes('executed zero mutants')), zeroResult.errors.join('\n'));
});

test('selector/binding/source drift fails closed', () =>
{
    const selector = buildMutationFixture({ name: 'selector-drift', scope: 'release' });
    const selectionPath = path.resolve(root, selector.paths.selection);
    const driftedSelection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
    driftedSelection.closureDigest = 'c'.repeat(64);
    fs.writeFileSync(selectionPath, `${JSON.stringify(driftedSelection, null, 2)}\n`);
    const selectorResult = verifyBehaviorMutationQualification(verifyOptions(selector));
    assert.equal(selectorResult.ok, false);
    assert.ok(selectorResult.errors.some((error) => error.includes('selector closure digest drift')), selectorResult.errors.join('\n'));
    assert.ok(selectorResult.errors.some((error) => error.includes('selectionDigest does not match')), selectorResult.errors.join('\n'));

    const binding = buildMutationFixture({ name: 'binding-drift', scope: 'release' });
    fs.appendFileSync(path.resolve(root, binding.paths.testBindings), '\n  ');
    const bindingResult = verifyBehaviorMutationQualification(verifyOptions(binding));
    assert.equal(bindingResult.ok, false);
    assert.ok(bindingResult.errors.some((error) => error.includes('testBindingScanDigest does not match')), bindingResult.errors.join('\n'));

    const source = buildMutationFixture({ name: 'source-drift', scope: 'release' });
    const sourceResult = verifyBehaviorMutationQualification(
        verifyOptions(source, { worktreeFingerprint: 'c'.repeat(64) })
    );
    assert.equal(sourceResult.ok, false);
    assert.ok(sourceResult.errors.some((error) => error.includes('worktree fingerprint mismatch')), sourceResult.errors.join('\n'));
});

test('missing tool/input fails with the canonical producer command, never manual approval', () =>
{
    const producerMissing = produceBehaviorMutationQualification({});
    assert.equal(producerMissing.receipt, null);
    assert.ok(producerMissing.errors.length > 0);
    assert.ok(producerMissing.errors.some((error) => error.includes('missing required input')));
    assert.ok(producerMissing.canonicalCommand.includes('node tools/test-matrix/produce-behavior-mutation-qualification.mjs'));
    assert.ok(producerMissing.canonicalCommand.includes('--scope'));
    assert.ok(!producerMissing.errors.some((error) => /manual|warn|approve|fallback/iu.test(error)));

    const verifierMissing = verifyBehaviorMutationQualification({});
    assert.equal(verifierMissing.ok, false);
    assert.ok(verifierMissing.errors.some((error) => error.includes('missing required input')));
    assert.ok(verifierMissing.canonicalCommand.includes('node tools/test-matrix/produce-behavior-mutation-qualification.mjs'));
    assert.ok(!verifierMissing.errors.some((error) => /manual|warn|approve|fallback/iu.test(error)));

    const lane = path.join(root, 'tools/test/lanes/backend-mutation-changed-critical.sh');
    const env = { ...process.env };
    for (const key of [
        'FSUSBLOG_TEST_SOURCE_COMMIT',
        'FSUSBLOG_TEST_SOURCE_FINGERPRINT',
        'FSUSBLOG_TEST_RUN_ID',
        'FSUSBLOG_BEHAVIOR_OWNER_RECEIPT',
        'FSUSBLOG_BEHAVIOR_TEST_BINDINGS',
        'FSUSBLOG_TEST_PLAN',
        'FSUSBLOG_BEHAVIOR_TEST_EVIDENCE'
    ])
    {
        delete env[key];
    }
    const laneResult = spawnSync('bash', [lane], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(laneResult.status, 0);
    assert.match(laneResult.stderr, /canonical command/u);
    assert.match(laneResult.stderr, /produce-behavior-mutation-qualification\.mjs/u);
    assert.doesNotMatch(laneResult.stderr, /manual approval|warning success|--warn\b/u);
});

test('a second mutation qualification producer/format is rejected', () =>
{
    assert.equal(
        produceBehaviorMutationQualificationCommand,
        'node tools/test-matrix/produce-behavior-mutation-qualification.mjs'
    );
    const fixture = buildMutationFixture({ name: 'second-producer', scope: 'release' });
    const receiptPath = path.resolve(root, fixture.paths.receipt);

    const secondFormat = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    secondFormat.schema = 'fsusblog.mutation-evidence-receipt.v2';
    const secondFormatPayload = { ...secondFormat };
    delete secondFormatPayload.contentDigest;
    secondFormat.contentDigest = receiptDigestValue(secondFormatPayload);
    fs.writeFileSync(receiptPath, `${JSON.stringify(secondFormat, null, 2)}\n`);
    const schemaResult = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(schemaResult.ok, false);
    assert.ok(schemaResult.errors.some((error) => error.includes('mutation evidence schema mismatch')), schemaResult.errors.join('\n'));

    const tamperedDigest = buildMutationFixture({ name: 'second-producer-digest', scope: 'release' });
    const tamperedPath = path.resolve(root, tamperedDigest.paths.receipt);
    const tamperedReceipt = JSON.parse(fs.readFileSync(tamperedPath, 'utf8'));
    tamperedReceipt.contentDigest = '0'.repeat(64);
    fs.writeFileSync(tamperedPath, `${JSON.stringify(tamperedReceipt, null, 2)}\n`);
    const digestResult = verifyBehaviorMutationQualification(verifyOptions(tamperedDigest));
    assert.equal(digestResult.ok, false);
    assert.ok(digestResult.errors.some((error) => error.includes('contentDigest mismatch (tamper or second producer)')),
        digestResult.errors.join('\n'));
});

test('receipt and raw-result tamper are rejected', () =>
{
    const fixture = buildMutationFixture({ name: 'receipt-tamper', scope: 'release' });
    const receiptPath = path.resolve(root, fixture.paths.receipt);
    const tampered = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    tampered.blockedCount = 1;
    fs.writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const receiptResult = verifyBehaviorMutationQualification(verifyOptions(fixture));
    assert.equal(receiptResult.ok, false);
    assert.ok(receiptResult.errors.some((error) => error.includes('contentDigest mismatch (tamper or second producer)')),
        receiptResult.errors.join('\n'));

    const raw = buildMutationFixture({ name: 'raw-tamper', scope: 'release' });
    const reportPath = path.resolve(root, raw.runs[0].paths.report);
    fs.appendFileSync(reportPath, '\n');
    const reportResult = verifyBehaviorMutationQualification(verifyOptions(raw));
    assert.equal(reportResult.ok, false);
    assert.ok(reportResult.errors.some((error) => error.includes('file tamper')), reportResult.errors.join('\n'));

    const trace = buildMutationFixture({ name: 'trace-tamper', scope: 'release' });
    const tracePath = path.resolve(root, trace.runs[0].paths.trace);
    fs.appendFileSync(tracePath, '\n');
    const traceResult = verifyBehaviorMutationQualification(verifyOptions(trace));
    assert.equal(traceResult.ok, false);
    assert.ok(traceResult.errors.some((error) => error.includes('file tamper')), traceResult.errors.join('\n'));
});
