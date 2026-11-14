import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { candidate, exactIds, reason } from './adapter-support.mjs';
import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

export const browserContractOutcomeProducerId = 'browser-contract-semantic-outcome';
const authorityId = 'tools/test-matrix/outcomes/browser-contract-adapter.mjs';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const semanticKinds = new Set(['dom', 'geometry', 'network', 'screenshot']);
const diagnosticKinds = new Set(['trace', 'video', 'log', ...semanticKinds]);
const memberFields = ['id', 'projectId', 'browserId', 'testId', 'assertionId'];
const bindingFields = ['identity', 'attemptEligibility', 'policyDigest', 'runtimeIdentities'];
const inputKinds = ['browser-contract-plan', 'browser-contract-catalog', 'browser-contract-report'];

function requireCondition(condition, label)
{
    if (!condition)
    {
        throw new Error(`browser outcome: ${label}`);
    }
}

function exactKeys(value, fields, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()),
    `${label} fields do not exactly match the contract`);
}

function same(actual, expected, label)
{
    requireCondition(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function text(value, label)
{
    requireCondition(typeof value === 'string' && value.trim() === value && value.length > 0, `${label} is invalid`);
    return value;
}

function sha256(bytes)
{
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifact(root, reference)
{
    requireCondition(digestPattern.test(reference.digest), 'artifact digest is invalid');
    const relative = text(reference.path, 'artifact path');
    requireCondition(!path.isAbsolute(relative) && !relative.includes('\\')
        && relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    'artifact path must be contained and canonical');
    let current = root;
    for (const segment of relative.split('/'))
    {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current);
        requireCondition(!stat.isSymbolicLink(), 'artifact path contains a symlink');
    }
    requireCondition(fs.lstatSync(current).isFile(), 'artifact must be a regular file');
    const descriptor = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const stat = fs.fstatSync(descriptor);
        requireCondition(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'artifact must be a bounded regular file');
        const bytes = fs.readFileSync(descriptor);
        requireCondition(bytes.length <= 16 * 1024 * 1024 && sha256(bytes) === reference.digest,
            'artifact content digest mismatch');
        return bytes;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

/** Reopen a caller-held byte reference using the adapter's contained reader. */
export function readBrowserContractOutcomeArtifact(repositoryRoot, reference)
{
    exactKeys(reference, ['path', 'digest'], 'held browser artifact reference');
    return readArtifact(fs.realpathSync(repositoryRoot), reference);
}

function readDocument(root, reference, schema, fields)
{
    const value = JSON.parse(readArtifact(root, reference).toString('utf8'));
    exactKeys(value, ['schema', ...bindingFields, ...fields, 'contentDigest'], schema);
    requireCondition(value.schema === schema, `${schema} schema mismatch`);
    const { contentDigest, ...unsigned } = value;
    requireCondition(digestPattern.test(contentDigest) && contentDigest === digestCanonical(unsigned),
        `${schema} receipt seal mismatch`);
    return value;
}

function bindDocument(document, authority)
{
    for (const field of bindingFields)
    {
        same(document[field], authority[field], `held ${field}`);
    }
}

function validateRuntimeIdentities(runtimeIdentities, members)
{
    requireCondition(Array.isArray(runtimeIdentities), 'runtime identities must be an array');
    const actual = runtimeIdentities.map((entry) =>
    {
        exactKeys(entry, ['projectId', 'browserId', 'runtimeDigest'], 'browser runtime identity');
        text(entry.projectId, 'runtime projectId');
        text(entry.browserId, 'runtime browserId');
        requireCondition(digestPattern.test(entry.runtimeDigest), 'browser runtime digest is invalid');
        return JSON.stringify([entry.projectId, entry.browserId]);
    });
    same(exactIds(actual, 'runtime pairs'), [...new Set(members.map((member) =>
        JSON.stringify([member.projectId, member.browserId])))].sort(), 'planned runtime pairs');
}

function canonicalFailure(failure, authority, taxonomy, member = null)
{
    exactKeys(failure, ['kind', 'identity'], 'failure');
    const rule = taxonomy.get(failure.kind);
    requireCondition(rule, `unknown canonical failure kind ${failure.kind}`);
    const scope = member ? Object.fromEntries(memberFields.slice(1).map((field) => [field, member[field]])) : {};
    const expected = { producerId: browserContractOutcomeProducerId, ...scope };
    for (const field of rule.requiredIdentity)
    {
        if (field === 'producerId')
        {
            continue;
        }
        const value = field === 'attemptNumber' ? authority.attemptEligibility.attemptNumber
            : (Object.hasOwn(authority.identity, field) ? authority.identity[field] : scope[field]);
        requireCondition(value !== undefined, `failure ${failure.kind} has no held ${field}`);
        expected[field] = value;
    }
    same(failure.identity, expected, 'canonical failure identity');
    return reason(failure.kind, browserContractOutcomeProducerId, expected);
}

/**
 * Consume independently held byte references to sealed Browser member documents.
 * Authority must come from the existing plan/attempt/runtime owners. This creates
 * candidate-v1 only; it does not qualify a run or authorize downstream sealing.
 */
export function adaptBrowserContractSemanticOutcome({ repositoryRoot, authority })
{
    exactKeys(authority, [...bindingFields, 'inputAuthorityRefs'], 'held browser authority');
    requireCondition(authority.identity?.producerId === browserContractOutcomeProducerId, 'held producer mismatch');
    requireCondition(digestPattern.test(authority.policyDigest), 'held policy digest is invalid');
    const attempt = authority.attemptEligibility;
    exactKeys(attempt, ['aggregateDigest', 'attemptDigest', 'attemptNumber', 'cleanFirstAttempt',
        'firstFailure', 'qualificationEligible'], 'held attempt eligibility');
    requireCondition(Number.isSafeInteger(attempt.attemptNumber) && attempt.attemptNumber > 0
        && digestPattern.test(attempt.aggregateDigest) && digestPattern.test(attempt.attemptDigest)
        && ['cleanFirstAttempt', 'firstFailure', 'qualificationEligible'].every((field) => typeof attempt[field] === 'boolean'),
    'held attempt eligibility is invalid');
    const references = authority.inputAuthorityRefs;
    requireCondition(Array.isArray(references), 'held input references are required');
    same(exactIds(references.map((reference) => reference.kind), 'held input kinds'), [...inputKinds].sort(), 'held input kinds');
    for (const reference of references)
    {
        exactKeys(reference, ['kind', 'path', 'digest'], 'held input reference');
    }
    const root = fs.realpathSync(repositoryRoot);
    const byKind = new Map(references.map((reference) => [reference.kind, reference]));
    const catalog = readDocument(root, byKind.get('browser-contract-catalog'),
        'fsusblog.browser-contract-outcome-catalog.v1', ['members']);
    const plan = readDocument(root, byKind.get('browser-contract-plan'),
        'fsusblog.browser-contract-outcome-plan.v1', ['catalogDigest', 'members']);
    const report = readDocument(root, byKind.get('browser-contract-report'),
        'fsusblog.browser-contract-outcome-report.v1',
        ['catalogDigest', 'planDigest', 'groupStatus', 'members', 'artifacts', 'interruption', 'diagnostics']);
    for (const document of [catalog, plan, report])
    {
        bindDocument(document, authority);
    }
    requireCondition(plan.catalogDigest === catalog.contentDigest && report.catalogDigest === catalog.contentDigest
        && report.planDigest === plan.contentDigest, 'plan/catalog/report binding mismatch');
    requireCondition(Array.isArray(plan.members) && plan.members.length > 0, 'sealed plan must declare members');
    same(plan.members, catalog.members, 'sealed plan/catalog membership');
    const plannedIds = exactIds(plan.members.map((member) => member.id), 'planned member IDs');
    const plannedTuples = [];
    const declarations = new Map();
    for (const member of plan.members)
    {
        exactKeys(member, [...memberFields, 'required', 'artifacts'], 'planned member');
        for (const field of memberFields)
        {
            text(member[field], `planned ${field}`);
        }
        requireCondition(typeof member.required === 'boolean' && Array.isArray(member.artifacts), 'planned member declaration is invalid');
        plannedTuples.push(JSON.stringify(memberFields.slice(1).map((field) => member[field])));
        for (const artifact of member.artifacts)
        {
            exactKeys(artifact, ['id', 'kind'], 'correctness artifact declaration');
            text(artifact.id, 'correctness artifact ID');
            requireCondition(semanticKinds.has(artifact.kind) && !declarations.has(artifact.id),
                'correctness artifact declaration is duplicate or unknown');
            declarations.set(artifact.id, { ...artifact, memberId: member.id });
        }
    }
    exactIds(plannedTuples, 'planned project/browser/test/assertion tuples');
    validateRuntimeIdentities(authority.runtimeIdentities, plan.members);
    requireCondition(Array.isArray(report.members) && Array.isArray(report.artifacts), 'report membership/artifacts are required');
    const actualIds = exactIds(report.members.map((member) => member.id), 'actual member IDs');
    requireCondition(actualIds.every((id) => plannedIds.includes(id)), 'report contains extra members');
    const taxonomy = readOutcomeFailureTaxonomy();
    const interruption = report.interruption === null ? null : canonicalFailure(report.interruption, authority, taxonomy);
    requireCondition(interruption === null || interruption.kind.startsWith('infra.'), 'interruption must be a canonical infrastructure failure');
    requireCondition(interruption !== null || actualIds.length === plannedIds.length, 'report is missing terminal members');
    const reasons = interruption ? [interruption] : [];
    const actual = new Map(report.members.map((member) => [member.id, member]));
    const artifactIds = exactIds(report.artifacts.map((artifact) => artifact.id), 'actual artifact IDs');
    const artifacts = new Map(report.artifacts.map((artifact) => [artifact.id, artifact]));
    const semanticDigests = new Map();
    const plannedMembers = new Map(plan.members.map((member) => [member.id, member]));
    const members = plannedIds.map((plannedId) =>
    {
        const planned = plannedMembers.get(plannedId);
        const member = actual.get(planned.id);
        if (!member)
        {
            if (planned.required)
            {
                reasons.push(reason('contract.missing-evidence', browserContractOutcomeProducerId, { evidenceId: planned.id }));
            }
            return { ...Object.fromEntries(memberFields.map((field) => [field, planned[field]])),
                required: planned.required, executed: false, status: 'blocked', failureKinds: [], artifactIds: [] };
        }
        exactKeys(member, [...memberFields, 'executed', 'status', 'artifactIds', 'failures'], 'reported member');
        for (const field of memberFields)
        {
            same(member[field], planned[field], `member ${field}`);
        }
        requireCondition(['passed', 'failed', 'skipped', 'blocked'].includes(member.status)
            && typeof member.executed === 'boolean'
            && member.executed === ['passed', 'failed'].includes(member.status), 'member terminal/executed overlap is illegal');
        requireCondition(Array.isArray(member.failures), 'member failures must be an array');
        const failures = member.failures.map((failure) => canonicalFailure(failure, authority, taxonomy, planned));
        exactIds(failures.map((failure) => failure.kind), 'member failure kinds');
        requireCondition((member.status === 'failed') === (failures.length > 0), 'member failure topology is inconsistent');
        requireCondition(member.status !== 'blocked' || interruption !== null, 'blocked member lacks an infrastructure interruption');
        const refs = exactIds(member.artifactIds, 'member artifact IDs');
        requireCondition(member.executed || refs.length === 0, 'unexecuted member has semantic artifacts');
        for (const id of refs)
        {
            const artifact = artifacts.get(id);
            const declaration = declarations.get(id);
            requireCondition(artifact && declaration?.memberId === member.id && artifact.memberId === member.id
                && artifact.role === 'correctness' && artifact.kind === declaration.kind, 'member correctness artifact binding mismatch');
            semanticDigests.set(id, sha256(readArtifact(root, artifact)));
        }
        if (member.status === 'passed')
        {
            same(refs, planned.artifacts.map((artifact) => artifact.id).sort(), 'passed correctness artifact membership');
        }
        reasons.push(...failures);
        if (planned.required && ['skipped', 'blocked'].includes(member.status))
        {
            reasons.push(reason('contract.missing-evidence', browserContractOutcomeProducerId, { evidenceId: member.id }));
        }
        return { ...Object.fromEntries(memberFields.map((field) => [field, planned[field]])),
            required: planned.required, executed: member.executed, status: member.status,
            failureKinds: failures.map((failure) => failure.kind).sort(), artifactIds: refs };
    });
    for (const id of artifactIds)
    {
        const artifact = artifacts.get(id);
        exactKeys(artifact, ['id', 'memberId', 'kind', 'role', 'path', 'digest'], 'reported artifact');
        requireCondition(plannedIds.includes(artifact.memberId) && ['correctness', 'diagnostic'].includes(artifact.role),
            'orphan or unknown artifact role');
        requireCondition(artifact.role === 'correctness' ? semanticDigests.has(id)
            : diagnosticKinds.has(artifact.kind) && !declarations.has(id),
        'orphan semantic artifact or diagnostic promotion');
        text(artifact.path, 'artifact location');
        requireCondition(digestPattern.test(artifact.digest), 'reported artifact digest is invalid');
    }
    const allRequiredPassed = members.every((member) => !member.required || member.status === 'passed');
    const groupPassed = interruption === null && allRequiredPassed && reasons.length === 0;
    requireCondition(['success', 'failed'].includes(report.groupStatus)
        && (report.groupStatus === 'success') === groupPassed, 'group status contradicts member outcomes');
    if (attempt.attemptNumber !== 1 || attempt.cleanFirstAttempt !== true
        || attempt.firstFailure !== false || attempt.qualificationEligible !== true)
    {
        reasons.push(reason('contract.missing-evidence', browserContractOutcomeProducerId, { evidenceId: 'clean-first-attempt' }));
    }
    const ids = (field) => [...new Set(plan.members.map((member) => member[field]))].sort();
    const terminalIds = (status) => members.filter((member) => member.status === status).map((member) => member.id);
    const membership = {
        plannedProjectIds: ids('projectId'), plannedBrowserIds: ids('browserId'),
        plannedTestIds: ids('testId'), plannedAssertionIds: ids('assertionId'),
        plannedMemberIds: plannedIds, executedMemberIds: members.filter((member) => member.executed).map((member) => member.id),
        passedMemberIds: terminalIds('passed'), failedMemberIds: terminalIds('failed'),
        skippedMemberIds: terminalIds('skipped'), blockedMemberIds: terminalIds('blocked'),
        members, interruptionKind: interruption?.kind ?? null,
        artifactSemanticDigests: Object.fromEntries([...semanticDigests.keys()].sort().map((id) => [id, semanticDigests.get(id)]))
    };
    return candidate({ producerId: browserContractOutcomeProducerId, producerAuthorityId: authorityId,
        identity: authority.identity, attemptEligibility: attempt, inputAuthorityRefs: references,
        membership, reasons });
}
