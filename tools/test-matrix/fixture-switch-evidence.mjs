const { loadCanonicalMutationEnvelopeCatalog } = await import(new URL('../test-fixtures/mutation-envelope-catalog.mjs', import.meta.url));
const { canonicalJson, digest, requireDigest, requireStableId, seal, verifySeal } = await import(new URL('../test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));
const { verifyMutationRecoveryReceipt } = await import(new URL('../test-fixtures/mutation-recovery/runner.mjs', import.meta.url));

export const fixtureSwitchProfiles = Object.freeze([
    'public-minimal', 'auth-basic', 'comments-moderation', 'messaging-preferences', 'public-empty'
]);
export const fixtureSwitchProviders = Object.freeze(['postgresql', 'mysql', 'sqlite']);
export const fixtureSwitchDomains = Object.freeze(['auth', 'comment', 'message', 'preference', 'public']);
const stateKinds = Object.freeze(['records', 'keys', 'files', 'sessions']);
const phases = Object.freeze(['admit', 'prepare', 'verify', 'mutation', 'reprepare', 'recovery', 'cleanup', 'transition']);
const emptyPhases = Object.freeze(['admit', 'prepare', 'verify', 'empty', 'cleanup', 'transition']);
const statuses = new Set(['passed', 'failed', 'cancelled', 'timed-out']);
const requiredSurfaces = Object.freeze({
    'public-minimal': ['article.metadata', 'article.views', 'article.tags', 'media'],
    'auth-basic': ['session.expiry', 'user.mfa', 'admin.permission'],
    'comments-moderation': ['comment.moderation'],
    'messaging-preferences': ['session.expiry', 'message.notification', 'account.preference']
});

/** Reports actual catalog support without turning unsupported surfaces into release skips. */
export function inspectFixtureSwitchCapability(catalog = loadCanonicalMutationEnvelopeCatalog())
{
    const gaps = [];
    for (const [profileId, domains] of Object.entries(requiredSurfaces))
    {
        const envelopes = catalog.envelopes.filter((envelope) => envelope.targetProfileIds.includes(profileId));
        for (const domain of domains)
        {
            const covering = envelopes.filter((envelope) => Object.values(envelope.semanticTargets)
                .flat().some((target) => target.domain === domain));
            if (!covering.length)
            {
                gaps.push(`${profileId}: missing ${domain} envelope`);
            }
            else if (fixtureSwitchProviders.some((provider) => !covering.some((envelope) => envelope.providerSupport[provider] === true)))
            {
                gaps.push(`${profileId}: ${domain} lacks single-provider recovery support for all three databases`);
            }
        }
        if (profileId === 'comments-moderation' && !envelopes.some((envelope) => Object.values(envelope.semanticTargets)
            .flat().some((target) => target.fields?.includes('timeline'))))
        {
            gaps.push('comments-moderation: missing timeline mutation target');
        }
    }
    return { status: gaps.length ? 'unqualified' : 'available', catalogDigest: catalog.contentDigest, gaps };
}

function exact(left, right, label)
{
    if (canonicalJson(left) !== canonicalJson(right))
    {
        throw new Error(`${label} differs from current sealed authority`);
    }
}

function checkContext(context)
{
    requireStableId(context.runId, 'runId');
    requireStableId(context.namespace, 'namespace');
    if (!/^[a-f0-9]{40}$/u.test(context.source?.commit ?? ''))
    {
        throw new Error('source requires exact commit');
    }
    requireDigest(context.source.worktreeFingerprint, 'source.worktreeFingerprint');
    for (const field of ['buildDigest', 'matrixDigest', 'profileCatalogDigest', 'mutationCatalogDigest', 'temporalContextDigest'])
    {
        requireDigest(context[field], field);
    }
    if (!fixtureSwitchProviders.includes(context.provider))
    {
        throw new Error('provider must be PostgreSQL, MySQL or SQLite; no skip');
    }
    const runtime = context.runtimeIdentity;
    if (!Number.isSafeInteger(runtime?.backendPid) || runtime.backendPid <= 0
        || !Number.isFinite(Date.parse(runtime.backendStartedAt)))
    {
        throw new Error('backend PID and start identity are required');
    }
    for (const field of ['databaseInstance', 'redisInstance', 'serviceGeneration'])
    {
        requireStableId(runtime[field], `runtimeIdentity.${field}`);
        exact(runtime[field], context.serviceIdentity?.[field], `serviceIdentity.${field}`);
    }
    exact(runtime.backendBuildDigest, context.buildDigest, 'backend build');
}

/** Consumes a scheduler projection; this module neither constructs nor executes a DAG. */
export function bindFixtureSwitchPlan({ context, projection, catalog = loadCanonicalMutationEnvelopeCatalog() })
{
    checkContext(context);
    verifySeal(catalog, 'contentDigest', 'current mutation catalog');
    verifySeal(projection, 'contentDigest', 'compiled switch projection');
    if (projection.schema !== 'fsusblog.fixture-switch-projection.v1'
        || projection.producerId !== 'fixture-profile-mutation-conformance')
    {
        throw new Error('requires the single matrix mutation conformance producer');
    }
    exact(projection.context, context, 'projection context');
    exact(context.mutationCatalogDigest, catalog.contentDigest, 'current mutation catalog');
    exact(projection.profiles.map((profile) => profile.profileId), fixtureSwitchProfiles, 'fixed profile sequence');
    const nodes = new Set();
    const orderedNodes = [];
    for (const profile of projection.profiles)
    {
        requireDigest(profile.producerPlanDigest, 'producerPlanDigest');
        requireDigest(profile.capabilityDigest, 'capabilityDigest');
        requireDigest(profile.variantPlanDigest, 'variantPlanDigest');
        exact(Object.keys(profile.nodes), profile.profileId === 'public-empty' ? emptyPhases : phases, 'lifecycle nodes');
        for (const nodeId of Object.values(profile.nodes))
        {
            requireStableId(nodeId, 'nodeId');
            if (nodes.has(nodeId))
            {
                throw new Error('duplicate lifecycle node');
            }
            nodes.add(nodeId);
            orderedNodes.push(nodeId);
        }
        if (!Array.isArray(profile.envelopeIds)
            || new Set(profile.envelopeIds).size !== profile.envelopeIds.length
            || (profile.envelopeIds.length === 0) !== (profile.profileId === 'public-empty'))
        {
            throw new Error('exact nonempty mutation envelopes required except for public-empty');
        }
        const selected = profile.envelopeIds.map((id) => catalog.envelopes.find((envelope) => envelope.envelopeId === id));
        if (selected.some((envelope) => !envelope || !envelope.targetProfileIds.includes(profile.profileId)
            || envelope.providerSupport[context.provider] !== true))
        {
            throw new Error('selected envelope is unknown or unsupported by profile/provider');
        }
        for (const domain of requiredSurfaces[profile.profileId] ?? [])
        {
            if (!selected.some((envelope) => Object.values(envelope.semanticTargets).flat()
                .some((target) => target.domain === domain)))
            {
                throw new Error(`sequence lacks required ${profile.profileId}/${domain} mutation`);
            }
        }
        if (profile.profileId === 'comments-moderation' && !selected.some((envelope) => Object.values(envelope.semanticTargets)
            .flat().some((target) => target.fields?.includes('timeline'))))
        {
            throw new Error('sequence lacks comment timeline mutation');
        }
    }
    exact(projection.edges, orderedNodes.slice(1).map((nodeId, index) => [orderedNodes[index], nodeId]), 'sequence hard dependencies');
    exact(projection.exclusivity?.resources, ['backend', 'database', 'redis', 'filesystem'], 'resource declaration');
    if (!Array.isArray(projection.exclusivity.stateDomains) || !projection.exclusivity.stateDomains.length
        || projection.exclusivity.stateDomains.some((domain) => domain === '*' || typeof domain !== 'string')
        || new Set(projection.exclusivity.stateDomains).size !== projection.exclusivity.stateDomains.length)
    {
        throw new Error('exact state domains required; global serialization is not a contract');
    }
    return seal({ schema: 'fsusblog.fixture-switch-plan.v1', context, projectionDigest: projection.contentDigest });
}

function verifyZeroState(document, context)
{
    exact(document.namespace, context.namespace, 'empty observation namespace');
    exact(Object.keys(document.resident), fixtureSwitchDomains, 'empty resident domains');
    for (const domain of fixtureSwitchDomains)
    {
        exact(Object.keys(document.resident[domain]), stateKinds, 'resident state kinds');
        for (const kind of stateKinds)
        {
            if (document.resident[domain][kind] !== 0)
            {
                throw new Error(`public-empty resident ${domain}.${kind} is not zero`);
            }
        }
    }
    requireDigest(document.observationDigest, 'empty observation digest');
}

function verifyCleanup(document, context)
{
    exact(document.namespace, context.namespace, 'cleanup namespace');
    if (document.owner !== 'fixture-orchestrator' || document.terminalStatus !== 'cleaned'
        || document.settled !== true || document.ownedRemaining !== 0)
    {
        throw new Error('owned cleanup must be settled and prove zero residue');
    }
    if (!Array.isArray(document.sentinels) || !document.sentinels.length)
    {
        throw new Error('nonowned isolation requires observed sentinels');
    }
    const domains = new Set();
    for (const sentinel of document.sentinels)
    {
        requireStableId(sentinel.domain, 'sentinel domain');
        requireDigest(sentinel.beforeDigest, 'sentinel before');
        exact(sentinel.beforeDigest, sentinel.afterDigest, 'nonowned sentinel');
        if (domains.has(sentinel.domain))
        {
            throw new Error('duplicate nonowned sentinel');
        }
        domains.add(sentinel.domain);
    }
    for (const domain of ['sentinel.dev-data', 'sentinel.other-profile'])
    {
        if (!domains.has(domain))
        {
            throw new Error(`missing nonowned sentinel ${domain}`);
        }
    }
}

/**
 * Verifies material continuity and a complete terminal vector, including interrupted runs.
 * Upstream admission and observations remain unqualified until their owners supply verifiers.
 */
export function buildFixtureSwitchEvidence({ plan, projection, events, materials, outcome, catalog })
{
    verifySeal(plan, 'contentDigest', 'switch plan');
    exact(bindFixtureSwitchPlan({ context: plan.context, projection, catalog }), plan, 'current switch plan');
    if (!['passed', 'failed', 'cancelled', 'timed-out'].includes(outcome) || !Array.isArray(events))
    {
        throw new Error('explicit terminal outcome and event vector required');
    }
    let previousEnd = 0;
    let stopped = false;
    let cursor = 0;
    const terminalVector = [];
    const materialRefs = [];
    for (const profile of projection.profiles)
    {
        const entries = [];
        let failed = false;
        const expectedPhases = profile.profileId === 'public-empty' ? emptyPhases : phases;
        for (const phase of expectedPhases)
        {
            const event = events[cursor];
            if (!event || event.nodeId !== profile.nodes[phase])
            {
                if (!stopped && !failed)
                {
                    throw new Error(`missing or out-of-order ${profile.profileId}/${phase}`);
                }
                entries.push({ phase, nodeId: profile.nodes[phase], status: 'blocked' });
                continue;
            }
            if (stopped || (failed && !['cleanup', 'transition'].includes(phase)))
            {
                throw new Error('profile admission or mutation continued after failure');
            }
            cursor += 1;
            exact(event.profileId, profile.profileId, 'event profile');
            exact(event.phase, phase, 'event phase');
            exact(event.runtimeIdentity, plan.context.runtimeIdentity, 'backend/runtime identity');
            exact(event.serviceIdentity, plan.context.serviceIdentity, 'service identity');
            if (!statuses.has(event.status) || !Number.isSafeInteger(event.startedAt)
                || !Number.isSafeInteger(event.finishedAt) || event.startedAt < previousEnd
                || event.finishedAt < event.startedAt)
            {
                throw new Error('invalid status or overlapping/nonmonotonic event timing');
            }
            previousEnd = event.finishedAt;
            requireDigest(event.evidenceDigest, 'event evidence digest');
            const document = materials[event.evidenceDigest];
            if (!document || digest(document) !== event.evidenceDigest)
            {
                throw new Error('missing or tampered event material');
            }
            exact(document.context, plan.context, 'event material context');
            exact(document.profileId, profile.profileId, 'material profile');
            exact(document.phase, phase, 'material phase');
            exact(document.operations, [phase], 'declared operations');
            if (phase === 'cleanup' && document.settled !== true)
            {
                throw new Error('cleanup terminal must be settled even on failure');
            }
            if (event.status === 'passed')
            {
                if (phase === 'recovery')
                {
                    const recoveryPlan = document.plan;
                    verifyMutationRecoveryReceipt(document.receipt, recoveryPlan);
                    exact(recoveryPlan.profileId, profile.profileId, 'recovery profile');
                    exact(recoveryPlan.producerPlanDigest, profile.producerPlanDigest, 'recovery producer plan');
                    exact(recoveryPlan.envelopeIds, profile.envelopeIds, 'recovery envelopes');
                    for (const field of ['runId', 'source', 'provider', 'temporalContextDigest', 'runtimeIdentity', 'serviceIdentity'])
                    {
                        exact(recoveryPlan[field], plan.context[field], `recovery ${field}`);
                    }
                    exact(document.receipt.runtimeIdentityBefore, plan.context.runtimeIdentity, 'recovery runtime before');
                    exact(document.receipt.runtimeIdentityAfter, plan.context.runtimeIdentity, 'recovery runtime after');
                    for (const recoveryCase of document.receipt.cases)
                    {
                        for (const field of ['baselineSnapshotDigest', 'mutationJournalDigest', 'mutatedSnapshotDigest',
                            'repairedReceiptDigest', 'finalSnapshotDigest', 'recoveryDiffDigest'])
                        {
                            requireDigest(recoveryCase[field], `recovery ${field}`);
                        }
                    }
                }
                if (phase === 'cleanup')
                {
                    verifyCleanup(document, plan.context);
                }
                if (phase === 'empty')
                {
                    verifyZeroState(document, plan.context);
                }
                if (phase === 'transition' && failed)
                {
                    throw new Error('failed profile cannot admit next profile');
                }
            }
            else
            {
                failed = true;
            }
            materialRefs.push(event.evidenceDigest);
            entries.push({ phase, nodeId: event.nodeId, status: event.status, evidenceDigest: event.evidenceDigest });
        }
        if (failed && !entries.some((entry) => entry.phase === 'cleanup' && statuses.has(entry.status)))
        {
            throw new Error('interrupted profile requires settled cleanup terminal');
        }
        stopped ||= failed;
        terminalVector.push({ profileId: profile.profileId, entries });
    }
    if (cursor !== events.length || (outcome === 'passed') !== !stopped)
    {
        throw new Error('extra event or inconsistent overall terminal outcome');
    }
    const failures = events.filter((event) => event.status !== 'passed');
    if (outcome !== 'passed' && failures[0]?.status !== outcome)
    {
        throw new Error('primary failure/cancel/timeout must be preserved');
    }
    return seal({
        schema: 'fsusblog.fixture-switch-evidence.v1',
        planDigest: plan.contentDigest,
        projectionDigest: projection.contentDigest,
        context: plan.context,
        outcome,
        terminalVector,
        eventsDigest: digest(events),
        materialRefs,
        qualificationEligible: false,
        warnings: ['compiled-admission-authority-unavailable', 'cleanup-and-empty-observation-authority-unavailable']
    });
}

export function verifyFixtureSwitchEvidence(evidence, inputs)
{
    verifySeal(evidence, 'contentDigest', 'switch evidence');
    exact(evidence, buildFixtureSwitchEvidence(inputs), 'recomputed switch evidence');
    return evidence;
}
