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
        exactSet(membership.executedTestIds, [...membership.passedTestIds, ...membership.failedTestIds], 'executed tests');
        exactSet(membership.plannedTestIds, [...membership.executedTestIds, ...membership.skippedTestIds,
            ...membership.blockedTestIds], 'planned tests');
    }
    if (entry.family === 'browser')
    {
        exactSet(membership.plannedMemberIds, membership.members.map((member) => member.id), 'browser member records');
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
