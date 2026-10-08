import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    canonicalize,
    checkRequiredEvidenceCatalog,
    createRequiredEvidenceCatalogBinding,
    loadCanonicalRequiredEvidenceCatalog,
    validateRequiredEvidenceCatalogBinding
} from './required-evidence-catalog.mjs';

const { sealSourceIdentity } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { governanceContentDigest, validateCurrentRunEvidenceContext } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const projectionSchema = 'fsusblog.required-evidence-dependencies.v1';
const resultSchema = 'fsusblog.required-evidence-dependency-result.v1';
const same = (left, right) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

function validateIdentity(identity)
{
    if (!/^[a-f0-9]{40}$/u.test(identity?.sourceCommit ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(identity?.worktreeFingerprint ?? '')
        || !['source-plan', 'current-run'].includes(identity?.mode)
        || ['runId', 'namespace', 'attempt'].some((field) => typeof identity?.[field] !== 'string' || !identity[field])
        || typeof identity?.candidateIdentity?.id !== 'string' || !identity.candidateIdentity.id
        || !/^sha256:[a-f0-9]{64}$/u.test(identity?.candidateIdentity?.digest ?? ''))
    {
        throw new Error('required evidence plan requires complete source/worktree/run/candidate identity');
    }
}

export function requiredEvidencePlanDigest(plan)
{
    const content = { ...plan };
    delete content.generatedAt;
    return governanceContentDigest(content);
}

// A source plan has no runtime acceptance authority. When the caller supplies
// the canonical current-run context, preserve its independently sealed candidate.
export function requiredEvidencePlanIdentity(repositoryRoot = root, env = process.env)
{
    const source = sealSourceIdentity(repositoryRoot);
    const identity = {
        ...source,
        worktreeFingerprint: `sha256:${source.worktreeFingerprint.replace(/^sha256:/u, '')}`,
        runId: env.FSUSBLOG_TEST_RUN_ID ?? env.GITHUB_RUN_ID ?? 'local',
        attempt: env.GITHUB_RUN_ATTEMPT ?? '0',
        namespace: env.FSUSBLOG_TEST_NAMESPACE ?? 'local',
        mode: 'source-plan'
    };
    if (env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT)
    {
        const context = validateCurrentRunEvidenceContext(JSON.parse(fs.readFileSync(
            path.resolve(repositoryRoot, env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT), 'utf8'
        )));
        if (context.sourceCommit !== identity.sourceCommit
            || context.worktreeFingerprint !== identity.worktreeFingerprint)
        {
            throw new Error('required evidence plan current-run source/worktree identity mismatch');
        }
        return { ...identity, runId: context.schedulerRunId, attempt: context.attemptId,
            mode: 'current-run', candidateIdentity: structuredClone(context.candidateIdentity) };
    }
    return { ...identity, candidateIdentity: { id: identity.runId,
        digest: governanceContentDigest(identity) } };
}

export function validateRequiredEvidenceMatrix(matrix, ledger = loadCanonicalRequiredEvidenceCatalog())
{
    checkRequiredEvidenceCatalog(ledger);
    const target = matrix?.tiers?.find((tier) => tier.id === 'release-final');
    if (!target)
    {
        return ['required evidence matrix is missing release-final'];
    }
    const actual = target.requiresEvidenceFrom;
    const expected = ledger.entries.filter((entry) => !entry.allowDiagnostic).map((entry) => entry.authorityId);
    const errors = [];
    if (!Array.isArray(actual))
    {
        return ['release-final.requiresEvidenceFrom must be an authority array'];
    }
    if (new Set(actual).size !== actual.length)
    {
        errors.push('release-final has duplicate evidence authority IDs');
    }
    const missing = expected.filter((id) => !actual.includes(id));
    const extra = actual.filter((id) => !expected.includes(id));
    if (missing.length)
    {
        errors.push(`release-final is missing catalog authorities: ${missing.join(', ')}`);
    }
    if (extra.length)
    {
        errors.push(`release-final has unknown or diagnostic authorities: ${extra.join(', ')}`);
    }
    if (!same(actual, [...actual].sort()))
    {
        errors.push('release-final authority IDs must be sorted');
    }
    const tierIds = new Set(matrix.tiers.map((tier) => tier.id));
    for (const entry of ledger.entries)
    {
        for (const id of entry.producerTierIds)
        {
            if (!tierIds.has(id))
            {
                errors.push(`${entry.authorityId} is missing catalog producer ${id}`);
            }
        }
    }
    return errors;
}

export function createRequiredEvidenceDependencies(matrix, identity = requiredEvidencePlanIdentity(),
    ledger = loadCanonicalRequiredEvidenceCatalog())
{
    validateIdentity(identity);
    const errors = validateRequiredEvidenceMatrix(matrix, ledger);
    if (errors.length)
    {
        throw new Error(errors.join('; '));
    }
    const document = {
        schema: projectionSchema,
        identity: structuredClone(identity),
        catalogVersion: ledger.version,
        catalog: createRequiredEvidenceCatalogBinding(ledger),
        dependencies: ledger.entries.map((entry) => ({
            ...structuredClone(entry),
            dependencyKind: 'explicit-receipt',
            schedulesProducer: false,
            affectsCorrectness: !entry.allowDiagnostic,
            verificationOwner: entry.producerVerifier,
            // These are slots in the existing catalog binding, never paths or
            // another authority-to-locator registry.
            expectedLocatorBinding: { locatorBindingKey: entry.locatorBindingKey,
                outputBindingKey: entry.outputBindingKey, receiptSchema: entry.receiptSchema,
                receiptRefSlot: entry.outputBindingKey, explicitCurrentRun: true }
        }))
    };
    return { ...document, contentDigest: governanceContentDigest(document) };
}

export function validateRequiredEvidenceDependencies(document, matrix,
    identity = requiredEvidencePlanIdentity(), ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const errors = [];
    if (document?.schema !== projectionSchema)
    {
        errors.push('required evidence dependencies schema is missing or unsupported');
    }
    if (document?.contentDigest !== governanceContentDigest(document))
    {
        errors.push('required evidence dependencies contentDigest mismatch');
    }
    errors.push(...validateRequiredEvidenceCatalogBinding(document?.catalog, ledger));
    if (!same(document?.identity, identity))
    {
        errors.push('required evidence dependencies source/worktree/run/candidate identity mismatch');
    }
    if (document?.catalogVersion !== ledger.version)
    {
        errors.push('required evidence dependencies catalog version mismatch');
    }
    let expected;
    try
    {
        expected = createRequiredEvidenceDependencies(matrix, identity, ledger);
    }
    catch (error)
    {
        return [...errors, error.message];
    }
    if (!same(document?.dependencies, expected.dependencies))
    {
        errors.push('required evidence dependencies must exactly project catalog authorities, producers, bindings, IDs, owners and commands');
    }
    return errors;
}

export function validateRequiredEvidenceTestPlan(plan, identity = requiredEvidencePlanIdentity(),
    ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const errors = [];
    if (plan?.schema !== 'fsusblog.release-evidence.test-plan.v1')
    {
        errors.push('required evidence test-plan schema mismatch');
    }
    if (plan?.contentDigest !== requiredEvidencePlanDigest(plan))
    {
        errors.push('required evidence test-plan contentDigest mismatch');
    }
    if (plan?.commit !== identity.sourceCommit)
    {
        errors.push('required evidence test-plan commit mismatch');
    }
    if (plan?.runId !== identity.runId || plan?.namespace !== identity.namespace)
    {
        errors.push('required evidence test-plan run/namespace mismatch');
    }
    errors.push(...validateRequiredEvidenceDependencies(plan?.requiredEvidenceDependencies, plan, identity, ledger));
    return errors;
}

// Only the actual producer completion callsite may record executions. A job
// name, existing artifact, cache hit, or successful setup stage is insufficient.
export function recordRequiredEvidenceExecution(plan, tierId, status, previous = null,
    identity = requiredEvidencePlanIdentity())
{
    const errors = validateRequiredEvidenceTestPlan(plan, identity);
    if (errors.length)
    {
        throw new Error(errors.join('; '));
    }
    const projection = plan.requiredEvidenceDependencies;
    const prior = previous?.planDigest === plan.contentDigest
        && previous?.projectionDigest === projection.contentDigest ? previous.dependencies : [];
    const byId = new Map((prior ?? []).map((entry) => [entry.authorityId, entry]));
    for (const dependency of projection.dependencies.filter((entry) => entry.producerTierIds.includes(tierId)))
    {
        const record = byId.get(dependency.authorityId) ?? {
            authorityId: dependency.authorityId,
            canonicalOwner: dependency.canonicalOwner,
            outputBindingKey: dependency.outputBindingKey,
            locatorBindingKey: dependency.locatorBindingKey,
            receiptSchema: dependency.receiptSchema,
            executions: [],
            receiptRef: null
        };
        record.executions = [...record.executions.filter((entry) => entry.tierId !== tierId),
            { tierId, status }].sort((left, right) => left.tierId.localeCompare(right.tierId));
        byId.set(dependency.authorityId, record);
    }
    const result = { schema: resultSchema, planDigest: plan.contentDigest,
        projectionDigest: projection.contentDigest, catalog: projection.catalog,
        identity: projection.identity,
        dependencies: [...byId.values()].sort((left, right) => left.authorityId.localeCompare(right.authorityId)) };
    return { ...result, contentDigest: governanceContentDigest(result) };
}

export function validateRequiredEvidenceResults(plan, results, identity = requiredEvidencePlanIdentity())
{
    const errors = validateRequiredEvidenceTestPlan(plan, identity);
    if (identity.mode === 'source-plan' && identity.runId === 'local')
    {
        errors.push('required evidence dependency accounting requires an explicit current run ID; local is a plan preview only');
    }
    if (errors.length)
    {
        return errors;
    }
    const projection = plan.requiredEvidenceDependencies;
    const records = new Map();
    for (const result of results)
    {
        if (result?.schema !== resultSchema || result?.contentDigest !== governanceContentDigest(result)
            || result.planDigest !== plan.contentDigest || result.projectionDigest !== projection.contentDigest
            || !same(result.catalog, projection.catalog) || !same(result.identity, identity)
            || !Array.isArray(result.dependencies))
        {
            errors.push('required evidence dependency result has stale plan/catalog/identity or invalid digest');
            continue;
        }
        const seen = new Set();
        for (const record of result.dependencies)
        {
            const dependency = projection.dependencies.find((entry) => entry.authorityId === record?.authorityId);
            if (!dependency || seen.has(record.authorityId))
            {
                errors.push(`unknown or duplicate evidence authority: ${record?.authorityId}`);
                continue;
            }
            seen.add(record.authorityId);
            if (['canonicalOwner', 'outputBindingKey', 'locatorBindingKey', 'receiptSchema']
                .some((field) => record[field] !== dependency[field]))
            {
                errors.push(`${record.authorityId} dependency owner/output/schema/locator mismatch`);
                continue;
            }
            const executions = record.executions;
            if (!Array.isArray(executions) || new Set(executions.map((entry) => entry.tierId)).size !== executions.length
                || executions.some((entry) => !dependency.producerTierIds.includes(entry.tierId)
                    || !['success', 'failure', 'cancelled'].includes(entry.status)))
            {
                errors.push(`${record.authorityId} dependency executions are invalid`);
                continue;
            }
            // Validate only the explicit reference descriptor and its current
            // identity here. Receipt bytes/binding verification belongs to #2060.
            const ref = record.receiptRef;
            if (ref != null && (identity.mode !== 'current-run'
                || ref.bindingKey !== dependency.outputBindingKey
                || ref.locatorBindingKey !== dependency.locatorBindingKey
                || ref.schema !== dependency.receiptSchema || !same(ref.identity, identity)
                || typeof ref.path !== 'string' || !ref.path
                || path.isAbsolute(ref.path) || path.posix.normalize(ref.path) !== ref.path
                || ref.path.split('/').some((part) => part === '.' || part === '..')
                || /[*?[\]{}!]/u.test(ref.path)
                || !/^sha256:[a-f0-9]{64}$/u.test(ref.contentDigest ?? '')))
            {
                errors.push(`${record.authorityId} explicit receipt ref binding/identity mismatch`);
                continue;
            }
            records.set(record.authorityId, [...(records.get(record.authorityId) ?? []), record]);
        }
    }
    for (const dependency of projection.dependencies.filter((entry) => entry.affectsCorrectness))
    {
        const authorityRecords = records.get(dependency.authorityId) ?? [];
        const executions = authorityRecords.flatMap((entry) => entry.executions);
        const executed = dependency.producerTierIds.every((tierId) => executions.some((entry) => entry.tierId === tierId && entry.status === 'success'))
            && executions.every((entry) => entry.status === 'success');
        const refs = authorityRecords.filter((entry) => entry.receiptRef != null);
        if (refs.length > 1)
        {
            errors.push(`${dependency.authorityId} has ambiguous explicit receipt refs`);
        }
        if (!executed && refs.length !== 1)
        {
            errors.push(`${dependency.authorityId}: missing current-run producer execution or explicit receipt dependency; produce with: ${dependency.localProducerCommand}`);
        }
    }
    return errors;
}
