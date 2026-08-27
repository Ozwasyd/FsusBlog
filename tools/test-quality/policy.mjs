import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalStringify, contentDigest, QUALITY_POLICY_SCHEMA } from './schema.mjs';

export const QUALITY_ENGINE_VERSION = 'fsusblog.test-quality-engine.v1';

const terminalOutcomes = new Set(['passed', 'failed', 'not-applicable', 'unresolved-failed']);
const ruleIds = new Set([
    'TQ-UNRESOLVED-FACTS',
    'TQ-ZERO-OUTCOME',
    'TQ-EARLY-RETURN',
    'TQ-UNREACHABLE-ORACLE',
    'TQ-TEST-TO-TEST',
    'TQ-DISCOVERABLE-WORKER',
    'TQ-CONSTANT-ORACLE',
    'TQ-SELF-COMPARE',
    'TQ-UNINFORMATIVE-ORACLE',
    'TQ-ACTUAL-AS-EXPECTED',
    'TQ-CONTRACT-ORACLE',
    'TQ-HTTP-200-ONLY-CRITICAL',
    'TQ-SNAPSHOT-ONLY-CRITICAL'
]);

function fail(message)
{
    throw new Error(`invalid ${QUALITY_POLICY_SCHEMA}: ${message}`);
}

function sortedUnique(values)
{
    return [...new Set((values ?? []).filter((value) => String(value ?? '').trim()).map(String))].sort();
}

function policyDigest(policy)
{
    return `sha256:${createHash('sha256').update(canonicalStringify(policy)).digest('hex')}`;
}

export function validateQualityPolicy(policy, { now = new Date() } = {})
{
    const keys = new Set(['schema', 'version', 'rules', 'contractVocabulary', 'waivers']);
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy))
    {
        fail('root must be an object');
    }
    for (const key of Object.keys(policy))
    {
        if (!keys.has(key))
        {
            fail(`unknown root field ${key}`);
        }
    }
    if (policy.schema !== QUALITY_POLICY_SCHEMA)
    {
        fail(`schema must equal ${QUALITY_POLICY_SCHEMA}`);
    }
    if (typeof policy.version !== 'string' || policy.version.trim() === '')
    {
        fail('version is required');
    }
    if (!Array.isArray(policy.rules) || policy.rules.length !== ruleIds.size
        || new Set(policy.rules).size !== policy.rules.length)
    {
        fail('rules must contain every closed rule exactly once');
    }
    for (const rule of policy.rules)
    {
        if (!ruleIds.has(rule))
        {
            fail(`unknown rule ${rule}`);
        }
    }
    const vocabularyKeys = new Set(['bound', 'performance', 'cache', 'atomicity', 'negative', 'forbidden-path']);
    if (policy.contractVocabulary === null || typeof policy.contractVocabulary !== 'object')
    {
        fail('contractVocabulary must be an object');
    }
    for (const key of Object.keys(policy.contractVocabulary))
    {
        if (!vocabularyKeys.has(key))
        {
            fail(`unknown contract vocabulary ${key}`);
        }
    }
    for (const key of vocabularyKeys)
    {
        if (!Array.isArray(policy.contractVocabulary[key]) || policy.contractVocabulary[key].length === 0)
        {
            fail(`contractVocabulary.${key} must be a non-empty array`);
        }
    }
    if (!Array.isArray(policy.waivers))
    {
        fail('waivers must be an array');
    }
    const waiverKeys = new Set([
        'testId',
        'ruleId',
        'owner',
        'reason',
        'expires',
        'requirement',
        'issue',
        'replacementEvidence'
    ]);
    const identities = new Set();
    for (const [index, waiver] of policy.waivers.entries())
    {
        for (const key of Object.keys(waiver))
        {
            if (!waiverKeys.has(key))
            {
                fail(`waivers[${index}] contains unknown field ${key}`);
            }
        }
        for (const key of waiverKeys)
        {
            if (typeof waiver[key] !== 'string' || waiver[key].trim() === '')
            {
                fail(`waivers[${index}].${key} is required`);
            }
        }
        if (waiver.testId.includes('*') || waiver.testId.includes('?') || waiver.ruleId.includes('*'))
        {
            fail(`waivers[${index}] must bind an exact test and rule ID`);
        }
        if (!ruleIds.has(waiver.ruleId))
        {
            fail(`waivers[${index}] uses unknown rule ${waiver.ruleId}`);
        }
        const expiry = new Date(waiver.expires);
        if (!Number.isFinite(expiry.valueOf()) || expiry <= now)
        {
            fail(`waivers[${index}] is expired or has an invalid expiry`);
        }
        const identity = `${waiver.testId}\n${waiver.ruleId}`;
        if (identities.has(identity))
        {
            fail(`duplicate waiver ${waiver.testId}/${waiver.ruleId}`);
        }
        identities.add(identity);
    }
    return policy;
}

export function loadQualityPolicy(root, relative = 'config/testing/test-quality-policy.json')
{
    return validateQualityPolicy(JSON.parse(readFileSync(path.join(root, relative), 'utf8')));
}

function normalizeExpression(value)
{
    return String(value ?? '')
        .replace(/\s+/gu, '')
        .replace(/^\((.*)\)$/u, '$1');
}

function literalValue(operand)
{
    if (operand?.kind !== 'literal')
    {
        return Symbol.for('not-literal');
    }
    const text = operand.text;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (text === 'undefined') return undefined;
    if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
    return text.slice(1, -1);
}

function violation(ruleId, fact, reason, minimumProof, spans = [])
{
    return {
        ruleId,
        testId: fact.testId,
        sourceSpan: spans[0] ?? fact.sourceSpan,
        reason,
        minimumProof,
        nameCommitment: fact.displayName
    };
}

function hasIndependentStateObservation(fact)
{
    return fact.observations.state.length > 0
        || fact.observations.collaborator.length > 0
        || fact.observations.filesystem.length > 0
        || fact.observations.network.length > 0
        || fact.observations.process.length > 0
        || fact.observations.evidence.length > 0;
}

function weakAssertionViolations(fact)
{
    const violations = [];
    for (const assertion of fact.assertions)
    {
        const actual = normalizeExpression(assertion.actual?.text);
        const expected = normalizeExpression(assertion.expected?.text);
        const actualLiteral = literalValue(assertion.actual);
        const expectedLiteral = literalValue(assertion.expected);
        if (actualLiteral !== Symbol.for('not-literal')
            && expectedLiteral !== Symbol.for('not-literal')
            && Object.is(actualLiteral, expectedLiteral))
        {
            violations.push(violation(
                'TQ-CONSTANT-ORACLE',
                fact,
                `literal ${assertion.actual.text} is compared with the same literal`,
                'compare an independently produced actual result with a closed expected contract',
                [assertion.sourceSpan]
            ));
        }
        if (actual && expected && actual === expected && assertion.actual?.kind !== 'literal')
        {
            violations.push(violation(
                'TQ-SELF-COMPARE',
                fact,
                `actual and expected resolve to the same expression ${assertion.actual.text}`,
                'capture an independent expected value or pre-act snapshot',
                [assertion.sourceSpan]
            ));
        }
        if ((assertion.matcher === 'True' || assertion.matcher === 'toBeTruthy' || assertion.matcher === 'ok')
            && actualLiteral === true)
        {
            violations.push(violation(
                'TQ-CONSTANT-ORACLE',
                fact,
                'the assertion predicate is the literal true',
                'assert a postcondition derived from production behavior',
                [assertion.sourceSpan]
            ));
        }
        if ((assertion.matcher === 'NotNull' || assertion.matcher === 'not.toBeNull')
            && assertion.actual?.kind === 'constant-expression')
        {
            violations.push(violation(
                'TQ-UNINFORMATIVE-ORACLE',
                fact,
                'NotNull observes a value constructed inline by the test',
                'observe a nullable production result or a stronger state contract',
                [assertion.sourceSpan]
            ));
        }
        if ((assertion.matcher === 'GreaterThanOrEqualTo' || assertion.matcher === 'toBeGreaterThanOrEqual')
            && expectedLiteral === 0
            && /(?:elapsed|allocation|rate|length|count)/iu.test(assertion.actual?.text ?? ''))
        {
            violations.push(violation(
                'TQ-UNINFORMATIVE-ORACLE',
                fact,
                'an inherently non-negative measurement is compared only with zero',
                'bind the measurement to an explicit budget and sample owner',
                [assertion.sourceSpan]
            ));
        }
        if (assertion.expected?.kind === 'actual-call-result'
            && assertion.actual?.kind === 'actual-call-result'
            && assertion.expected.source !== 'closed-contract')
        {
            violations.push(violation(
                'TQ-ACTUAL-AS-EXPECTED',
                fact,
                'expected is generated from the same post-act production/helper surface as actual',
                'derive expected from a closed contract or capture it before act',
                [assertion.sourceSpan]
            ));
        }
    }
    return violations;
}

function contractViolations(fact, policy)
{
    const violations = [];
    const commitments = new Set();
    const haystack = `${fact.displayName} ${(fact.requirementIds ?? []).join(' ')}`.toLowerCase();
    const semanticTokens = new Set(haystack.split(/[^a-z0-9-]+/u).filter(Boolean));
    for (const [contract, vocabulary] of Object.entries(policy.contractVocabulary))
    {
        if (vocabulary.some((word) => semanticTokens.has(word)))
        {
            commitments.add(contract);
        }
    }
    const assertionText = fact.assertions
        .map((assertion) => `${assertion.matcher} ${assertion.actual?.text ?? ''} ${assertion.expected?.text ?? ''}`)
        .join(' ')
        .toLowerCase();
    const observations = fact.observations;
    const missing = [];
    if (commitments.has('bound') && !/(?:n\s*\+\s*1|capacity|limit|bound|greater|less|equal)/u.test(assertionText))
    {
        missing.push('bound requires an exact boundary or N/N+1 outcome');
    }
    if (commitments.has('performance')
        && (!/(?:budget|p95|p99|latency|allocation)/u.test(assertionText) || fact.calls.production.length === 0))
    {
        missing.push('performance requires a budget, sample owner and production measurement');
    }
    if (commitments.has('cache') && observations.collaborator.length === 0 && observations.filesystem.length === 0)
    {
        missing.push('cache requires independent I/O or collaborator call evidence');
    }
    if (commitments.has('atomicity') && !/(?:conflict|duplicate|repeat|concurr|race|state)/u.test(assertionText))
    {
        missing.push('atomicity requires repeated/conflicting operations and side-effect state');
    }
    if (commitments.has('negative') && observations.state.length === 0 && observations.return.length === 0)
    {
        missing.push('negative membership requires excluded target plus a valid control outcome');
    }
    if (commitments.has('forbidden-path') && observations.collaborator.length === 0 && observations.process.length === 0)
    {
        missing.push('forbidden path requires a call/resource boundary observer');
    }
    if (missing.length > 0)
    {
        violations.push(violation(
            'TQ-CONTRACT-ORACLE',
            fact,
            missing.join('; '),
            'add the minimum observer named by the committed contract vocabulary'
        ));
    }
    return violations;
}

function evaluateCase(fact, inventoryCase, policy, membership)
{
    if (membership?.outcome === 'not-selected')
    {
        return { testId: fact.testId, outcome: 'not-applicable', violations: [], waived: [], diagnostics: [] };
    }
    const violations = [];
    if (fact.status !== 'resolved')
    {
        violations.push(violation(
            'TQ-UNRESOLVED-FACTS',
            fact,
            fact.status === 'dynamic-obligation'
                ? `dynamic case requires ${fact.controlFlow.dynamicObligation}`
                : fact.diagnostics.join('; ') || 'oracle/control-flow facts are unresolved',
            'produce current adapter facts or bind the dynamic case to a structured runtime receipt'
        ));
    }
    const structuredOutcome = fact.observations.evidence.length > 0;
    const reachable = fact.assertions.filter((assertion) => assertion.reachability === 'reachable').length
        + fact.expectedOutcomes.length
        + (structuredOutcome ? 1 : 0);
    if (reachable === 0)
    {
        violations.push(violation(
            'TQ-ZERO-OUTCOME',
            fact,
            'no reachable assertion, expected throw/reject, or structured verifier outcome exists',
            'observe at least one production postcondition on every normal path'
        ));
    }
    if (fact.controlFlow.earlyExits.length > 0 && fact.controlFlow.allNormalPathsObserved !== true)
    {
        violations.push(violation(
            'TQ-EARLY-RETURN',
            fact,
            `normal completion may bypass an outcome through ${fact.controlFlow.earlyExits.join(', ')}`,
            'express non-applicability in planned membership or assert each normal branch'
        ));
    }
    if (fact.assertions.some((assertion) => assertion.reachability === 'unreachable'))
    {
        violations.push(violation(
            'TQ-UNREACHABLE-ORACLE',
            fact,
            'an assertion is only present on a statically unreachable path',
            'move the assertion to an executable normal path'
        ));
    }
    if (fact.testInvocations.length > 0)
    {
        violations.push(violation(
            'TQ-TEST-TO-TEST',
            fact,
            `discoverable test invokes ${fact.testInvocations.join(', ')}`,
            'extract a non-discoverable helper and assert its production outcome'
        ));
    }
    if (/(?:worker|child|helper)/iu.test(fact.displayName)
        && inventoryCase?.identity !== 'dynamic'
        && fact.calls.production.length === 0
        && reachable === 0)
    {
        violations.push(violation(
            'TQ-DISCOVERABLE-WORKER',
            fact,
            'a discoverable worker/helper can complete successfully without parent verification',
            'make the worker non-discoverable and verify PID, exit, state and receipt from its parent'
        ));
    }
    violations.push(...weakAssertionViolations(fact));
    violations.push(...contractViolations(fact, policy));

    const critical = (inventoryCase?.traits ?? []).some((trait) => (
        trait.name === 'Risk' && trait.value === 'critical'
    )) || /(?:security|auth|permission|contract|binary|release)/iu.test(fact.ownerFile);
    if (critical && fact.assertions.length > 0
        && fact.assertions.every((assertion) => (
            assertion.matcher === 'toBe' && normalizeExpression(assertion.expected?.text) === '200'
        )))
    {
        violations.push(violation(
            'TQ-HTTP-200-ONLY-CRITICAL',
            fact,
            'critical behavior is observed only through HTTP 200',
            'assert the critical response/state contract in addition to transport success'
        ));
    }
    if (critical
        && fact.assertions.length > 0
        && fact.assertions.every((assertion) => assertion.matcher === 'doesNotThrow')
        && !hasIndependentStateObservation(fact))
    {
        violations.push(violation(
            'TQ-CONTRACT-ORACLE',
            fact,
            'critical behavior is observed only as does-not-throw',
            'assert an independent critical state, side-effect or boundary contract'
        ));
    }
    if (critical && fact.assertions.length > 0
        && fact.assertions.every((assertion) => /Snapshot/u.test(assertion.matcher)))
    {
        violations.push(violation(
            'TQ-SNAPSHOT-ONLY-CRITICAL',
            fact,
            'critical behavior is observed only through a snapshot',
            'add an independent semantic assertion for the critical contract'
        ));
    }

    const waiverByIdentity = new Map(policy.waivers.map((waiver) => [`${waiver.testId}\n${waiver.ruleId}`, waiver]));
    const waived = [];
    const active = [];
    for (const item of violations)
    {
        const waiver = waiverByIdentity.get(`${fact.testId}\n${item.ruleId}`);
        if (waiver)
        {
            waived.push({ ruleId: item.ruleId, owner: waiver.owner, expires: waiver.expires, replacementEvidence: waiver.replacementEvidence });
        }
        else
        {
            active.push(item);
        }
    }
    const unresolved = active.some((item) => item.ruleId === 'TQ-UNRESOLVED-FACTS');
    return {
        testId: fact.testId,
        outcome: unresolved ? 'unresolved-failed' : active.length > 0 ? 'failed' : 'passed',
        violations: active,
        waived,
        diagnostics: fact.diagnostics
    };
}

export function evaluateQuality({ inventory, oracleFacts, policy, membershipByTestId = new Map() })
{
    validateQualityPolicy(policy);
    if (oracleFacts.inventoryDigest !== inventory.inventoryDigest)
    {
        throw new Error('oracle facts inventory digest does not match canonical inventory');
    }
    const inventoryById = new Map((inventory.testCases ?? []).map((testCase) => [testCase.id, testCase]));
    const factsById = new Map((oracleFacts.cases ?? []).map((testCase) => [testCase.testId, testCase]));
    if (inventoryById.size !== factsById.size)
    {
        throw new Error('canonical inventory and oracle facts case counts differ');
    }
    const cases = [];
    for (const [testId, inventoryCase] of [...inventoryById.entries()].sort(([left], [right]) => left.localeCompare(right)))
    {
        const fact = factsById.get(testId);
        if (!fact)
        {
            throw new Error(`oracle facts missing canonical test ${testId}`);
        }
        cases.push(evaluateCase(fact, inventoryCase, policy, membershipByTestId.get(testId)));
    }
    const counts = Object.fromEntries([...terminalOutcomes].sort().map((outcome) => [
        outcome,
        cases.filter((item) => item.outcome === outcome).length
    ]));
    const result = {
        engineVersion: QUALITY_ENGINE_VERSION,
        policyVersion: policy.version,
        policyDigest: policyDigest(policy),
        inventoryDigest: inventory.inventoryDigest,
        oracleFactsDigest: oracleFacts.contentDigest,
        counts,
        cases,
        violations: cases.flatMap((item) => item.violations),
        waived: cases.flatMap((item) => item.waived.map((waiver) => ({ testId: item.testId, ...waiver })))
    };
    result.contentDigest = contentDigest(result);
    return result;
}

export function qualityRuleIds()
{
    return [...ruleIds].sort();
}
