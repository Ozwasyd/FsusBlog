/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { freezeDeep, plainObject } from '../test-fixtures/receipt/canonical.mjs';

import { requireText } from './contract.mjs';

const accessFields = ['reads', 'writes', 'creates', 'deletes', 'invalidates'];
const mutatingFields = ['writes', 'creates', 'deletes', 'invalidates'];

function normalizeStep(entry, label)
{
    if (!plainObject(entry))
    {
        throw new Error(`${label} has no state-domain catalog entry`);
    }
    const stepId = requireText(entry.stepId, `${label}.stepId`);
    if (!['declared', 'none'].includes(entry.stateAccess))
    {
        throw new Error(`${stepId} has an unknown stateAccess`);
    }
    const operations = Object.fromEntries(accessFields.map((field) =>
    {
        if (!Array.isArray(entry[field]))
        {
            if (entry.stateAccess === 'none')
            {
                return [field, new Set()];
            }
            throw new Error(`${stepId}.${field} is missing`);
        }
        return [field, new Set(entry[field])];
    }));
    const exclusive = new Set(entry.exclusiveStateDomains ?? []);
    const commutative = new Map((entry.commutativeWrites ?? []).map((proof) => [proof.domain, proof.verifier]));
    return { stepId, stateAccess: entry.stateAccess, operations, exclusive, commutative };
}

function modesFor(step, domain)
{
    return accessFields.filter((field) => step.operations[field].has(domain));
}

function allDomains(step)
{
    return new Set([
        ...accessFields.flatMap((field) => [...step.operations[field]]),
        ...step.exclusive
    ]);
}

function verifiedCommutativeProof(left, right, domain, verifiedProofs)
{
    const leftProof = left.commutative.get(domain);
    const rightProof = right.commutative.get(domain);
    if (!leftProof || !rightProof || leftProof !== rightProof)
    {
        return null;
    }
    const verified = verifiedProofs instanceof Set
        ? verifiedProofs.has(leftProof)
        : verifiedProofs?.[leftProof] === true;
    return verified ? leftProof : null;
}

/** Pure, symmetric conflict evaluator derived only from catalog entries. */
export function stateConflict(leftEntry, rightEntry, { verifiedProofs = new Set() } = {})
{
    const left = normalizeStep(leftEntry, 'left step');
    const right = normalizeStep(rightEntry, 'right step');
    if (left.stepId === right.stepId)
    {
        throw new Error('stateConflict requires two distinct steps');
    }
    const leftAll = allDomains(left);
    const rightAll = allDomains(right);
    const domains = [...new Set([...leftAll, ...rightAll])].sort();
    const conflicts = [];
    const commutativeProofs = [];
    for (const domain of domains)
    {
        const leftModes = modesFor(left, domain);
        const rightModes = modesFor(right, domain);
        const leftTouches = leftModes.length > 0;
        const rightTouches = rightModes.length > 0;
        if (left.exclusive.has(domain) && rightTouches)
        {
            conflicts.push({ domain, rule: 'exclusive-state-domain', leftModes, rightModes, exclusiveOwner: left.stepId, proof: null });
            continue;
        }
        if (right.exclusive.has(domain) && leftTouches)
        {
            conflicts.push({ domain, rule: 'exclusive-state-domain', leftModes, rightModes, exclusiveOwner: right.stepId, proof: null });
            continue;
        }
        if (!leftTouches || !rightTouches)
        {
            continue;
        }
        const bothWrite = left.operations.writes.has(domain) && right.operations.writes.has(domain);
        if (bothWrite)
        {
            const proof = verifiedCommutativeProof(left, right, domain, verifiedProofs);
            if (proof)
            {
                commutativeProofs.push({ domain, proof });
                continue;
            }
            conflicts.push({
                domain,
                rule: 'write-write-without-verified-commutative-proof',
                leftModes,
                rightModes,
                proof: {
                    left: left.commutative.get(domain) ?? null,
                    right: right.commutative.get(domain) ?? null,
                    verified: false
                }
            });
            continue;
        }
        const leftMutates = mutatingFields.some((field) => left.operations[field].has(domain));
        const rightMutates = mutatingFields.some((field) => right.operations[field].has(domain));
        if (leftMutates || rightMutates)
        {
            const invalidator = left.operations.invalidates.has(domain)
                ? left.stepId
                : right.operations.invalidates.has(domain) ? right.stepId : null;
            const topology = domain.startsWith('network.') || domain.startsWith('runtime.');
            conflicts.push({
                domain,
                rule: invalidator ? 'generation-invalidate-overlap' : topology ? 'topology-mutation-overlap' : 'mutating-access-overlap',
                leftModes,
                rightModes,
                invalidator,
                proof: null
            });
        }
    }
    return freezeDeep({
        leftStepId: left.stepId,
        rightStepId: right.stepId,
        conflict: conflicts.length > 0,
        conflicts,
        commutativeProofs
    });
}

export function createStateConflictPolicy(authority, { verifiedProofs = new Set(), assertCurrent = null } = {})
{
    if (!plainObject(authority?.steps) || typeof authority?.catalogDigest !== 'string')
    {
        throw new Error('state conflict policy requires a validated runtime authority');
    }
    return Object.freeze({
        catalogDigest: authority.catalogDigest,
        assertCurrent,
        evaluate(leftStepId, rightStepId)
        {
            const left = authority.steps[leftStepId];
            const right = authority.steps[rightStepId];
            if (!left || !right)
            {
                throw new Error(`runtime scheduler encountered a step absent from the state catalog: ${!left ? leftStepId : rightStepId}`);
            }
            return stateConflict(left, right, { verifiedProofs });
        }
    });
}
