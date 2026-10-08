import { URL } from 'node:url';

import { exactKeys, requireDigest, verifyCandidateIdentity, diffCandidateIdentities } from './identity-contract.mjs';

const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

export const cohortLedgerSchema = 'fsusblog.release-candidate-cohort-ledger.v1';
const memberFields = ['candidateIdentity', 'runId', 'schedulerRunId', 'runtimeNamespace', 'freshCleanupReceiptDigest',
    'runReceiptRef', 'outcomeFingerprint', 'membershipStatus'];

function semanticId(value, label)
{
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
        || ['latest', 'current', 'newest'].includes(value))
    {
        throw new Error(`${label} must be an explicit concrete semantic ID`);
    }
}

function metadataTime(value)
{
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    {
        throw new Error('cohort metadata time must be canonical UTC');
    }
}

export function validateRunReceiptRef(reference)
{
    exactKeys(reference, ['path', 'contentDigest'], 'run receipt ref');
    requireDigest(reference.contentDigest, 'run receipt contentDigest');
    if (typeof reference.path !== 'string' || !reference.path || reference.path.startsWith('/') || reference.path.includes('\\')
        || reference.path.split('/').some((part) => !part || ['..', '.', 'latest', 'newest', 'current'].includes(part)))
    {
        throw new Error('run receipt ref must be explicit and root-relative without latest/history selection');
    }
    return reference;
}

function validateMember(member, identity)
{
    exactKeys(member, memberFields, 'cohort member');
    verifyCandidateIdentity(member.candidateIdentity);
    const diff = diffCandidateIdentities(identity, member.candidateIdentity);
    if (diff.length)
    {
        throw new Error(`cohort candidate mismatch: ${diff.map((item) => item.field).join(', ')}`);
    }
    for (const field of ['runId', 'schedulerRunId', 'runtimeNamespace'])
    {
        semanticId(member[field], field);
    }
    requireDigest(member.freshCleanupReceiptDigest, 'fresh cleanup receipt digest');
    requireDigest(member.outcomeFingerprint, 'outcome fingerprint');
    validateRunReceiptRef(member.runReceiptRef);
    if (!['success', 'failed', 'cancelled', 'partial', 'infra-failure'].includes(member.membershipStatus))
    {
        throw new Error('cohort membership status must retain the actual terminal outcome');
    }
}

function verifySeal(document)
{
    requireDigest(document.contentDigest, 'cohort contentDigest');
    if (sealContentDigest(document).contentDigest !== document.contentDigest)
    {
        throw new Error('cohort content digest mismatch');
    }
}

function verifyRoot(root)
{
    exactKeys(root, ['schema', 'cohortId', 'instanceKey', 'candidateIdentity', 'candidateIdentityDigest',
        'createdByCommand', 'createdAt', 'previousDigest', 'contentDigest'], 'cohort root');
    if (root.schema !== 'fsusblog.release-candidate-cohort-root.v1' || root.createdByCommand !== 'create-cohort'
        || root.previousDigest !== null)
    {
        throw new Error('invalid cohort root schema/command/previous digest');
    }
    semanticId(root.instanceKey, 'cohort instance key');
    verifyCandidateIdentity(root.candidateIdentity);
    metadataTime(root.createdAt);
    if (root.candidateIdentityDigest !== root.candidateIdentity.candidateIdentityDigest
        || root.cohortId !== digestCanonical({ candidateIdentityDigest: root.candidateIdentityDigest, instanceKey: root.instanceKey }))
    {
        throw new Error('cohort root candidate/content address mismatch');
    }
    verifySeal(root);
}

/** Pure ledger contract. The caller must independently verify the identity plan
 * and domain receipts before creating a store or presenting a member. */
export function createCohortLedger(identity, { instanceKey, createdAt } = {})
{
    verifyCandidateIdentity(identity);
    semanticId(instanceKey, 'cohort instance key');
    metadataTime(createdAt);
    const root = sealContentDigest({
        schema: 'fsusblog.release-candidate-cohort-root.v1',
        cohortId: digestCanonical({ candidateIdentityDigest: identity.candidateIdentityDigest, instanceKey }),
        instanceKey, candidateIdentity: JSON.parse(canonicalJson(identity)), candidateIdentityDigest: identity.candidateIdentityDigest,
        createdByCommand: 'create-cohort', createdAt, previousDigest: null
    });
    return sealContentDigest({ schema: cohortLedgerSchema, root, events: [], sealed: false });
}

/** Verify the whole chain against an explicit externally held ledger digest.
 * Without that anchor, a truncated historical prefix cannot be distinguished
 * from the original ledger at that earlier time. */
export function verifyCohortLedger(ledger, { expectedDigest } = {})
{
    exactKeys(ledger, ['schema', 'root', 'events', 'sealed', 'contentDigest'], 'cohort ledger');
    if (ledger.schema !== cohortLedgerSchema || !Array.isArray(ledger.events) || typeof ledger.sealed !== 'boolean')
    {
        throw new Error('invalid cohort ledger schema/events/seal');
    }
    requireDigest(expectedDigest, 'explicit expected ledger digest');
    verifyRoot(ledger.root);
    verifySeal(ledger);
    if (expectedDigest !== ledger.contentDigest)
    {
        throw new Error('cohort ledger differs from explicit expected digest');
    }
    let previousDigest = ledger.root.contentDigest;
    let sealed = false;
    const members = [];
    const ordinals = new Set();
    const identities = Object.fromEntries(['runId', 'schedulerRunId', 'runtimeNamespace', 'freshCleanupReceiptDigest']
        .map((field) => [field, new Set()]));
    for (const [index, event] of ledger.events.entries())
    {
        exactKeys(event, ['schema', 'sequence', 'type', 'previousDigest', 'addedAt', 'ordinal', 'member', 'contentDigest'], 'cohort event');
        if (event.schema !== 'fsusblog.release-candidate-cohort-event.v1' || event.sequence !== index + 1
            || event.previousDigest !== previousDigest || sealed || !['append-run', 'seal'].includes(event.type))
        {
            throw new Error('cohort digest chain/order/sealed transition mismatch');
        }
        metadataTime(event.addedAt);
        verifySeal(event);
        if (event.type === 'seal')
        {
            if (event.ordinal !== null || event.member !== null)
            {
                throw new Error('cohort seal cannot modify members');
            }
            sealed = true;
        }
        else
        {
            if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 1 || ordinals.has(event.ordinal))
            {
                throw new Error('cohort ordinal must be positive and unique');
            }
            validateMember(event.member, ledger.root.candidateIdentity);
            for (const [field, values] of Object.entries(identities))
            {
                if (values.has(event.member[field]))
                {
                    throw new Error(`cohort independent member boundary reused: ${field}`);
                }
                values.add(event.member[field]);
            }
            ordinals.add(event.ordinal);
            members.push({ ordinal: event.ordinal, ...event.member });
        }
        previousDigest = event.contentDigest;
    }
    if (ledger.sealed !== sealed)
    {
        throw new Error('cohort sealed flag is not the terminal chain state');
    }
    return { cohortId: ledger.root.cohortId, candidateIdentity: ledger.root.candidateIdentity,
        rootDigest: ledger.root.contentDigest, terminalDigest: previousDigest, contentDigest: ledger.contentDigest, members, sealed };
}

export function appendCohortLedger(ledger, { ordinal, member, addedAt, expectedDigest })
{
    const inspected = verifyCohortLedger(ledger, { expectedDigest });
    if (inspected.sealed)
    {
        throw new Error('cohort is sealed');
    }
    const event = sealContentDigest({ schema: 'fsusblog.release-candidate-cohort-event.v1', sequence: ledger.events.length + 1,
        type: 'append-run', previousDigest: inspected.terminalDigest, addedAt, ordinal, member: JSON.parse(canonicalJson(member)) });
    const next = sealContentDigest({ schema: cohortLedgerSchema, root: ledger.root, events: [...ledger.events, event], sealed: false });
    verifyCohortLedger(next, { expectedDigest: next.contentDigest });
    return next;
}

export function sealCohortLedger(ledger, { addedAt, expectedDigest })
{
    const inspected = verifyCohortLedger(ledger, { expectedDigest });
    if (inspected.sealed)
    {
        throw new Error('cohort is already sealed');
    }
    const event = sealContentDigest({ schema: 'fsusblog.release-candidate-cohort-event.v1', sequence: ledger.events.length + 1,
        type: 'seal', previousDigest: inspected.terminalDigest, addedAt, ordinal: null, member: null });
    return sealContentDigest({ schema: cohortLedgerSchema, root: ledger.root, events: [...ledger.events, event], sealed: true });
}
