/* eslint-disable import-x/no-relative-parent-imports -- Compose the canonical DATA_ONLY schema and candidate authorities. */
import fs from 'node:fs';

import { validateJsonSchema } from '../schema-validator/validate.mjs';

import { validateProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const source = (path) => JSON.parse(fs.readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`outcome adapter profile: ${message}`);
    }
}

export function readOutcomeAdapterCatalog()
{
    const catalog = source('config/testing/outcome-adapter-catalog.json');
    const errors = validateJsonSchema(catalog, source('config/schemas/outcome-adapter-catalog.schema.json'));
    require(errors.length === 0, errors.join('; '));
    const ids = catalog.entries.flatMap((entry) => entry.producerIds);
    require(new Set(ids).size === ids.length, 'producer registration is ambiguous');
    const shapes = source(catalog.membershipSchema);
    for (const entry of catalog.entries)
    {
        require(entry.producerIds.length > 0 && shapes.$defs[entry.family]
            && entry.membershipSchema === `#/$defs/${entry.family}`, 'unresolved membership contract');
    }
    return catalog;
}

function exactSet(left, right, label)
{
    require(new Set(left).size === left.length && new Set(right).size === right.length
        && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()), `${label} is not exact`);
}

/**
 * Validate encoded DATA_ONLY adapter candidates against their registered source
 * identity and complete member schema. Expectations and maxBytes are host-owned.
 * This is not an execution verifier, fingerprint, seal or producer qualification.
 * Existing-v2 normalization and domain schema readiness are deliberately distinct;
 * richer maps/scoped failure normalization remain with the #2025 authority.
 */
export function validateOutcomeAdapterCandidateData(encodedCandidate, encodedExpected, maxBytes)
{
    require(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'explicit host byte budget required');
    for (const encoded of [encodedCandidate, encodedExpected])
    {
        require(typeof encoded === 'string' && encoded.length <= maxBytes
            && Buffer.byteLength(encoded) <= maxBytes, 'encoded input exceeds host budget');
    }
    const candidate = JSON.parse(encodedCandidate);
    const expected = JSON.parse(encodedExpected);
    const catalog = readOutcomeAdapterCatalog();
    const entry = catalog.entries.find((item) => item.producerIds.includes(candidate.producerId));
    require(entry && entry.authorityId === candidate.producerAuthorityId, 'producer/authority is not registered');
    require(expected.sourceCommit === entry.sourceCommit && expected.sourceDigest === entry.sourceDigest,
        'adapter source identity mismatch');
    require(digestCanonical(candidate.identity) === digestCanonical(expected.identity)
        && candidate.contentDigest === expected.candidateDigest, 'independent candidate identity/digest mismatch');
    validateProducerSemanticOutcomeCandidate(candidate, { expectedProducerId: candidate.producerId,
        expectedAuthorityId: entry.authorityId });
    require(candidate.outcome.semanticPayloadDigest === digestCanonical(candidate.outcome.membership),
        'membership content digest mismatch');
    const shapes = source(catalog.membershipSchema);
    const errors = validateJsonSchema(candidate.outcome.membership, { ...shapes, $ref: entry.membershipSchema });
    require(errors.length === 0, errors.join('; '));
    const membership = candidate.outcome.membership;
    if (['backend', 'frontend'].includes(entry.family))
    {
        exactSet(membership.plannedTestIds, [...membership.passedTestIds, ...membership.failedTestIds,
            ...membership.skippedTestIds, ...membership.blockedTestIds], 'planned tests');
        require(candidate.outcome.status !== 'success' || membership.plannedTestIds.length === membership.passedTestIds.length,
            'successful tests conceal an unpassed member');
        for (const assertion of membership.assertions)
        {
            require(membership.plannedTestIds.includes(assertion.testId), 'assertion refers to an unplanned test');
        }
    }
    if (entry.family === 'backend')
    {
        exactSet(membership.executedTestIds, [...membership.passedTestIds, ...membership.failedTestIds], 'executed tests');
        const cases = membership.caseIdentities.map((item) => JSON.stringify([item.testId, item.caseId]));
        require(new Set(cases).size === cases.length, 'duplicate backend case identity');
        exactSet([...new Set(membership.caseIdentities.map((item) => item.testId))], membership.executedTestIds,
            'backend executed case roster');
        const assertions = membership.assertions.map((item) => JSON.stringify([item.testId, item.caseId, item.assertionId]));
        require(new Set(assertions).size === assertions.length && membership.assertions.every((item) =>
            cases.includes(JSON.stringify([item.testId, item.caseId]))), 'backend assertion/case identity mismatch');
    }
    if (entry.family === 'frontend')
    {
        // The exact native adapter permits an aborted blocked test to have begun
        // execution. Preserve that distinction instead of rewriting it as failed.
        require([...membership.passedTestIds, ...membership.failedTestIds].every((id) => membership.executedTestIds.includes(id))
            && membership.executedTestIds.every((id) => [...membership.passedTestIds, ...membership.failedTestIds,
                ...membership.blockedTestIds].includes(id)), 'frontend executed membership mismatch');
        exactSet(membership.plannedSuiteIds, Object.keys(membership.suiteTestIds), 'frontend suite map');
        exactSet(membership.plannedTestIds, Object.values(membership.suiteTestIds).flat(), 'frontend suite test roster');
        require(membership.parameterizedTestIds.every((id) => membership.plannedTestIds.includes(id)),
            'unplanned parameterized test');
        for (const status of ['planned', 'executed', 'passed', 'failed', 'skipped', 'blocked'])
        {
            exactSet(membership[`${status}ParameterizedTestIds`], membership[`${status}TestIds`]
                .filter((id) => membership.parameterizedTestIds.includes(id)), 'frontend parameterized status');
        }
        for (const status of ['executed', 'passed', 'failed', 'skipped', 'blocked'])
        {
            const suites = Object.entries(membership.suiteTestIds).filter(([, members]) => status === 'executed'
                ? members.some((id) => membership.executedTestIds.includes(id))
                : (['failed', 'blocked', 'skipped'].find((terminal) => members.some((id) =>
                    membership[`${terminal}TestIds`].includes(id))) ?? 'passed') === status).map(([id]) => id);
            exactSet(membership[`${status}SuiteIds`], suites, 'frontend suite status');
        }
    }
    if (entry.family === 'browser')
    {
        exactSet(membership.plannedMemberIds, membership.members.map((member) => member.id), 'browser member records');
        for (const axis of ['Project', 'Browser', 'Test', 'Assertion'])
        {
            const field = `${axis[0].toLowerCase()}${axis.slice(1)}Id`;
            exactSet(membership[`planned${axis}Ids`], [...new Set(membership.members.map((member) => member[field]))],
                'browser planned identity axes');
        }
        exactSet(membership.executedMemberIds, membership.members.filter((member) => member.executed).map((member) => member.id),
            'browser executed members');
        for (const status of ['passed', 'failed', 'skipped', 'blocked'])
        {
            exactSet(membership[`${status}MemberIds`], membership.members.filter((member) => member.status === status)
                .map((member) => member.id), 'browser terminal members');
        }
        for (const member of membership.members)
        {
            require(member.executed === ['passed', 'failed'].includes(member.status), 'browser execution/status mismatch');
            require(candidate.outcome.status !== 'success' || !member.required || member.status === 'passed',
                'browser success conceals a required member');
        }
    }
    if (entry.family === 'reliability')
    {
        exactSet(membership.scenarioIds, membership.memberOutcomes.map((member) => member.scenarioId), 'reliability scenarios');
        for (const member of membership.memberOutcomes)
        {
            require(!['not-reached', 'precondition-failure'].includes(member.terminalClassification)
                || !member.executed && member.semanticEvidence === null, 'unspawned reliability member has semantic evidence');
            require(candidate.outcome.status !== 'success' || member.terminalClassification === 'qualified-success',
                'reliability success conceals an unqualified member');
        }
    }
    return Object.freeze({ dataOnly: true, producerVerificationPending: true,
        producerId: candidate.producerId, authorityId: entry.authorityId,
        sourceCommit: entry.sourceCommit, sourceDigest: entry.sourceDigest,
        normalizationStatus: entry.normalizationStatus, candidateDigest: candidate.contentDigest,
        catalogDigest: digestCanonical(catalog), membershipSchemaDigest: digestCanonical(shapes) });
}
