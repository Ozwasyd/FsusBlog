import { readFileSync } from 'node:fs';
import path from 'node:path';

import { contentDigest, ORACLE_FACTS_SCHEMA, validateOracleFacts } from './schema.mjs';

export const ORACLE_ANALYZER_VERSION = 'fsusblog.test-oracle-analyzer.v1';

const expectedOutcomeMatchers = new Set([
    'Exception',
    'ExceptionAsync',
    'Throws',
    'ThrowsAny',
    'ThrowsAnyAsync',
    'ThrowsAsync',
    'doesNotThrow',
    'rejects',
    'toReject',
    'toThrow',
    'toThrowError',
    'throws'
]);

const explicitFailureMatchers = new Set(['Fail', 'fail']);
const equalityMatchers = new Set([
    'Be',
    'DeepEqual',
    'Equal',
    'Same',
    'StrictEqual',
    'deepEqual',
    'deepStrictEqual',
    'equal',
    'strictEqual',
    'toBe',
    'toEqual',
    'toStrictEqual'
]);

function sortedUnique(values)
{
    return [...new Set((values ?? []).filter((value) => String(value ?? '').trim()).map(String))].sort();
}

function positionOffset(source, position)
{
    const lines = source.split('\n');
    let offset = 0;
    for (let line = 1; line < position.line; line += 1)
    {
        offset += (lines[line - 1] ?? '').length + 1;
    }
    return offset + Math.max(0, position.column - 1);
}

function sourceAtSpan(source, span)
{
    if (!span)
    {
        return '';
    }
    const start = positionOffset(source, span.start);
    const end = positionOffset(source, span.end);
    return source.slice(start, Math.max(start, end)).trim();
}

function balancedArguments(source, openIndex)
{
    if (openIndex < 0 || source[openIndex] !== '(')
    {
        return null;
    }
    let quote = null;
    let escaped = false;
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1)
    {
        const char = source[index];
        if (quote !== null)
        {
            if (escaped)
            {
                escaped = false;
            }
            else if (char === '\\')
            {
                escaped = true;
            }
            else if (char === quote)
            {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === '`')
        {
            quote = char;
            continue;
        }
        if (char === '(' || char === '[' || char === '{')
        {
            depth += 1;
        }
        else if (char === ')' || char === ']' || char === '}')
        {
            depth -= 1;
            if (depth === 0)
            {
                return { body: source.slice(openIndex + 1, index), end: index + 1 };
            }
        }
    }
    return null;
}

function splitArguments(source)
{
    const values = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    let depth = 0;
    for (let index = 0; index < source.length; index += 1)
    {
        const char = source[index];
        if (quote !== null)
        {
            if (escaped)
            {
                escaped = false;
            }
            else if (char === '\\')
            {
                escaped = true;
            }
            else if (char === quote)
            {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === '`')
        {
            quote = char;
        }
        else if (char === '(' || char === '[' || char === '{' || char === '<')
        {
            depth += 1;
        }
        else if (char === ')' || char === ']' || char === '}' || char === '>')
        {
            depth = Math.max(0, depth - 1);
        }
        else if (char === ',' && depth === 0)
        {
            values.push(source.slice(start, index).trim());
            start = index + 1;
        }
    }
    values.push(source.slice(start).trim());
    return values.filter((value) => value !== '');
}

function normalizeExpression(value)
{
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function operandKind(text, productionCalls)
{
    const value = normalizeExpression(text);
    if (/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d+)?)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u.test(value))
    {
        return 'literal';
    }
    if (/^(?:new\s+|\[|\{|Array\.|Enumerable\.Empty)/u.test(value))
    {
        return 'constant-expression';
    }
    if (/(?:before|original|previous|baseline|preSnapshot)/iu.test(value))
    {
        return 'pre-snapshot';
    }
    if (/(?:after|current|result|response|actual|postSnapshot)/iu.test(value))
    {
        return 'post-snapshot';
    }
    if (productionCalls.some((call) => value.includes(call.methodName)) || /\w+\s*\(/u.test(value))
    {
        return 'actual-call-result';
    }
    if (/expected|contract|budget|limit|capacity/iu.test(value))
    {
        return 'contract-expression';
    }
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value))
    {
        return 'symbol';
    }
    return 'helper-result';
}

function operand(text, productionCalls)
{
    const normalized = normalizeExpression(text);
    if (!normalized)
    {
        return null;
    }
    const kind = operandKind(normalized, productionCalls);
    const result = { kind, text: normalized };
    if (kind === 'symbol')
    {
        result.symbol = normalized;
    }
    return result;
}

function assertionApi(candidate, testCase)
{
    const containing = String(candidate.containingType ?? '');
    const assembly = String(candidate.assembly ?? '');
    if (containing === 'Xunit.Assert' || assembly.toLowerCase() === 'xunit.assert')
    {
        return `xunit:${candidate.methodName}`;
    }
    if (containing.startsWith('FluentAssertions') || assembly.startsWith('FluentAssertions'))
    {
        return `fluent-assertions:${candidate.methodName}`;
    }
    if (assembly === 'node:assert' || assembly === 'node:assert/strict')
    {
        return `node-assert:${candidate.methodName}`;
    }
    if (assembly === 'vitest' || (testCase.adapter === 'vitest' && candidate.assemblyKind === 'test-framework'))
    {
        return `vitest:${candidate.methodName}`;
    }
    if (assembly === '@playwright/test' || (testCase.adapter === 'playwright' && candidate.assemblyKind === 'test-framework'))
    {
        return `playwright:${candidate.methodName}`;
    }
    if (testCase.adapter === 'xunit' && candidate.assemblyKind === 'test')
    {
        return `repository-wrapper:${candidate.containingType}.${candidate.methodName}`;
    }
    return null;
}

function nodeOperands(snippet, matcher)
{
    const marker = snippet.indexOf(matcher);
    const open = marker < 0 ? snippet.indexOf('(') : snippet.indexOf('(', marker + matcher.length);
    const args = balancedArguments(snippet, open);
    return args ? splitArguments(args.body) : [];
}

function expectOperands(snippet, matcher)
{
    const expectIndex = snippet.indexOf('expect');
    const expectOpen = snippet.indexOf('(', expectIndex + 6);
    const actual = balancedArguments(snippet, expectOpen);
    const matcherIndex = snippet.lastIndexOf(matcher);
    const matcherOpen = matcherIndex < 0 ? -1 : snippet.indexOf('(', matcherIndex + matcher.length);
    const expected = balancedArguments(snippet, matcherOpen);
    return {
        actual: actual?.body ?? '',
        expected: expected ? splitArguments(expected.body)[0] ?? '' : '',
        message: expected ? splitArguments(expected.body)[1] ?? null : null
    };
}

function xunitOperands(snippet, matcher)
{
    const marker = snippet.lastIndexOf(matcher);
    const open = snippet.indexOf('(', marker + matcher.length);
    const args = balancedArguments(snippet, open);
    const values = args ? splitArguments(args.body) : [];
    if (equalityMatchers.has(matcher))
    {
        return { actual: values[1] ?? '', expected: values[0] ?? '', message: values[2] ?? null };
    }
    if (/^(?:True|False|NotNull|Null|Empty|NotEmpty|Contains|DoesNotContain|Match|Matches)$/u.test(matcher))
    {
        return { actual: values[0] ?? '', expected: matcher === 'True' ? 'true' : matcher === 'False' ? 'false' : '', message: values[1] ?? null };
    }
    return { actual: values.at(-1) ?? '', expected: values[0] ?? '', message: values.at(-1) ?? null };
}

function assertionOperands(snippet, candidate, apiId)
{
    const matcher = candidate.methodName;
    if (apiId.startsWith('node-assert:'))
    {
        const values = nodeOperands(snippet, matcher);
        if (matcher === 'ok' || matcher === 'assert')
        {
            return { actual: values[0] ?? '', expected: 'true', message: values[1] ?? null };
        }
        return { actual: values[0] ?? '', expected: values[1] ?? '', message: values[2] ?? null };
    }
    if (apiId.startsWith('vitest:') || apiId.startsWith('playwright:'))
    {
        return expectOperands(snippet, matcher);
    }
    return xunitOperands(snippet, matcher);
}

function callRecord(call)
{
    return {
        methodName: call.methodName,
        containingType: call.containingType ?? null,
        assembly: call.assembly ?? null,
        assemblyKind: call.assemblyKind ?? 'unknown',
        sourceSpan: call.location ?? null
    };
}

function classifyCalls(methodFacts)
{
    const calls = { production: [], testHelper: [], bcl: [], thirdParty: [] };
    for (const call of methodFacts?.invocations ?? [])
    {
        if (call.callsTestMethod)
        {
            continue;
        }
        const key = call.assemblyKind === 'production'
            ? 'production'
            : call.assemblyKind === 'test'
                ? 'testHelper'
                : call.assemblyKind === 'bcl-framework'
                    ? 'bcl'
                    : 'thirdParty';
        calls[key].push(callRecord(call));
    }
    for (const key of Object.keys(calls))
    {
        calls[key].sort((left, right) => (
            left.methodName.localeCompare(right.methodName)
            || String(left.containingType).localeCompare(String(right.containingType))
        ));
    }
    return calls;
}

function inferObservations(assertions, testCase, calls)
{
    const observations = {
        return: [],
        state: [],
        collaborator: [],
        log: [],
        filesystem: [],
        network: [],
        process: [],
        evidence: []
    };
    for (const assertion of assertions)
    {
        const text = `${assertion.actual?.text ?? ''} ${assertion.expected?.text ?? ''}`;
        observations.return.push(assertion.actual?.text ?? assertion.matcher);
        if (/(?:state|count|length|snapshot|version|generation|value|items?)/iu.test(text))
        {
            observations.state.push(text.trim());
        }
        if (/(?:received|callCount|called|invocation|spy|substitute)/iu.test(text))
        {
            observations.collaborator.push(text.trim());
        }
        if (/(?:log|stderr|stdout|message)/iu.test(text))
        {
            observations.log.push(text.trim());
        }
        if (/(?:file|path|directory|filesystem|read|write)/iu.test(text))
        {
            observations.filesystem.push(text.trim());
        }
        if (/(?:http|response|status|request|socket|network)/iu.test(text))
        {
            observations.network.push(text.trim());
        }
        if (/(?:pid|process|child|exit|signal)/iu.test(text))
        {
            observations.process.push(text.trim());
        }
        if (/(?:receipt|evidence|artifact|digest)/iu.test(text))
        {
            observations.evidence.push(text.trim());
        }
    }
    for (const trait of testCase.traits ?? [])
    {
        if (trait.name === 'RuntimeReceipt' || trait.name === 'Receipt')
        {
            observations.evidence.push(trait.value);
        }
    }
    if (calls.production.length > 0 && observations.return.length === 0)
    {
        observations.return.push(...calls.production.map((call) => `${call.containingType ?? ''}.${call.methodName}`));
    }
    for (const key of Object.keys(observations))
    {
        observations[key] = sortedUnique(observations[key]);
    }
    return observations;
}

function literalUnreachable(bodySource, snippet)
{
    const index = bodySource.indexOf(snippet);
    if (index < 0)
    {
        return false;
    }
    const prefix = bodySource.slice(Math.max(0, index - 240), index);
    return /(?:if\s*\(\s*false\s*\)|if\s*\(\s*0\s*\)|#if\s+false)/u.test(prefix);
}

function assertionFact(candidate, testCase, source, productionCalls)
{
    const apiId = assertionApi(candidate, testCase);
    if (apiId === null)
    {
        return null;
    }
    const snippet = sourceAtSpan(source, candidate.location);
    const parsed = assertionOperands(snippet, candidate, apiId);
    const matcher = candidate.methodName;
    const earlyExitStatements = (testCase.methodFacts?.returnStatements ?? []).filter((statement) => (
        !(testCase.methodFacts?.assertionCandidates ?? []).some((assertion) => (
            normalizeExpression(statement).includes(`${assertion.methodName}(`)
        ))
    ));
    const reachability = literalUnreachable(testCase.bodySource ?? '', snippet)
        ? 'unreachable'
        : earlyExitStatements.length > 0
            ? 'unknown'
            : 'reachable';
    return {
        apiId,
        matcher,
        operator: equalityMatchers.has(matcher) ? 'equality' : expectedOutcomeMatchers.has(matcher) ? 'exception-outcome' : 'predicate',
        actual: operand(parsed.actual, productionCalls),
        expected: operand(parsed.expected, productionCalls),
        message: parsed.message ? normalizeExpression(parsed.message) : null,
        sourceSpan: candidate.location ?? testCase.sourceSpan,
        reachability,
        helperChain: apiId.startsWith('repository-wrapper:') ? [apiId.slice('repository-wrapper:'.length)] : []
    };
}

function oracleCase(testCase, source, inventoryDiagnostics, runtimeEvidence)
{
    const methodFacts = testCase.methodFacts ?? null;
    const calls = classifyCalls(methodFacts);
    const productionCalls = calls.production;
    const assertions = (methodFacts?.assertionCandidates ?? [])
        .map((candidate) => assertionFact(candidate, testCase, source, productionCalls))
        .filter((value) => value !== null)
        .sort((left, right) => (
            left.sourceSpan.start.line - right.sourceSpan.start.line
            || left.sourceSpan.start.column - right.sourceSpan.start.column
            || left.apiId.localeCompare(right.apiId)
        ));
    const explicitFailures = sortedUnique(assertions
        .filter((assertion) => explicitFailureMatchers.has(assertion.matcher))
        .map((assertion) => `${assertion.apiId}@${assertion.sourceSpan.start.line}:${assertion.sourceSpan.start.column}`));
    const expectedOutcomes = sortedUnique(assertions
        .filter((assertion) => expectedOutcomeMatchers.has(assertion.matcher))
        .map((assertion) => assertion.apiId));
    const earlyExits = sortedUnique((methodFacts?.returnStatements ?? []).filter((statement) => (
        !(methodFacts?.assertionCandidates ?? []).some((candidate) => (
            normalizeExpression(statement).includes(`${candidate.methodName}(`)
        ))
    )));
    const conditionalAssertions = assertions
        .filter((assertion) => assertion.reachability !== 'reachable')
        .map((assertion) => `${assertion.apiId}:${assertion.reachability}`);
    const runtimeVerified = testCase.identity === 'dynamic'
        && runtimeEvidence?.status === 'verified'
        && /^sha256:[0-9a-f]{64}$/u.test(String(runtimeEvidence?.receiptDigest ?? ''))
        && Array.isArray(runtimeEvidence?.caseIds)
        && runtimeEvidence.caseIds.includes(testCase.id);
    const dynamicObligation = testCase.identity === 'dynamic' && !runtimeVerified
        ? testCase.dynamicCaseInfo?.inventoryObligation ?? 'runtime case evidence is required'
        : null;
    const structuredEvidence = (testCase.traits ?? []).some((trait) => (
        trait.name === 'RuntimeReceipt' || trait.name === 'Receipt'
    ));
    const observations = inferObservations(assertions, testCase, calls);
    const reachableOutcomeCount = assertions.filter((assertion) => assertion.reachability === 'reachable').length
        + expectedOutcomes.length
        + (structuredEvidence ? 1 : 0);
    const normalPathCount = earlyExits.length > 0 ? earlyExits.length + 1 : 1;
    const allNormalPathsObserved = dynamicObligation !== null || conditionalAssertions.length > 0
        ? null
        : reachableOutcomeCount > 0;
    const diagnostics = inventoryDiagnostics
        .filter((diagnostic) => diagnostic.file === testCase.ownerFile && diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    if (methodFacts === null && !runtimeVerified)
    {
        diagnostics.push('oracle-method-facts-missing: adapter produced no resolved method facts');
    }
    if ((methodFacts?.assertionCandidates?.length ?? 0) !== assertions.length)
    {
        diagnostics.push('oracle-symbol-unresolved: one or more assertion candidates are outside the closed API registry');
    }
    if (runtimeVerified)
    {
        observations.evidence.push(`runtime:${runtimeEvidence.receiptDigest}`);
        observations.evidence = sortedUnique(observations.evidence);
    }
    const status = dynamicObligation !== null
        ? 'dynamic-obligation'
        : diagnostics.length > 0 || conditionalAssertions.some((value) => value.endsWith(':unknown'))
            ? 'unknown'
            : 'resolved';

    return {
        testId: testCase.id,
        displayName: testCase.displayName,
        ownerFile: testCase.ownerFile,
        adapter: testCase.adapter,
        identity: testCase.identity,
        sourceSpan: testCase.sourceSpan,
        status,
        assertions,
        explicitFailures,
        expectedOutcomes,
        observations,
        calls,
        testInvocations: sortedUnique((methodFacts?.invocations ?? [])
            .filter((call) => call.callsTestMethod)
            .map((call) => call.calledTestMethodId ?? `${call.containingType ?? ''}.${call.methodName}`)),
        controlFlow: {
            normalPathCount,
            observedNormalPathCount: allNormalPathsObserved === true ? normalPathCount : reachableOutcomeCount > 0 ? 1 : 0,
            allNormalPathsObserved,
            earlyExits,
            conditionalAssertions: sortedUnique(conditionalAssertions),
            loopOrTableCoverage: testCase.identity === 'static' && testCase.kind?.includes('each')
                ? [testCase.id]
                : [],
            dynamicObligation
        },
        diagnostics: sortedUnique(diagnostics)
    };
}

export function buildOracleFacts(inventory, {
    root = process.cwd(),
    sourceReader = (file) => readFileSync(path.join(root, file), 'utf8'),
    runtimeEvidenceByTestId = new Map()
} = {})
{
    const sourceDigests = Object.fromEntries((inventory.sourceFiles ?? [])
        .filter((sourceFile) => sourceFile.kind === 'discoverable-test')
        .map((sourceFile) => [sourceFile.path, sourceFile.sourceDigest])
        .sort(([left], [right]) => left.localeCompare(right)));
    const sourceCache = new Map();
    const cases = (inventory.testCases ?? []).map((testCase) =>
    {
        if (!sourceCache.has(testCase.ownerFile))
        {
            sourceCache.set(testCase.ownerFile, sourceReader(testCase.ownerFile));
        }
        return oracleCase(
            testCase,
            sourceCache.get(testCase.ownerFile),
            inventory.diagnostics ?? [],
            runtimeEvidenceByTestId.get(testCase.id)
        );
    }).sort((left, right) => left.testId.localeCompare(right.testId));
    const inventoryCaseIds = new Set((inventory.testCases ?? []).map((testCase) => testCase.id));
    const factCaseIds = new Set(cases.map((testCase) => testCase.testId));
    const diagnostics = [];
    for (const id of inventoryCaseIds)
    {
        if (!factCaseIds.has(id))
        {
            diagnostics.push(`oracle-case-missing: ${id}`);
        }
    }
    const artifact = {
        schema: ORACLE_FACTS_SCHEMA,
        analyzerVersion: ORACLE_ANALYZER_VERSION,
        inventoryDigest: inventory.inventoryDigest,
        adapterVersion: inventory.adapterVersion,
        sourceDigests,
        cases,
        diagnostics: diagnostics.sort(),
        contentDigest: ''
    };
    artifact.contentDigest = contentDigest(artifact);
    return validateOracleFacts(artifact);
}
