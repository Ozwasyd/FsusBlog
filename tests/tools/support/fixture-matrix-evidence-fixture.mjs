// DATA_ONLY: hypothetical owner materials exercise verifier rejection; no runtime qualification.
const { fixtureIdentityDimensions, fixtureMatrixMutations, scanFixtureMatrixSources } = await import(new URL('../../../tools/test/fixture-matrix-governance.mjs', import.meta.url));
const { loadCanonicalMutationEnvelopeCatalog } = await import(new URL('../../../tools/test-fixtures/mutation-envelope-catalog.mjs', import.meta.url));
const { digest, seal } = await import(new URL('../../../tools/test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));
const { bindFixtureSwitchPlan, fixtureSwitchProfiles } = await import(new URL('../../../tools/test-matrix/fixture-switch-evidence.mjs', import.meta.url));

export function switchMaterials(provider = 'postgresql')
{
    const catalog = structuredClone(loadCanonicalMutationEnvelopeCatalog());
    const requirements = [
        ['public-minimal', ['article.metadata', 'article.views', 'article.tags', 'media']],
        ['auth-basic', ['session.expiry', 'user.mfa', 'admin.permission']],
        ['comments-moderation', ['comment.moderation']],
        ['messaging-preferences', ['session.expiry', 'message.notification', 'account.preference']]
    ];
    catalog.envelopes = requirements.flatMap(([profileId, domains]) => domains.map((domain) => ({
        envelopeId: `data-only/${profileId}/${domain}`,
        targetProfileIds: [profileId],
        semanticTargets: { entities: [{ domain, fields: domain === 'comment.moderation' ? ['status', 'timeline'] : ['value'] }] },
        providerSupport: { postgresql: true, mysql: true, sqlite: true }
    })));
    const sealedCatalog = seal(catalog);
    const runtimeIdentity = {
        backendPid: 1234,
        backendStartedAt: '2026-10-08T00:00:00.000Z',
        databaseInstance: 'data-only-db',
        redisInstance: 'data-only-redis',
        serviceGeneration: 'data-only-generation',
        backendBuildDigest: digest('data-only-build')
    };
    const serviceIdentity = {
        databaseInstance: runtimeIdentity.databaseInstance,
        redisInstance: runtimeIdentity.redisInstance,
        serviceGeneration: runtimeIdentity.serviceGeneration
    };
    const context = {
        runId: 'data-only-run', namespace: 'data-only-namespace', provider,
        source: { commit: 'a'.repeat(40), worktreeFingerprint: digest('data-only-source') },
        buildDigest: runtimeIdentity.backendBuildDigest,
        matrixDigest: digest('data-only-matrix'),
        profileCatalogDigest: digest('data-only-profiles'),
        mutationCatalogDigest: sealedCatalog.contentDigest,
        temporalContextDigest: digest('data-only-temporal'),
        runtimeIdentity, serviceIdentity
    };
    const profiles = fixtureSwitchProfiles.map((profileId) =>
    {
        const phases = profileId === 'public-empty'
            ? ['admit', 'prepare', 'verify', 'empty', 'cleanup', 'transition']
            : ['admit', 'prepare', 'verify', 'mutation', 'reprepare', 'recovery', 'cleanup', 'transition'];
        return {
            profileId,
            producerPlanDigest: digest(`data-only-plan/${profileId}`),
            capabilityDigest: digest(`data-only-capability/${profileId}`),
            variantPlanDigest: digest(`data-only-variant/${profileId}`),
            envelopeIds: sealedCatalog.envelopes.filter((envelope) => envelope.targetProfileIds.includes(profileId)).map((envelope) => envelope.envelopeId),
            nodes: Object.fromEntries(phases.map((phase) => [phase, `data-only/${profileId}/${phase}`]))
        };
    });
    const ordered = profiles.flatMap((profile) => Object.values(profile.nodes));
    const projection = seal({
        schema: 'fsusblog.fixture-switch-projection.v1',
        producerId: 'fixture-profile-mutation-conformance', context, profiles,
        edges: ordered.slice(1).map((nodeId, index) => [ordered[index], nodeId]),
        exclusivity: { resources: ['backend', 'database', 'redis', 'filesystem'], stateDomains: ['data-only.fixture'] }
    });
    const plan = bindFixtureSwitchPlan({ context, projection, catalog: sealedCatalog });
    const materials = {};
    const events = [];
    for (const profile of profiles)
    {
        for (const [phase, nodeId] of Object.entries(profile.nodes))
        {
            const document = { context, profileId: profile.profileId, phase, operations: [phase] };
            if (phase === 'cleanup')
            {
                Object.assign(document, {
                    namespace: context.namespace, owner: 'fixture-orchestrator', terminalStatus: 'cleaned', settled: true,
                    ownedRemaining: 0,
                    sentinels: ['sentinel.dev-data', 'sentinel.other-profile'].map((domain) => ({
                        domain, beforeDigest: digest(domain), afterDigest: digest(domain)
                    }))
                });
            }
            if (phase === 'empty')
            {
                Object.assign(document, {
                    namespace: context.namespace, observationDigest: digest('data-only-observation'),
                    resident: Object.fromEntries(['auth', 'comment', 'message', 'preference', 'public']
                        .map((domain) => [domain, { records: 0, keys: 0, files: 0, sessions: 0 }]))
                });
            }
            if (phase === 'recovery')
            {
                document.plan = seal({
                    ...context, schema: 'fsusblog.fixture-mutation-recovery-plan.v1',
                    profileId: profile.profileId, producerPlanDigest: profile.producerPlanDigest,
                    envelopeIds: profile.envelopeIds, retryPolicy: 'none'
                });
                document.receipt = seal({
                    schema: 'fsusblog.fixture-mutation-recovery-receipt.v1', planDigest: document.plan.contentDigest,
                    terminalStatus: 'verified', retryCount: 0, forbiddenOperationCount: 0,
                    runtimeIdentityBefore: runtimeIdentity, runtimeIdentityAfter: runtimeIdentity,
                    cases: profile.envelopeIds.map((envelopeId) => ({
                        envelopeId, status: 'recovered', baselineSnapshotDigest: digest('data-only-baseline'),
                        mutationJournalDigest: digest('data-only-journal'), mutatedSnapshotDigest: digest('data-only-mutated'),
                        repairedReceiptDigest: digest('data-only-repaired'), finalSnapshotDigest: digest('data-only-final'),
                        recoveryDiffDigest: digest('data-only-diff')
                    }))
                });
            }
            const evidenceDigest = digest(document);
            materials[evidenceDigest] = document;
            events.push({
                profileId: profile.profileId, nodeId, phase, status: 'passed',
                startedAt: events.length * 2, finishedAt: events.length * 2 + 1,
                runtimeIdentity, serviceIdentity, evidenceDigest
            });
        }
    }
    return { plan, projection, events, materials, outcome: 'passed', catalog: sealedCatalog };
}

export function replaceEventMaterial(inputs, event, update)
{
    const document = structuredClone(inputs.materials[event.evidenceDigest]);
    update(document);
    event.evidenceDigest = digest(document);
    inputs.materials[event.evidenceDigest] = document;
}

export function governanceMaterials()
{
    const source = { commit: 'a'.repeat(40), worktreeFingerprint: digest('data-only-source') };
    const roster = [{ stepId: 'data-only-step', profileId: 'public-minimal', testIds: ['data-only-test'],
        capabilities: ['data-only-capability'], producerIds: ['data-only-producer'],
        nodes: ['data-only-node'], admissionDigest: digest('data-only-admission') }];
    return {
        source,
        scanner: scanFixtureMatrixSources({ 'tools/data-only.mjs': 'export const explicit = true;\n' }),
        inputReceipts: { '2663': { dataOnly: true }, '2664': { dataOnly: true } },
        exactness: Object.fromEntries(['matrix', 'bindings', 'consumers', 'local', 'ci'].map((key) => [key, structuredClone(roster)])),
        mutations: fixtureMatrixMutations.map((id) => ({ id, source, status: 'killed', exitCode: 1,
            inputDigest: digest(id), outputDigest: digest(`${id}/output`), diagnostics: ['data-only-rejection'] })),
        invalidation: fixtureIdentityDimensions.map((dimension) => ({ dimension, source, status: 'observed',
            beforeDigest: digest(dimension), afterDigest: digest(`${dimension}/changed`), observationDigest: digest(`${dimension}/observed`),
            oldPlanAdmitted: false, oldCacheHit: false, oldEvidenceAdmitted: false, oldReleaseCandidateAdmitted: false }))
    };
}
