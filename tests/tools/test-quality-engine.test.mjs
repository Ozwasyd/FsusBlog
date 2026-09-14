import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {buildOracleFacts} = await import(new URL('../../tools/test-quality/oracle-facts.mjs', import.meta.url));
const {buildQualityArtifact, validateQualityArtifact, verifyQualityArtifact} = await import(new URL('../../tools/test-quality/artifact.mjs', import.meta.url));
const {evaluateQuality, loadQualityPolicy, qualityRuleIds, validateQualityPolicy} = await import(new URL('../../tools/test-quality/policy.mjs', import.meta.url));
const {contentDigest, validateOracleFacts} = await import(new URL('../../tools/test-quality/schema.mjs', import.meta.url));
const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const digest = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const policy = loadQualityPolicy(repositoryRoot);

function sourceSpan(source, snippet = source)
{
    const start = source.indexOf(snippet);
    assert.notEqual(start, -1, `snippet must exist: ${snippet}`);
    return {
        start: { line: 1, column: start + 1 },
        end: { line: 1, column: start + snippet.length + 1 }
    };
}

function fixtureCase({
    id,
    source,
    snippet,
    adapter = 'vitest',
    matcher = 'toBe',
    assembly = adapter === 'playwright' ? '@playwright/test' : adapter === 'vitest' ? 'vitest' : 'node:assert/strict',
    containingType = 'expect(actual)',
    returnStatements = [],
    displayName = id,
    identity = 'static',
    testInvocations = [],
    traits = [],
    productionCalls = true
})
{
    const ownerFile = `tests/quality-corpus/${id.replaceAll(':', '-')}.${adapter === 'xunit' ? 'cs' : 'test.mjs'}`;
    const location = snippet ? sourceSpan(source, snippet) : sourceSpan(source);
    const invocations = [];
    if (productionCalls)
    {
        invocations.push({
            methodName: 'Load',
            containingType: 'ProductionSubject',
            assembly: 'src/subject',
            assemblyKind: 'production',
            callsTestMethod: false,
            location
        });
    }
    for (const invocation of testInvocations)
    {
        invocations.push({
            methodName: invocation,
            containingType: 'FixtureTests',
            assembly: 'fixture-tests',
            assemblyKind: 'test',
            callsTestMethod: true,
            calledTestMethodId: `test:${invocation}`,
            location
        });
    }
    return {
        source,
        sourceFile: {
            path: ownerFile,
            adapter,
            adapterVersion: `${adapter}.fixture`,
            kind: 'discoverable-test',
            sourceDigest: digest(source),
            declaredBy: ['directory'],
            caseIdentity: {
                mode: identity,
                owner: `${adapter}-adapter`,
                extractionStatus: 'ready',
                inventoryObligation: 'fixture case extraction'
            }
        },
        testCase: {
            id,
            displayName,
            kind: identity === 'dynamic' ? 'dynamic-each' : 'test',
            identity,
            ownerFile,
            ownerClass: 'FixtureTests',
            ownerSuite: 'fixture',
            methodName: id,
            adapter,
            sourceSpan: sourceSpan(source),
            bodySpan: sourceSpan(source),
            bodySource: source,
            traits,
            dynamicCaseInfo: identity === 'dynamic' ? {
                generationLocation: `${ownerFile}:1`,
                inventoryObligation: 'runtime evidence must enumerate dynamic fixture cases'
            } : undefined,
            methodFacts: {
                invocations,
                assertionCandidates: snippet ? [{
                    methodName: matcher,
                    containingType,
                    assembly,
                    assemblyKind: assembly.startsWith('src/') ? 'production' : 'test-framework',
                    callsTestMethod: false,
                    location
                }] : [],
                returnStatements,
                productionSymbolReferences: invocations.filter((call) => call.assemblyKind === 'production'),
                testAttributeReferences: []
            }
        }
    };
}

function inventory(fixtures)
{
    return {
        schema: 'fsusblog.test-inventory.v1',
        adapterVersion: 'fixture-adapters.v1',
        inventoryDigest: digest(fixtures.map((fixture) => fixture.source).join('\n')),
        sourceState: { commit: '0'.repeat(40), worktreeFingerprint: '0'.repeat(64) },
        discoverySources: { directories: [], toolsDirectories: [], matrixTiers: [], coverageEntries: [], requirementProfiles: [] },
        sourceFiles: fixtures.map((fixture) => fixture.sourceFile),
        testCases: fixtures.map((fixture) => fixture.testCase),
        suiteRecords: [],
        diagnostics: []
    };
}

function analyze(fixtures, { membershipByTestId = new Map() } = {})
{
    const canonical = inventory(fixtures);
    const sources = new Map(fixtures.map((fixture) => [fixture.sourceFile.path, fixture.source]));
    const facts = buildOracleFacts(canonical, { sourceReader: (file) => sources.get(file) });
    return {
        canonical,
        facts,
        result: evaluateQuality({ inventory: canonical, oracleFacts: facts, policy, membershipByTestId })
    };
}

test('oracle facts preserve resolved operands for xUnit, FluentAssertions, Vitest, Playwright and Node assert APIs', () =>
{
    const fixtures = [
        fixtureCase({ id: 'xunit-equal', adapter: 'xunit', source: 'Assert.Equal(expected, actual);', snippet: 'Assert.Equal(expected, actual)', matcher: 'Equal', assembly: 'xunit.assert', containingType: 'Xunit.Assert' }),
        fixtureCase({ id: 'fluent-be', adapter: 'xunit', source: 'actual.Should().Be(expected);', snippet: 'actual.Should().Be(expected)', matcher: 'Be', assembly: 'FluentAssertions', containingType: 'FluentAssertions.NumericAssertions' }),
        fixtureCase({ id: 'vitest-equal', source: 'expect(actual).toEqual(expected);', snippet: 'expect(actual).toEqual(expected)', matcher: 'toEqual' }),
        fixtureCase({ id: 'playwright-match', adapter: 'playwright', source: 'expect(actual).toMatch(expected);', snippet: 'expect(actual).toMatch(expected)', matcher: 'toMatch' }),
        ...['equal', 'deepEqual', 'match', 'throws', 'rejects'].map((matcher) => fixtureCase({
            id: `node-${matcher}`,
            adapter: 'node-test',
            source: `assert.${matcher}(actual, expected);`,
            snippet: `assert.${matcher}(actual, expected)`,
            matcher
        }))
    ];
    const { facts } = analyze(fixtures);
    validateOracleFacts(facts);
    const byId = new Map(facts.cases.map((item) => [item.testId, item]));
    assert.equal(byId.get('xunit-equal').assertions[0].actual.text, 'actual');
    assert.equal(byId.get('xunit-equal').assertions[0].expected.text, 'expected');
    assert.equal(byId.get('vitest-equal').assertions[0].apiId, 'vitest:toEqual');
    assert.equal(byId.get('playwright-match').assertions[0].apiId, 'playwright:toMatch');
    for (const matcher of ['equal', 'deepEqual', 'match', 'throws', 'rejects'])
    {
        assert.equal(byId.get(`node-${matcher}`).assertions[0].apiId, `node-assert:${matcher}`);
    }
});

test('facts classify literal, same-symbol, call result, pre/post snapshot and production/helper calls', () =>
{
    const fixtures = [
        fixtureCase({ id: 'literal', source: 'expect(401).toBe(401);', snippet: 'expect(401).toBe(401)' }),
        fixtureCase({ id: 'same-symbol', source: 'expect(subject).toBe(subject);', snippet: 'expect(subject).toBe(subject)' }),
        fixtureCase({ id: 'call-result', source: 'expect(load()).toBe(expected);', snippet: 'expect(load()).toBe(expected)' }),
        fixtureCase({ id: 'pre-post', source: 'expect(afterSnapshot).toEqual(beforeSnapshot);', snippet: 'expect(afterSnapshot).toEqual(beforeSnapshot)', matcher: 'toEqual' })
    ];
    const { facts } = analyze(fixtures);
    const byId = new Map(facts.cases.map((item) => [item.testId, item]));
    assert.equal(byId.get('literal').assertions[0].actual.kind, 'literal');
    assert.equal(byId.get('same-symbol').assertions[0].actual.kind, 'symbol');
    assert.equal(byId.get('call-result').assertions[0].actual.kind, 'actual-call-result');
    assert.equal(byId.get('pre-post').assertions[0].actual.kind, 'post-snapshot');
    assert.equal(byId.get('pre-post').assertions[0].expected.kind, 'pre-snapshot');
    assert.equal(byId.get('pre-post').calls.production[0].methodName, 'Load');
});

test('case-level zero outcome, early return, unreachable assertion and test-to-test invocation fail independently', () =>
{
    const fixtures = [
        fixtureCase({ id: 'good', source: 'expect(actual).toBe(expected);', snippet: 'expect(actual).toBe(expected)' }),
        fixtureCase({ id: 'expression-oracle', adapter: 'xunit', source: 'Assert.Equal(expected, actual);', snippet: 'Assert.Equal(expected, actual)', matcher: 'Equal', assembly: 'xunit.assert', containingType: 'Xunit.Assert', returnStatements: ['Assert.Equal(expected, actual)'] }),
        fixtureCase({ id: 'empty', source: 'load();', snippet: null }),
        fixtureCase({ id: 'early', source: 'if (!fixture) return; expect(actual).toBe(expected);', snippet: 'expect(actual).toBe(expected)', returnStatements: ['return;'] }),
        fixtureCase({ id: 'dead', source: 'if (false) { expect(actual).toBe(expected); }', snippet: 'expect(actual).toBe(expected)' }),
        fixtureCase({ id: 'wrapper', source: 'OtherTest(); expect(actual).toBe(expected);', snippet: 'expect(actual).toBe(expected)', testInvocations: ['OtherTest'] })
    ];
    const { result } = analyze(fixtures);
    const rules = (id) => result.cases.find((item) => item.testId === id).violations.map((item) => item.ruleId);
    assert.deepEqual(rules('good'), []);
    assert.deepEqual(rules('expression-oracle'), []);
    assert.ok(rules('empty').includes('TQ-ZERO-OUTCOME'));
    assert.ok(rules('early').includes('TQ-EARLY-RETURN'));
    assert.ok(rules('dead').includes('TQ-UNREACHABLE-ORACLE'));
    assert.ok(rules('wrapper').includes('TQ-TEST-TO-TEST'));
});

test('planned not-selected membership is not reported as a passed empty test', () =>
{
    const fixture = fixtureCase({ id: 'platform-case', source: 'if (!linux) return;', snippet: null });
    const membership = new Map([['platform-case', { outcome: 'not-selected' }]]);
    const { result } = analyze([fixture], { membershipByTestId: membership });
    assert.equal(result.cases[0].outcome, 'not-applicable');
    assert.deepEqual(result.cases[0].violations, []);
});

test('weak policy rejects constant, self-compare, inline NotNull, non-negative measurement and contract mismatch', () =>
{
    const fixtures = [
        fixtureCase({ id: 'constant', source: 'expect(401).toBe(401);', snippet: 'expect(401).toBe(401)' }),
        fixtureCase({ id: 'self', source: 'expect(actual).toBe(actual);', snippet: 'expect(actual).toBe(actual)' }),
        fixtureCase({ id: 'not-null', adapter: 'xunit', source: 'Assert.NotNull(new object());', snippet: 'Assert.NotNull(new object())', matcher: 'NotNull', assembly: 'xunit.assert', containingType: 'Xunit.Assert' }),
        fixtureCase({ id: 'elapsed', source: 'expect(elapsed).toBeGreaterThanOrEqual(0);', snippet: 'expect(elapsed).toBeGreaterThanOrEqual(0)', matcher: 'toBeGreaterThanOrEqual' }),
        fixtureCase({ id: 'cache', displayName: 'returns cached value once', source: 'expect(first).toEqual(second);', snippet: 'expect(first).toEqual(second)', matcher: 'toEqual' })
    ];
    const { result } = analyze(fixtures);
    const rules = (id) => result.cases.find((item) => item.testId === id).violations.map((item) => item.ruleId);
    assert.ok(rules('constant').includes('TQ-CONSTANT-ORACLE'));
    assert.ok(rules('self').includes('TQ-SELF-COMPARE'));
    assert.ok(rules('not-null').includes('TQ-UNINFORMATIVE-ORACLE'));
    assert.ok(rules('elapsed').includes('TQ-UNINFORMATIVE-ORACLE'));
    assert.ok(rules('cache').includes('TQ-CONTRACT-ORACLE'));
});

test('dynamic cases and unregistered assertion symbols fail closed while structured native receipts are outcomes', () =>
{
    const dynamic = fixtureCase({ id: 'dynamic', identity: 'dynamic', source: 'expect(actual).toBe(expected);', snippet: 'expect(actual).toBe(expected)' });
    const ordinaryAssert = fixtureCase({ id: 'ordinary-assert', adapter: 'node-test', source: 'assert(actual);', snippet: 'assert(actual)', matcher: 'assert', assembly: 'src/business', containingType: 'BusinessAssertions' });
    const native = fixtureCase({
        id: 'native',
        adapter: 'native-entry',
        source: 'return VerifyReceipt();',
        snippet: null,
        traits: [{ name: 'RuntimeReceipt', value: '.tmp/native.json' }]
    });
    const { facts, result } = analyze([dynamic, ordinaryAssert, native]);
    assert.equal(facts.cases.find((item) => item.testId === 'dynamic').status, 'dynamic-obligation');
    assert.equal(facts.cases.find((item) => item.testId === 'ordinary-assert').status, 'unknown');
    assert.equal(result.cases.find((item) => item.testId === 'native').outcome, 'passed');
});

test('quality policy is closed and rejects wildcard, expired, ownerless and unknown waivers', () =>
{
    assert.deepEqual(policy.rules.toSorted(), qualityRuleIds());
    const wildcard = structuredClone(policy);
    wildcard.waivers.push({
        testId: 'vitest:*',
        ruleId: 'TQ-ZERO-OUTCOME',
        owner: 'TestOwner',
        reason: 'fixture-only limitation',
        expires: '2099-01-01T00:00:00Z',
        requirement: 'REQ-1',
        issue: '#2621',
        replacementEvidence: '.tmp/receipt.json'
    });
    assert.throws(() => validateQualityPolicy(wildcard), /exact test and rule ID/u);
    const expired = structuredClone(wildcard);
    expired.waivers[0].testId = 'vitest:exact';
    expired.waivers[0].expires = '2020-01-01T00:00:00Z';
    assert.throws(() => validateQualityPolicy(expired), /expired/u);
    const ownerless = structuredClone(wildcard);
    ownerless.waivers[0].testId = 'vitest:exact';
    ownerless.waivers[0].owner = '';
    assert.throws(() => validateQualityPolicy(ownerless), /owner is required/u);
});

test('TypeScript adapter resolves framework assertion symbols and ignores same-named business functions', () =>
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-test-quality-symbols-'));
    try
    {
        const file = 'tests/tools/symbols.test.mjs';
        mkdirSync(path.join(root, 'tests/tools'), { recursive: true });
        writeFileSync(path.join(root, file), [
            "import assert from 'node:assert/strict'",
            "import { test } from 'node:test'",
            'function expect(value) { return { toBe: () => value } }',
            "test('symbols', () => { assert.equal(load(), 1); expect(1).toBe(1) })",
            ''
        ].join('\n'));
        const request = path.join(root, 'request.json');
        writeFileSync(request, JSON.stringify({ root, files: [{ path: file, adapter: 'node-test' }] }));
        const output = execFileSync(process.execPath, ['tools/test-inventory/ts-ast-adapter/index.mjs', request], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        const report = JSON.parse(output);
        assert.equal(report.testCases.length, 1);
        assert.deepEqual(
            report.testCases[0].methodFacts.assertionCandidates.map((item) => item.methodName),
            ['equal']
        );
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test('facts and policy artifacts are deterministic and stale digest bindings fail', () =>
{
    const fixture = fixtureCase({ id: 'stable', source: 'expect(actual).toBe(expected);', snippet: 'expect(actual).toBe(expected)' });
    const first = analyze([fixture]);
    const second = analyze([fixture]);
    assert.equal(JSON.stringify(first.facts), JSON.stringify(second.facts));
    assert.equal(first.result.contentDigest, second.result.contentDigest);
    const stale = structuredClone(first.facts);
    stale.inventoryDigest = digest('stale');
    assert.throws(
        () => evaluateQuality({ inventory: first.canonical, oracleFacts: stale, policy }),
        /inventory digest does not match/u
    );
});

test('sealed quality artifact rejects producer, status, case closure, count, first-failure and violation tampering', () =>
{
    const fixture = fixtureCase({ id: 'artifact-empty', source: 'load();', snippet: null });
    const canonical = inventory([fixture]);
    const sources = new Map([[fixture.sourceFile.path, fixture.source]]);
    const conformance = {
        schema: 'fsusblog.test-quality-conformance.v1',
        corpusVersion: 'fixture',
        cases: [{}],
        killedMutations: ['fixture'],
        contentDigest: digest('conformance')
    };
    const build = () => buildQualityArtifact({
        root: repositoryRoot,
        inventory: canonical,
        conformance,
        sourceReader: (file) => sources.get(file)
    }).artifact;
    const artifact = build();
    validateQualityArtifact(artifact, { inventory: canonical });

    const mutate = (callback) =>
    {
        const changed = structuredClone(artifact);
        callback(changed);
        changed.contentDigest = contentDigest(changed);
        return changed;
    };
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.producer.id = 'private-scanner';
        }), { inventory: canonical }),
        /producer identity/u
    );
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.status = 'passed';
        }), { inventory: canonical }),
        /status does not match/u
    );
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.cases = [];
        }), { inventory: canonical }),
        /every inventory case/u
    );
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.counts.failed += 1;
        }), { inventory: canonical }),
        /failed count/u
    );
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.firstFailure = null;
        }), { inventory: canonical }),
        /first failure/u
    );
    assert.throws(
        () => validateQualityArtifact(mutate((item) =>
        {
            item.violations.pop();
        }), { inventory: canonical }),
        /violation summary/u
    );

    const forged = mutate((item) =>
    {
        item.violations[0].reason = 'forged';
        item.cases[0].violations[0].reason = 'forged';
        item.firstFailure.reason = 'forged';
    });
    assert.throws(
        () => verifyQualityArtifact({
            root: repositoryRoot,
            inventory: canonical,
            conformance,
            artifact: forged,
            sourceReader: (file) => sources.get(file)
        }),
        /independently recomputed/u
    );
});
