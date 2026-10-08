import { exactIds } from './adapter-support.mjs';
import { browserContractOutcomeProducerId, readBrowserContractOutcomeArtifact } from './browser-contract-adapter.mjs';
import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { BrowserContractFailure } = await import(new URL('../../../tests/browser-contract/contract-core.mjs', import.meta.url));
const bindingFields = ['identity', 'attemptEligibility', 'policyDigest', 'runtimeIdentities'];
const memberFields = ['id', 'projectId', 'browserId', 'testId', 'assertionId'];

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(`browser assertion report: ${message}`);
    }
}

function exactKeys(value, fields, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()), `${label} fields mismatch`);
}

function same(actual, expected, label)
{
    requireCondition(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function readDocument(repositoryRoot, reference, schema, fields, authority)
{
    const document = JSON.parse(readBrowserContractOutcomeArtifact(repositoryRoot, reference).toString('utf8'));
    exactKeys(document, ['schema', ...bindingFields, ...fields, 'contentDigest'], schema);
    const { contentDigest, ...unsigned } = document;
    requireCondition(document.schema === schema && contentDigest === digestCanonical(unsigned), `${schema} seal mismatch`);
    for (const field of bindingFields)
    {
        same(document[field], authority[field], `held ${field}`);
    }
    return document;
}

/**
 * Record actual explicitly identified assertion calls against held sealed inputs.
 * The producer owns call-site IDs, capture functions and structured infrastructure
 * classification. This recorder creates report data, never runtime authority or
 * a qualified outcome. Native runner verification remains with the consumer.
 */
export function createBrowserContractAssertionReport({
    repositoryRoot, authority: heldAuthority, catalogReference, planReference, runnerReference
})
{
    exactKeys(heldAuthority, bindingFields, 'held report authority');
    const authority = structuredClone(heldAuthority);
    requireCondition(authority.identity?.producerId === browserContractOutcomeProducerId, 'producer mismatch');
    readBrowserContractOutcomeArtifact(repositoryRoot, runnerReference);
    const runner = structuredClone(runnerReference);
    const catalog = readDocument(repositoryRoot, catalogReference, 'fsusblog.browser-contract-outcome-catalog.v1', ['members'], authority);
    const plan = readDocument(repositoryRoot, planReference, 'fsusblog.browser-contract-outcome-plan.v1', ['catalogDigest', 'members'], authority);
    same(plan.members, catalog.members, 'plan/catalog members');
    requireCondition(plan.catalogDigest === catalog.contentDigest, 'plan/catalog digest mismatch');
    requireCondition(Array.isArray(plan.members) && plan.members.length > 0, 'planned assertions are missing');
    const plannedIds = exactIds(plan.members.map((member) => member.id), 'planned assertion IDs');
    const declarations = [];
    for (const member of plan.members)
    {
        exactKeys(member, [...memberFields, 'required', 'artifacts'], 'planned assertion');
        requireCondition(memberFields.every((field) => typeof member[field] === 'string' && member[field].trim() === member[field]
            && member[field].length > 0) && typeof member.required === 'boolean' && Array.isArray(member.artifacts), 'planned assertion is invalid');
        for (const artifact of member.artifacts)
        {
            exactKeys(artifact, ['id', 'kind'], 'planned correctness artifact');
            requireCondition(['dom', 'geometry', 'network', 'screenshot'].includes(artifact.kind), 'unknown correctness artifact kind');
            declarations.push(artifact.id);
        }
    }
    exactIds(declarations, 'planned correctness artifact IDs');
    exactIds(plan.members.map((member) => JSON.stringify(memberFields.slice(1).map((field) => member[field]))), 'planned assertion tuples');
    const planned = new Map(plan.members.map((member) => [member.id, member]));
    const terminals = new Map();
    const active = new Set();
    const unresolved = new Set();
    const artifacts = [];
    const taxonomy = readOutcomeFailureTaxonomy();
    let interruption = null;
    let finalized = null;

    function available(memberId)
    {
        requireCondition(finalized === null && interruption === null, 'report no longer accepts assertions');
        requireCondition(planned.has(memberId) && !terminals.has(memberId) && !active.has(memberId)
            && !unresolved.has(memberId), 'assertion is unknown or already started');
        return planned.get(memberId);
    }

    function failure(kind, member = null)
    {
        const rule = taxonomy.get(kind);
        requireCondition(rule, 'structured canonical failure kind is required');
        const scope = member ? Object.fromEntries(memberFields.slice(1).map((field) => [field, member[field]])) : {};
        const identity = { producerId: browserContractOutcomeProducerId, ...scope };
        for (const field of rule.requiredIdentity)
        {
            if (field === 'producerId')
            {
                continue;
            }
            const value = field === 'attemptNumber' ? authority.attemptEligibility.attemptNumber
                : authority.identity[field] ?? scope[field];
            requireCondition(value !== undefined, `failure kind lacks held ${field}`);
            identity[field] = value;
        }
        return { kind, identity };
    }

    function terminal(member, status, references, failures = [])
    {
        requireCondition(Array.isArray(references), 'correctness references must be an array');
        const ids = exactIds(references.map((reference) => reference.id), 'captured correctness IDs');
        const captured = references.map((reference) =>
        {
            exactKeys(reference, ['id', 'path', 'digest'], 'captured correctness reference');
            const declaration = member.artifacts.find((entry) => entry.id === reference.id);
            requireCondition(declaration, 'capture was not declared as correctness');
            readBrowserContractOutcomeArtifact(repositoryRoot, { path: reference.path, digest: reference.digest });
            return { ...reference, memberId: member.id, kind: declaration.kind, role: 'correctness' };
        });
        if (status === 'passed')
        {
            same(ids, member.artifacts.map((entry) => entry.id).sort(), 'passed correctness captures');
        }
        artifacts.push(...captured);
        terminals.set(member.id, { ...Object.fromEntries(memberFields.map((field) => [field, member[field]])),
            executed: status !== 'skipped', status, artifactIds: ids, failures });
    }

    return Object.freeze({
        /** Run the original assertion callback and preserve its return or thrown error. */
        async runAssertion(memberId, { assertion, capture = async () => [], classifyFailure = null })
        {
            const member = available(memberId);
            requireCondition(typeof assertion === 'function' && typeof capture === 'function'
                && (classifyFailure === null || typeof classifyFailure === 'function'), 'assertion callbacks are invalid');
            active.add(memberId);
            unresolved.add(memberId);
            try
            {
                let value;
                let originalError;
                let rejected = false;
                try
                {
                    value = await assertion();
                }
                catch (error)
                {
                    rejected = true;
                    originalError = error;
                }
                const failures = [];
                if (rejected)
                {
                    const kind = originalError instanceof BrowserContractFailure && originalError.failureClass === 'product'
                        ? 'product.assertion' : classifyFailure?.(originalError);
                    if (kind === undefined)
                    {
                        throw originalError;
                    }
                    failures.push(failure(kind, member));
                }
                try
                {
                    const references = await capture({ status: rejected ? 'failed' : 'passed', value, error: originalError });
                    terminal(member, rejected ? 'failed' : 'passed', references, failures);
                }
                catch (captureError)
                {
                    // Incomplete capture refuses sealing without replacing the original assertion failure.
                    throw rejected ? originalError : captureError;
                }
                unresolved.delete(memberId);
                if (rejected)
                {
                    throw originalError;
                }
                return value;
            }
            finally
            {
                active.delete(memberId);
            }
        },
        /** Record an explicit producer skip; required skips still fail the report. */
        skipAssertion(memberId)
        {
            terminal(available(memberId), 'skipped', []);
        },
        /** Bind an explicit infrastructure event, never an inferred error-message kind. */
        interrupt(kind)
        {
            requireCondition(finalized === null && interruption === null && kind.startsWith('infra.'), 'interruption is invalid');
            interruption = failure(kind);
        },
        /** Seal complete terminals; infrastructure interruption fills only unstarted members. */
        finalize(diagnostics = {})
        {
            requireCondition(active.size === 0 && unresolved.size === 0, 'started assertion lacks a recorded terminal');
            if (finalized !== null)
            {
                return structuredClone(finalized);
            }
            requireCondition(interruption !== null || terminals.size === planned.size, 'assertion terminals are incomplete');
            const members = plannedIds.map((id) => terminals.get(id) ?? {
                ...Object.fromEntries(memberFields.map((field) => [field, planned.get(id)[field]])),
                executed: false, status: 'blocked', artifactIds: [], failures: []
            });
            const successful = interruption === null && members.every((member) => member.status === 'passed'
                || member.status === 'skipped' && !planned.get(member.id).required);
            finalized = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-report.v1', ...authority,
                catalogDigest: catalog.contentDigest, planDigest: plan.contentDigest,
                groupStatus: successful ? 'success' : 'failed', members, artifacts,
                interruption, diagnostics: { ...structuredClone(diagnostics), runnerReceipt: runner } });
            return structuredClone(finalized);
        }
    });
}
