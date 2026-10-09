import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { analyzeRuntimeStateOperations, analyzeRuntimeStepCommand, validateRuntimeStateDomainCatalog } = await import(new URL('../../tools/test-matrix/runtime-state-domain-catalog.mjs', import.meta.url));
const { runtimeSteps } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(root, 'config/testing/runtime-state-domain-catalog.json');

function mutate(change)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'runtime-state-condition-'));
    const catalog = JSON.parse(readFileSync(source));
    change(catalog);
    const file = path.join(directory, 'catalog.json');
    writeFileSync(file, JSON.stringify(catalog));
    return [directory, file];
}

function conditionalFixtureFinding(options = {})
{
    const step = runtimeSteps().find((candidate) => candidate.id === 'resilience');
    const analysis = analyzeRuntimeStepCommand(step, options);
    assert.deepEqual(analysis.resolutionErrors, []);
    return analysis.findings.find((finding) => finding.source.endsWith('#InvokeLaneFixtureOrchestrator')
        && finding.operation === 'creates' && finding.domain === 'fixture.public-content');
}

test('conditional public-content operations retain all source guards for both real callers', () =>
{
    for (const id of ['security-runtime-core', 'resilience'])
    {
        const analysis = analyzeRuntimeStepCommand(runtimeSteps().find((step) => step.id === id));
        const finding = analysis.findings.find((item) => item.source.endsWith('#InvokeLaneFixtureOrchestrator')
            && item.operation === 'creates' && item.domain === 'fixture.public-content');
        assert.ok(finding, id);
        assert.equal(finding.line, 17);
        assert.equal(finding.matcher, 'mkdir -p "$fixtureRoot"');
        assert.equal(finding.conditionState, 'unknown');
        assert.equal(finding.conditions.length, 1);
        assert.deepEqual(finding.conditions[0].predicate, { all: [
            { operand: { parameter: 'FSUSBLOG_FIXTURE_PROFILE_SOURCE', fallback: 'matrix' }, equals: 'matrix' },
            { operand: { parameter: 'FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID', fallback: '' }, nonempty: true },
            { any: [
                { operand: { parameter: 'FSUSBLOG_SEALED_FIXTURE_PROFILE_ID', fallback: null }, equals: 'public-content-lifecycle' },
                { operand: { parameter: 'FSUSBLOG_SEALED_FIXTURE_PROFILE_ID', fallback: null }, equals: 'runtime-cache-pagination' }
            ] }
        ] });
        assert.ok(analysis.domains.includes('fixture.public-content'));
    }
});

test('explicit conditional facts never remove the original fixture operation', () =>
{
    const environment = {
        FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'matrix',
        FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: 'ordinary-control',
        FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'public-content-lifecycle'
    };
    for (const profile of ['public-content-lifecycle', 'runtime-cache-pagination'])
    {
        const finding = conditionalFixtureFinding({ conditionEnvironment: {
            ...environment, FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: profile
        } });
        assert.equal(finding.conditionState, 'true');
    }
    for (const override of [
        { FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'dev-cli' },
        { FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: '' },
        { FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'auth-security-matrix' },
        { FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'acceptance-representative' }
    ])
    {
        const finding = conditionalFixtureFinding({ conditionEnvironment: { ...environment, ...override } });
        assert.equal(finding.conditionState, 'false');
        assert.equal(finding.operation, 'creates');
    }
    for (const missing of Object.keys(environment))
    {
        const incomplete = { ...environment };
        delete incomplete[missing];
        assert.equal(conditionalFixtureFinding({ conditionEnvironment: incomplete }).conditionState, 'unknown');
    }
    assert.equal(conditionalFixtureFinding({ conditionEnvironment: {
        ...environment, FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: ''
    } }).conditionState, 'unknown');
});

test('unknown and changed guards preserve create seed probe and cleanup observations', () =>
{
    const sourceText = [
        'local profileSource="${FSUSBLOG_FIXTURE_PROFILE_SOURCE:-matrix}"',
        'local profileId="${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:-${1:-}}"',
        'if [[ "$profileSource" == "matrix" && -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" &&',
        '    ("$profileId" == "public-content-lifecycle" || "$profileId" == "runtime-cache-pagination") ]]; then',
        'mkdir -p "$fixtureRoot"',
        'psql -c "INSERT INTO article_fixture VALUES (1)"',
        'curl /fixture/probe',
        'rm -rf "$fixtureRoot"',
        'fi',
        'mkdir -p "$fixtureRoot"'
    ].join('\n');
    const unknown = analyzeRuntimeStateOperations(sourceText, 'tools/test/ordinary-control.sh');
    for (const operation of ['creates', 'reads', 'deletes'])
    {
        assert.ok(unknown.some((finding) => finding.operation === operation && finding.conditionState === 'unknown'));
    }
    assert.ok(unknown.some((finding) => finding.domain === 'postgres.article' && finding.operation === 'creates'));
    assert.equal(unknown.find((finding) => finding.line === 10).conditions, undefined);
    const changed = analyzeRuntimeStateOperations(sourceText.replace('"matrix" &&', '"matrix" ||'),
        'tools/test/ordinary-control.sh', { conditionEnvironment: {
            FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'dev-cli',
            FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: '',
            FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'auth-security-matrix'
        } });
    assert.equal(changed.find((finding) => finding.line === 5).conditionState, 'unknown');
    assert.deepEqual(changed.map(({ operation, domain, line }) => ({ operation, domain, line })),
        unknown.map(({ operation, domain, line }) => ({ operation, domain, line })));
    const alternative = analyzeRuntimeStateOperations(sourceText.replace('fi\nmkdir', 'else\nmkdir'),
        'tools/test/ordinary-control.sh');
    assert.equal(alternative.find((finding) => finding.line === 10).conditionState, 'unknown');
    const currentLiteral = analyzeRuntimeStateOperations(sourceText.replace('"public-content-lifecycle"', '"ordinary-other-profile"'),
        'tools/test/ordinary-control.sh', { conditionEnvironment: {
            FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'matrix',
            FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: 'ordinary-control',
            FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'public-content-lifecycle'
        } });
    assert.equal(currentLiteral.find((finding) => finding.line === 5).conditionState, 'false');
});

test('conditional annotations cannot grant undeclared operation permission', () =>
{
    const [directory, file] = mutate((data) =>
    {
        const entry = data.steps.find((item) => item.stepId === 'resilience');
        entry.reads = entry.reads.filter((domain) => domain !== 'fixture.public-content');
    });
    try
    {
        // This refusal fixture analyzes only these two actual commands, with
        // no reset or ancestry fixture. It never produces a runtime receipt.
        const catalog = JSON.parse(readFileSync(file));
        const selected = runtimeSteps().filter((step) => ['security-runtime-core', 'resilience'].includes(step.id));
        catalog.steps = catalog.steps.filter((entry) => selected.some((step) => step.id === entry.stepId));
        for (const entry of catalog.steps)
        {
            entry.resetBefore = [];
            entry.requiredPredecessors = [];
        }
        writeFileSync(file, JSON.stringify(catalog));
        const errors = validateRuntimeStateDomainCatalog(file, selected, { conditionEnvironment: {
            FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'dev-cli',
            FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: '',
            FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'auth-security-matrix'
        } });
        assert.ok(errors.some((error) => error.includes('resilience analyzer detected undeclared creates fixture.public-content')
            && error.includes('conditional=false')));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
