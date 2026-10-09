import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const { readGitChangedPaths, selectAffectedPrTiers, validateImpactDeclarations, validatePrImpactPlanBinding, prImpactCallerContext, prImpactConsumerEnvironment, effectivePrExecutionStage, sourceRegressionEntries, unsupportedSourceStageFiles, sourceShellSyntaxArguments, assertSourceShellSyntaxInspection, sourceFrontendCheckGroups, sourceFrontendDataInputs, inspectSourceFrontendConfiguration } = await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));

const tier = (id, extra = {}) => ({ id, phase: 0, command: `node tools/${id}.mjs`,
    ciJob: id, executionDependsOn: [], ...extra });
const matrix = () => ({ tiers: [
    tier('validate-declarations'), tier('pr-smart-gate-plan', { executionDependsOn: ['validate-declarations'] }),
    tier('source-governance', { executionDependsOn: ['pr-smart-gate-plan'] }),
    tier('validate-matrix'), tier('behavior-doc-static-admission', { executionDependsOn: ['validate-matrix'] }),
    tier('backend-build', { cacheInputs: ['src/backend'], ciJob: 'fast-backend', executionDependsOn: ['behavior-doc-static-admission'] }),
    tier('backend-unit', { ciJob: 'fast-backend', executionDependsOn: ['backend-build'] }),
    tier('unaffected-runtime', { prDefault: true, smartGateMode: 'always' })
] });

test('ordinary documentation and normal naming metadata perform source checks without unrelated SDK/runtime', () =>
{
    const result = selectAffectedPrTiers(matrix(), ['docs/operations.md', 'artifacts/change-contract/source-wip-external-naming.json']);
    assert.deepEqual(result.selectedTierIds, ['pr-smart-gate-plan', 'source-governance', 'validate-declarations']);
    assert.equal(result.fullMode, false);
});

test('affected source retains fixed-job members and complete original admission/build prerequisites', () =>
{
    const result = selectAffectedPrTiers(matrix(), ['src/backend/Changed.cs']);
    for (const id of ['backend-unit', 'backend-build', 'behavior-doc-static-admission', 'validate-matrix'])
    {
        assert.ok(result.selectedTierIds.includes(id), id);
    }
    assert.equal(result.selectedTierIds.includes('unaffected-runtime'), false);
});

test('unknown paths and shared selection authority retain complete checks', () =>
{
    for (const file of ['new-unowned/source.js', 'tools/test-matrix/pr-impact-plan.mjs', 'tests/matrix.yml', 'docs/testing.md', 'docs/new-runner.mjs', 'docs/runtime/input.sh'])
    {
        const result = selectAffectedPrTiers(matrix(), [file]);
        assert.equal(result.selectionScope, 'complete-pr', file);
        assert.equal(result.selectedTierIds.length, matrix().tiers.length);
    }
});

test('full mode preserves every original declaration including unrelated runtime', () =>
{
    const result = selectAffectedPrTiers(matrix(), [], { full: true });
    assert.equal(result.selectedTierIds.length, matrix().tiers.length);
});

test('evidence producers remain prerequisites rather than being mistaken for skipped success', () =>
{
    const value = matrix();
    value.tiers.find(value => value.id === 'backend-unit').requiresEvidenceFrom = ['unaffected-runtime'];
    assert.ok(selectAffectedPrTiers(value, ['src/backend/Changed.cs']).selectedTierIds.includes('unaffected-runtime'));
});

test('workflow-only prerequisite is retained and undeclared prerequisite fails closed', () =>
{
    const dependencies = new Map([['fast-backend', new Set(['unaffected-runtime'])]]);
    assert.ok(selectAffectedPrTiers(matrix(), ['src/backend/Changed.cs'], { jobDependencies: dependencies })
        .selectedTierIds.includes('unaffected-runtime'));
    assert.throws(() => selectAffectedPrTiers(matrix(), ['src/backend/Changed.cs'],
        { jobDependencies: new Map([['fast-backend', new Set(['missing-job'])]]) }));
});

test('unknown dependency, dependency cycle and phase inversion fail before any execution', () =>
{
    for (const mutate of [
        value =>
        {
            value.tiers[0].executionDependsOn = ['missing'];
        },
        value =>
        {
            value.tiers[0].executionDependsOn = ['pr-smart-gate-plan'];
        },
        value =>
        {
            value.tiers[0].executionDependsOn = ['backend-unit'];
            value.tiers[6].phase = 2;
        }
    ])
    {
        const value = matrix();
        mutate(value);
        assert.ok(validateImpactDeclarations(value).length);
        assert.throws(() => selectAffectedPrTiers(value, ['docs/operations.md']));
    }
});

test('actual Git diff includes deleted paths and both sides of a rename, and missing base never becomes empty impact', () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pr-impact-'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    try
    {
        git('init', '-q');
        writeFileSync(path.join(root, 'old.mjs'), 'original complete source\n');
        writeFileSync(path.join(root, 'deleted.mjs'), 'original retained deletion scope\n');
        git('add', '.');
        git('-c', 'user.name=Source test', '-c', 'user.email=source-test@example.invalid', 'commit', '-qm', 'test(tooling): baseline');
        const base = git('rev-parse', 'HEAD');
        renameSync(path.join(root, 'old.mjs'), path.join(root, 'new.mjs'));
        rmSync(path.join(root, 'deleted.mjs'));
        git('add', '-A');
        git('-c', 'user.name=Source test', '-c', 'user.email=source-test@example.invalid', 'commit', '-qm', 'test(tooling): rename and deletion');
        const result = readGitChangedPaths(root, base);
        assert.deepEqual(result.changedFiles, ['deleted.mjs', 'new.mjs', 'old.mjs']);
        assert.equal(result.baseCommit, base);
        assert.equal(result.headCommit, git('rev-parse', 'HEAD'));
        assert.throws(() => readGitChangedPaths(root, 'refs/heads/absent'));
        writeFileSync(path.join(root, 'new.mjs'), 'uncommitted source drift\n');
        assert.throws(() => readGitChangedPaths(root, base), /clean committed source/u);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the original indexed dependency selects every actual consumer beyond broad path declarations', () =>
{
    const value = matrix();
    value.tiers.push(tier('static-governance', { ciJob: 'static-governance' }));
    const changed = 'tools/architecture/backend-physical-topology/audit-cache-modules.mjs';
    value.tiers.push(tier('frontend-static-governance', { triggerPaths: ['tools/**'] }));
    const authority = { targets: [{ target: 'tools/check-backend-physical-topology.mjs',
        owners: ['static-governance'], dependencyClosure: [changed] }] };
    const result = selectAffectedPrTiers(value, [changed], { executionAuthority: authority });
    assert.ok(result.selectedTierIds.includes('static-governance'));
    assert.ok(result.selectedTierIds.includes('frontend-static-governance'));
    authority.targets[0].owners = ['unknown-authority-owner'];
    assert.throws(() => selectAffectedPrTiers(value, [changed], { executionAuthority: authority }), /unknown tier owner/u);
});

test('consumers reject self-authored selection, stale source fingerprint and changed path evidence', () =>
{
    const evidence = { headCommit: 'actual-head', changedFiles: ['docs/operations.md'] };
    const expected = { evidence, actualFingerprint: 'actual-fingerprint',
        selectedTierIds: ['source-governance'], selectedJobs: ['source-governance'],
        callerContext: { baseRef: 'actual-base', eventName: 'pull_request', runId: 'real-run', runAttempt: '2', full: false } };
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const sign = value => ({ ...value, contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}` });
    const value = { ...expected.callerContext, fullMode: false, sourceState: { commit: 'actual-head', worktreeFingerprint: 'actual-fingerprint' },
        changedPathEvidence: evidence, selectedTierIds: expected.selectedTierIds, selectedJobs: expected.selectedJobs };
    assert.doesNotThrow(() => validatePrImpactPlanBinding(sign(value), expected));
    for (const mutate of [candidate =>
    {
        candidate.selectedTierIds = [];
    },
    candidate =>
    {
        candidate.sourceState.worktreeFingerprint = 'arbitrary-fingerprint';
    },
    candidate =>
    {
        candidate.changedPathEvidence.changedFiles = [];
    },
    candidate =>
    {
        candidate.selectedJobs = [];
    },
    candidate =>
    {
        candidate.baseRef = 'actual-head';
    },
    candidate =>
    {
        candidate.eventName = 'local';
    },
    candidate =>
    {
        candidate.runAttempt = '1';
    }])
    {
        const candidate = structuredClone(value);
        mutate(candidate);
        assert.throws(() => validatePrImpactPlanBinding(sign(candidate), expected));
    }
});

test('ordinary PR dependency owners do not automatically promote manual/nightly/local lanes', () =>
{
    const value = matrix();
    for (const flags of [{ manualOnly: true }, { nightlyOnly: true }, { localOnly: true }])
    {
        const id = Object.keys(flags)[0];
        value.tiers.push(tier(id, flags));
    }
    const owners = ['backend-unit', 'manualOnly', 'nightlyOnly', 'localOnly'];
    const executionAuthority = { targets: [{ target: 'tools/common.mjs', owners, dependencyClosure: ['tools/csharp-mask.mjs'] }] };
    const applicable = selectAffectedPrTiers(value, ['tools/csharp-mask.mjs'], { executionAuthority });
    for (const id of owners.slice(1))
    {
        assert.equal(applicable.selectedTierIds.includes(id), false, id);
        assert.equal(selectAffectedPrTiers(value, ['unknown.txt']).selectedTierIds.includes(id), false, id);
        assert.equal(selectAffectedPrTiers(value, [], { full: true }).selectedTierIds.includes(id), true, id);
    }
    value.tiers.find(row => row.id === 'backend-unit').executionDependsOn.push('manualOnly');
    assert.ok(selectAffectedPrTiers(value, ['tools/csharp-mask.mjs'], { executionAuthority }).selectedTierIds.includes('manualOnly'));
});

test('CI cannot consume a re-sealed file in place of the original planner output authority', () =>
{
    assert.throws(() => prImpactCallerContext({ GITHUB_ACTIONS: 'true' }), /original planner/u);
    assert.equal(prImpactCallerContext({ GITHUB_ACTIONS: 'true', FSUSBLOG_PR_PLAN_DIGEST: 'original-digest',
        GITHUB_EVENT_NAME: 'push', FSUSBLOG_BASE_REF: 'actual-base' }).eventName, 'push');
});

test('local complete workflow cannot start compiled matrix setup before successful BehaviorDoc admission', async () =>
{
    const { runLocalWorkflow } = await import(new URL('../../tools/test-matrix/local-workflow-runner.mjs', import.meta.url));
    let compiledSetupCalls = 0;
    const dependencies = {
        parseCiJobOptions: () => ({}), buildAggregatePlan: () => ({ dependencyJobs: ['validate-matrix'] }),
        buildCiPlan: () => ({ jobs: [{ id: 'validate-matrix', needs: [] }] }),
        tierMap: () => new Map([['validate-matrix', tier('validate-matrix')]]),
        createRunId: () => 'isolated-control', collectSchedulerSourceState: async () => ({ sourceState: {} }),
        executeStaticMatrixPrerequisite: () =>
        {
            compiledSetupCalls += 1;
        },
        establishBehaviorDocAdmission: async () =>
        {
            throw new Error('original admission refused');
        }
    };
    await assert.rejects(runLocalWorkflow({ matrix: matrix(), aggregateJobId: 'fast-summary', args: [],
        behaviorDocAdmissionTierId: 'behavior-doc-static-admission', dependencies }), /original admission refused/u);
    assert.equal(compiledSetupCalls, 0);
});

test('explicit local full intent survives the real child caller environment', () =>
{
    const parent = prImpactCallerContext({}, { baseRef: 'actual-base', eventName: 'local', full: true, expectedDigest: 'original-digest' });
    const child = prImpactCallerContext(prImpactConsumerEnvironment(parent));
    assert.equal(child.full, true);
    assert.equal(child.baseRef, parent.baseRef);
    assert.equal(child.expectedDigest, parent.expectedDigest);
    assert.equal(prImpactCallerContext(prImpactConsumerEnvironment({ ...parent, full: false })).full, false);
});

test('compiled matrix prerequisite rejects absent admission before any command starts', async () =>
{
    const { executeStaticMatrixPrerequisite, prepareNamespaceEnvironmentIfNeeded } = await import(new URL('../../tools/run-test-matrix.mjs', import.meta.url));
    assert.throws(() => executeStaticMatrixPrerequisite({ id: 'validate-matrix', command: 'exit 99' },
        { runId: 'real-local-run', sourceState: { commit: 'actual', worktreeFingerprint: 'actual' } }),
    /BehaviorDoc static admission state is incomplete/u);
    assert.throws(() => prepareNamespaceEnvironmentIfNeeded([{ selfBootstraps: true }], 'isolated', {}),
        /namespace pre-bootstrap requires scheduler run source and production build identity/u);
});

test('actual source checker dependency changes select the mandatory source governance owner', async () =>
{
    const { sourceGovernanceChildEntries, sourceGovernanceExecutionTarget } = await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
    const executionAuthority = { targets: [{ target: sourceGovernanceExecutionTarget, owners: ['source-governance'],
        dependencyClosure: [...Object.values(sourceGovernanceChildEntries), 'tools/shared/child-input.mjs'] }] };
    for (const file of [...Object.values(sourceGovernanceChildEntries), 'tools/shared/child-input.mjs'])
    {
        assert.ok(selectAffectedPrTiers(matrix(), [file], { executionAuthority }).selectedTierIds.includes('source-governance'), file);
    }
});


test('explicit source integration executes source gates and real declared regressions without issuing product qualification', () =>
{
    const value = matrix();
    const result = selectAffectedPrTiers(value, ['tools/test-matrix/pr-impact-plan.mjs'], { stage: 'source-integration' });
    assert.deepEqual(result.selectedTierIds, ['pr-smart-gate-plan', 'source-governance', 'validate-declarations']);
    assert.deepEqual(result.sourceRegressionTargets, [...sourceRegressionEntries]);
    assert.ok(result.deferredQualificationTierIds.includes('backend-build'));
    assert.deepEqual(result.fullQualificationTierIds, value.tiers.map(tier => tier.id).sort());
    assert.equal(result.fullMode, false);
    const ordinary = selectAffectedPrTiers(value, ['src/backend/Changed.cs'], { stage: 'source-integration' });
    assert.ok(ordinary.deferredQualificationTierIds.includes('backend-build'));
    assert.deepEqual(ordinary.sourceRegressionTargets, []);
    // Unknown source is retained as full deferred qualification, never declared
    // passed and never used as authority to execute an unknown runtime command.
    const unknown = selectAffectedPrTiers(value, ['unknown/runtime.sh'], { stage: 'source-integration' });
    assert.ok(unknown.deferredQualificationTierIds.includes('unaffected-runtime'));
    assert.throws(() => selectAffectedPrTiers(value, [], { stage: 'unregistered' }), /unknown PR execution stage/u);
});

test('full, push and release callers cannot be downgraded by source stage or mixed caller authority', () =>
{
    for (const context of [
        { stage: 'source-integration', full: true, eventName: 'local' },
        { stage: 'source-integration', full: false, eventName: 'push' },
        { stage: 'source-integration', full: false, eventName: 'workflow_dispatch' }
    ])
    {
        assert.equal(effectivePrExecutionStage(context), 'qualification');
        assert.equal(prImpactConsumerEnvironment(context).FSUSBLOG_CI_STAGE, 'qualification');
    }
    const full = selectAffectedPrTiers(matrix(), [], { stage: 'source-integration', full: true });
    assert.deepEqual(full.selectedTierIds, matrix().tiers.map(tier => tier.id).sort());
    const release = prImpactCallerContext({ FSUSBLOG_RELEASE_FINAL: '1', FSUSBLOG_CI_STAGE: 'source-integration' });
    assert.equal(effectivePrExecutionStage(release), 'qualification');
    assert.throws(() => prImpactCallerContext({ FSUSBLOG_CI_STAGE: 'qualification' },
        { stage: 'source-integration' }), /independent caller environment/u);
});

test('re-sealing stage, regression or deferred qualification claims cannot change the independent source plan', () =>
{
    const evidence = { headCommit: 'actual-head', changedFiles: ['tools/test-matrix/pr-impact-plan.mjs'] };
    const selection = selectAffectedPrTiers(matrix(), evidence.changedFiles, { stage: 'source-integration' });
    const callerContext = { baseRef: 'actual-base', eventName: 'pull_request', runId: 'real-run', runAttempt: '2',
        stage: 'source-integration', full: false };
    const expected = { evidence, actualFingerprint: 'actual-fingerprint', callerContext,
        selectedTierIds: selection.selectedTierIds, selectedJobs: selection.selectedTierIds,
        deferredQualificationTierIds: selection.deferredQualificationTierIds,
        fullQualificationTierIds: selection.fullQualificationTierIds };
    const value = { ...callerContext, executionStage: 'source-integration', fullMode: false,
        sourceState: { commit: evidence.headCommit, worktreeFingerprint: expected.actualFingerprint },
        changedPathEvidence: evidence, selectedTierIds: expected.selectedTierIds, selectedJobs: expected.selectedJobs,
        sourceRegressionTargets: selection.sourceRegressionTargets,
        deferredQualificationTierIds: selection.deferredQualificationTierIds, fullQualificationTierIds: selection.fullQualificationTierIds };
    const canonical = object => Array.isArray(object) ? object.map(canonical) : object && typeof object === 'object'
        ? Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])])) : object;
    const sign = object => ({ ...object, contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(canonical(object))).digest('hex')}` });
    assert.doesNotThrow(() => validatePrImpactPlanBinding(sign(value), expected));
    for (const field of ['sourceRegressionTargets', 'deferredQualificationTierIds', 'fullQualificationTierIds', 'executionStage'])
    {
        const candidate = structuredClone(value);
        candidate[field] = field === 'executionStage' ? 'qualification' : [];
        assert.throws(() => validatePrImpactPlanBinding(sign(candidate), expected), field);
    }
    const qualificationCaller = { ...callerContext, stage: 'qualification' };
    assert.throws(() => validatePrImpactPlanBinding(sign(value), { ...expected, callerContext: qualificationCaller }));
});


test('the real stage option parser refuses malformed explicit intent before any execution', () =>
{
    const source = readFileSync(new URL('../../tools/run-test-matrix.mjs', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function parsePrSmartGateOptions(args)'), source.indexOf('function summaryAuthorityJobIds()'));
    const parse = vm.runInNewContext(`(() => { ${body}; return parsePrSmartGateOptions; })()`,
        { process: { env: {} }, effectivePrExecutionStage });
    for (const argv of [['--stage'], ['--stage', '--full'], ['--stage='], ['--stage=unknown']])
    {
        assert.throws(() => parse(argv), /--stage requires/u);
    }
    assert.equal(parse(['--stage', 'source-integration']).stage, 'source-integration');
    assert.equal(parse([]).stage, 'qualification');
    const mixed = vm.runInNewContext(`(() => { ${body}; return parsePrSmartGateOptions; })()`,
        { process: { env: { FSUSBLOG_CI_STAGE: 'qualification' } }, effectivePrExecutionStage });
    assert.throws(() => mixed(['--stage=source-integration']), /independent caller environment/u);
});


test('source integration explicitly refuses every unregistered source surface rather than silently skipping unknown languages', () =>
{
    const unknown = ['tools/runtime.lua', 'tools/runtime.rb', 'src/Test.fs', 'tests/Test.csx',
        'scripts/extensionless', 'docs/runtime.input', 'tools/Build.props', 'tests/input.bin', 'tools/contracts/Unknown.slnx'];
    assert.deepEqual(unsupportedSourceStageFiles(unknown), unknown);
    assert.deepEqual(unsupportedSourceStageFiles(['docs/testing.md', 'tools/check.mjs', 'src/Test.cs',
        'tests/matrix.yml', 'config/source.json', '.gitignore']), []);
    assert.deepEqual(unsupportedSourceStageFiles(['tools/contracts/Unknown.slnx'], ['other.slnx']), ['tools/contracts/Unknown.slnx']);
    assert.deepEqual(unsupportedSourceStageFiles(['tools/contracts/Unknown.slnx'], ['tools/contracts/Unknown.slnx']), []);
});

test('C++ suffixes remain unsupported until their actual compiler context succeeds and controls are selected', async () =>
{
    const files = ['src/Example.cpp', 'src/Value.hpp', 'src/Other.hpp', 'src/Unsupported.c'];
    assert.deepEqual(unsupportedSourceStageFiles(files), files);
    assert.deepEqual(unsupportedSourceStageFiles(files, [], [], null, ['src/Example.cpp', 'src/Value.hpp']), files.slice(2));
    const { sourceGovernanceChildEntries, selectSourceRegressionTargets, sourceRegressionArguments } =
        await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
    assert.equal(sourceGovernanceChildEntries.cpp, 'tools/configuration/check-cpp-source.mjs');
    assert.deepEqual(selectSourceRegressionTargets(['src/Value.hpp']), ['tools/configuration/cpp-source.test.mjs']);
    assert.ok(selectSourceRegressionTargets([sourceGovernanceChildEntries.cpp]).includes('tools/configuration/cpp-source.test.mjs'));
    assert.ok(selectSourceRegressionTargets(['src/frontend/wasm/aeds/include/font_theme_admin_pods.hpp'])
        .includes('tools/configuration/wasm-cpp-source.test.mjs'));
    assert.ok(!selectSourceRegressionTargets(['tools/frontend/check-frontend-style.mjs'])
        .includes('tools/configuration/wasm-cpp-source.test.mjs'));
    const nativeArguments = sourceRegressionArguments('tests/tools/native-tooling-style.test.mjs');
    const selectedNativeControl = new RegExp(nativeArguments[1].slice('--test-name-pattern='.length));
    for (const control of ['rejects unnamed C++ parameter type facts', 'records typedef and imported type shadows',
        'recognizes commented preprocessor boundaries', 'preserves quoted constructor argument tokens',
        'rejects incorrectly named real C++ declarations', 'keeps ambiguous C++ parameter syntax strict',
        'header classification retains required external tools'])
    {
        assert.ok(selectedNativeControl.test(`native tooling style governance ${control}`));
    }
    assert.equal(selectedNativeControl.test('unregistered native checker audit'), false);
});

test('flat solution checker and its refusal controls are explicit source execution ports', async () =>
{
    const { sourceGovernanceChildEntries, sourceGovernanceExecutableEntries, selectSourceRegressionTargets } =
        await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
    assert.equal(sourceGovernanceChildEntries.solution, 'tools/configuration/check-solution-source.mjs');
    assert.equal(sourceGovernanceExecutableEntries().length, 15);
    assert.ok(sourceGovernanceExecutableEntries().includes('tools/configuration/solution-source.test.mjs'));
    assert.deepEqual(selectSourceRegressionTargets(['tools/contracts/Example.slnx']), ['tools/configuration/solution-source.test.mjs']);
    assert.ok(selectSourceRegressionTargets([sourceGovernanceChildEntries.solution]).includes('tools/configuration/solution-source.test.mjs'));
});

test('existing plan reuse receives independent explicit caller options instead of defaulting stage from the plan', async () =>
{
    const source = readFileSync(new URL('../../tools/run-test-matrix.mjs', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function ciPrPlan(matrix, args)'), source.indexOf('async function ciPrSmart(matrix, args)'));
    const options = { baseRef: 'actual-base', eventName: 'pull_request', full: false, stage: 'source-integration' };
    const environment = { FSUSBLOG_CI_PR_SMART_GATE_PLAN: 'old-plan', FSUSBLOG_PR_PLAN_DIGEST: 'original-digest' };
    let received;
    const execute = vm.runInNewContext(`(() => { ${body}; return ciPrPlan; })()`,
        { process: { env: environment }, parsePrSmartGateOptions: () => options,
            prImpactCallerContext, isFullSmartGateMode: value => value.full,
            loadSelectedTierIds: async (_matrix, _file, context) =>
            {
                received = context;
                throw new Error('independent context refusal before old plan output');
            } });
    await assert.rejects(execute({}, []), /independent context refusal/u);
    assert.equal(received.baseRef, options.baseRef);
    assert.equal(received.eventName, options.eventName);
    assert.equal(received.stage, options.stage);
    assert.equal(received.expectedDigest, environment.FSUSBLOG_PR_PLAN_DIGEST);
});


test('the fixed shell source port checks syntax without executing the script and refuses command-shaped inputs', () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'shell-source-syntax-'));
    try
    {
        const file = 'source.sh';
        writeFileSync(path.join(root, file), 'echo unsafe > should-not-exist\n');
        execFileSync('bash', sourceShellSyntaxArguments(file), { cwd: root });
        assert.equal(existsSync(path.join(root, 'should-not-exist')), false);
        writeFileSync(path.join(root, file), 'if then\n');
        assert.throws(() => execFileSync('bash', sourceShellSyntaxArguments(file), { cwd: root, stdio: 'pipe' }));
        for (const invalid of ['/outside.sh', '../outside.sh', '-c.sh', 'source.sh\nother', 'source.mjs'])
        {
            assert.throws(() => sourceShellSyntaxArguments(invalid), /repository-relative/u);
        }
        assert.deepEqual(unsupportedSourceStageFiles([file]), []);
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});


test('shell syntax cannot treat refused or missing source identities as stable input proof', () =>
{
    const valid = { errors: [], contentDigest: `sha256:${'a'.repeat(64)}`, indexDigest: `sha256:${'b'.repeat(64)}` };
    assert.doesNotThrow(() => assertSourceShellSyntaxInspection(valid));
    for (const input of [{ ...valid, errors: ['repository index drift'] },
        { ...valid, contentDigest: null }, { ...valid, indexDigest: null }, {}])
    {
        assert.throws(() => assertSourceShellSyntaxInspection(input), /inspection refused/u);
    }
});

function frontendRoutingFixture(t)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-source-frontend-routing-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const write = (file, content) =>
    {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), content);
    };
    const commit = () =>
    {
        git('add', '-A');
        git('-c', 'user.name=Source test', '-c', 'user.email=source-test@example.invalid', 'commit', '-qm', 'test(tooling): frontend routing fixture');
    };
    git('init', '-q');
    const policy = { configurationSources: ['tools/frontend/check-frontend-style.mjs', 'config/extra.json'],
        ruleRegistry: sourceFrontendDataInputs[1],
        toolchain: { package: sourceFrontendDataInputs[2], lock: sourceFrontendDataInputs[3] },
        eslintConfig: 'eslint.config.mjs', stylelintConfig: 'stylelint.config.mjs' };
    for (const file of [...sourceFrontendDataInputs, ...policy.configurationSources])
    {
        write(file, '{}\n');
    }
    write(sourceFrontendDataInputs[0], JSON.stringify(policy));
    const files = ['tools/check.mjs', 'src/code.js', 'src/code.cjs', 'src/code.ts', 'src/code.tsx', 'src/view.vue', 'src/theme.css', 'src/theme.scss'];
    for (const file of files)
    {
        write(file, 'original source\n');
    }
    commit();
    const base = git('rev-parse', 'HEAD');
    for (const file of files)
    {
        write(file, 'changed source\n');
    }
    commit();
    return { root, base, files, policy, write, commit, actual: () => readGitChangedPaths(root, base).changedFiles.filter(file => existsSync(path.join(root, file))) };
}

test('SOURCE frontend routing retains source-diff only with complete unchanged actual configuration', t =>
{
    const { root, base, files } = frontendRoutingFixture(t);
    const configuration = inspectSourceFrontendConfiguration(root, base);
    assert.equal(configuration.changed, false);
    assert.ok(configuration.identities.some(value => value.file === 'config/extra.json'));
    const groups = sourceFrontendCheckGroups(files, 'source-integration', base, root);
    assert.deepEqual(groups[0], { options: ['--mode', 'source-diff', '--base', base], files: files.slice(0, 3) });
    assert.deepEqual(groups[1], { options: ['--mode', 'strict-full'], files: files.slice(3) });
    assert.deepEqual(sourceFrontendCheckGroups(files, 'qualification', base),
        [{ options: ['--mode', 'strict-full'], files }]);
});

test('SOURCE configuration drift dispatches every applicable changed input through strict-full without exemptions', t =>
{
    const fixture = frontendRoutingFixture(t);
    fixture.write('config/extra.json', '{"changed":true}\n');
    fixture.commit();
    const files = fixture.actual();
    assert.equal(inspectSourceFrontendConfiguration(fixture.root, fixture.base).changed, true);
    assert.deepEqual(sourceFrontendCheckGroups(files, 'source-integration', fixture.base, fixture.root),
        [{ options: ['--mode', 'strict-full'], files: files.filter(file => file !== 'config/extra.json') }]);
});

test('SOURCE detects drift in every actual configuration input, including the checker and fixed data inputs', t =>
{
    const roster = frontendRoutingFixture(t);
    const files = inspectSourceFrontendConfiguration(roster.root, roster.base).identities.map(value => value.file);
    for (const file of files)
    {
        const fixture = frontendRoutingFixture(t);
        fixture.write(file, `${readFileSync(path.join(fixture.root, file), 'utf8')}\n`);
        fixture.commit();
        const configuration = inspectSourceFrontendConfiguration(fixture.root, fixture.base);
        assert.equal(configuration.changed, true, file);
        assert.deepEqual(configuration.identities.filter(value => value.baseDigest !== value.currentDigest).map(value => value.file), [file]);
        const changed = fixture.actual();
        assert.deepEqual(sourceFrontendCheckGroups(changed, 'source-integration', fixture.base, fixture.root),
            [{ options: ['--mode', 'strict-full'], files: changed.filter(value => /\.(?:mjs|js|cjs|ts|tsx|vue|css|scss)$/u.test(value)) }]);
    }
});

test('SOURCE compares the union of actual base and current policy inputs including added configuration', t =>
{
    const fixture = frontendRoutingFixture(t);
    fixture.policy.configurationSources = ['tools/frontend/check-frontend-style.mjs', 'config/added.json'];
    fixture.write(sourceFrontendDataInputs[0], JSON.stringify(fixture.policy));
    fixture.write('config/added.json', '{}\n');
    fixture.commit();
    const configuration = inspectSourceFrontendConfiguration(fixture.root, fixture.base);
    assert.equal(configuration.changed, true);
    assert.ok(configuration.identities.some(value => value.file === 'config/extra.json'));
    assert.ok(configuration.identities.some(value => value.file === 'config/added.json' && value.baseDigest === null));
    assert.deepEqual(sourceFrontendCheckGroups(fixture.actual(), 'source-integration', fixture.base, fixture.root)[0].options,
        ['--mode', 'strict-full']);
});

test('SOURCE refuses omitted changed inputs under both unchanged and changed configuration', t =>
{
    const fixture = frontendRoutingFixture(t);
    for (const drift of [false, true])
    {
        if (drift)
        {
            fixture.write('config/extra.json', '{"changed":true}\n');
            fixture.commit();
        }
        for (const omitted of fixture.actual())
        {
            assert.throws(() => sourceFrontendCheckGroups(fixture.actual().filter(file => file !== omitted),
                'source-integration', fixture.base, fixture.root), /complete actual changed-source scope/u);
        }
    }
});

test('SOURCE refuses absent, nonregular, untracked and malformed configuration instead of claiming unchanged identity', t =>
{
    for (const scenario of ['absent', 'symlink', 'untracked', 'malformed', 'invalid-path'])
    {
        const fixture = frontendRoutingFixture(t);
        if (scenario === 'absent' || scenario === 'symlink')
        {
            rmSync(path.join(fixture.root, 'config/extra.json'));
            if (scenario === 'symlink')
            {
                symlinkSync('../eslint.config.mjs', path.join(fixture.root, 'config/extra.json'));
            }
        }
        else if (scenario === 'untracked')
        {
            fixture.policy.configurationSources.push('config/untracked.json');
            fixture.write(sourceFrontendDataInputs[0], JSON.stringify(fixture.policy));
            fixture.commit();
            fixture.write('config/untracked.json', '{}\n');
        }
        else if (scenario === 'malformed')
        {
            fixture.policy.configurationSources = null;
            fixture.write(sourceFrontendDataInputs[0], JSON.stringify(fixture.policy));
        }
        else
        {
            fixture.policy.configurationSources.push('../escaped.json');
            fixture.write(sourceFrontendDataInputs[0], JSON.stringify(fixture.policy));
        }
        assert.throws(() => inspectSourceFrontendConfiguration(fixture.root, fixture.base),
            /tracked regular input|nonregular or escaped input|complete policy input set|invalid input path/u);
    }
    const fixture = frontendRoutingFixture(t);
    assert.throws(() => sourceFrontendCheckGroups(fixture.files, 'source-integration', 'HEAD^', fixture.root), /exact base commit/u);
    assert.throws(() => sourceFrontendCheckGroups(fixture.files, 'source-integration', fixture.base), /actual repository/u);
});

test('Python SOURCE syntax uses the existing isolated checker and only verified inputs escape unsupported', async () =>
{
    const { sourceGovernanceChildEntries, sourceGovernanceExecutableEntries, selectSourceRegressionTargets } =
        await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
    assert.equal(sourceGovernanceChildEntries.solution, 'tools/configuration/check-solution-source.mjs');
    assert.ok(sourceGovernanceExecutableEntries().includes(sourceGovernanceChildEntries.solution));
    assert.deepEqual(unsupportedSourceStageFiles(['tests/helpers/Example.py']), ['tests/helpers/Example.py']);
    assert.deepEqual(unsupportedSourceStageFiles(['tests/helpers/Example.py'], [], ['tests/helpers/Foreign.py']), ['tests/helpers/Example.py']);
    assert.deepEqual(unsupportedSourceStageFiles(['tests/helpers/Example.py'], [], ['tests/helpers/Example.py']), []);
    assert.ok(selectSourceRegressionTargets(['tests/helpers/Example.py']).includes('tools/configuration/solution-source.test.mjs'));
});
