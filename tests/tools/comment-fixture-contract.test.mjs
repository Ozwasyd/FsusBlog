import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const {commentFixtureOwnershipErrors, readCommentFixtureContract, commentFixtureInventoryErrors, readCommentFixtureInventory} = await import(new URL('../../tools/test/comment-fixture-contract.mjs', import.meta.url));
const {defaultTimeoutPolicyDigest, qualificationTemporalContext} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {prepareCommentModeration, verifyCommentModeration} = await import(new URL('../../tools/test-fixtures/producers/comment-moderation-producer.mjs', import.meta.url));
const {resolveFixtureTestSession} = await import(new URL('../../tools/test-fixtures/runtime-scope.mjs', import.meta.url));

function commentTemporalContext()
{
    const digest = 'b'.repeat(64);
    const context = {
        namespace: 'comment-temporal',
        runIdentity: 'comment-temporal-run',
        profileIdentity: { profileId: 'comments-moderation' },
        plan: {
            capabilities: ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'],
            expandedCapabilityDigest: `sha256:${digest}`,
            variantPlanDigest: `sha256:${digest}`
        },
        variantPlan: { producerVariantPlanDigest: `sha256:${digest}` },
        handles: {
            baseUrl: 'http://127.0.0.1:9876',
            localCommentFixtureSecret: 'comment-test-secret',
            localPublicContentFixtureSecret: 'temporal-test-secret'
        },
        temporalContext: qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40),
            sourceFingerprint: `sha256:${digest}`,
            producerId: 'comment-moderation',
            schedulerRunId: 'comment-temporal-run',
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        })
    };
    const identityPrepareReferences = ['admin', 'primary-author', 'secondary-author'].map((role, index) =>
    {
        const body = {
            schema: 'fsusblog.fixture-identity-prepare-reference.v1',
            ownerProducerId: 'auth-session',
            consumerProducerId: 'comment-moderation',
            verified: false,
            role,
            publicId: String(index + 1),
            runId: context.runIdentity,
            namespace: context.namespace,
            profileId: context.profileIdentity.profileId,
            capabilityId: role === 'admin' ? 'auth.admin.full-permission' : 'auth.user.active',
            producerResultDigest: digest
        };
        return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
    });
    context.producerOutputs = {
        'auth-session': { producerId: 'auth-session', producerResultDigest: digest, identityPrepareReferences },
        'public-content': {
            producerId: 'public-content',
            strategy: 'transaction-fixture',
            observations: { database: {}, redis: {}, cache: {} },
            temporalArtifacts: { bindingDigest: `sha256:${digest}` },
            projection: { articleId: '101' },
            entityIdentities: [{ kind: 'article', id: '101' }]
        }
    };
    return context;
}

test('comment HTTP temporal ingress rejects missing or drifting actual fields before consuming domain output', async (t) =>
{
    const context = commentTemporalContext();
    const actual = { businessEpochUtc: '2024-02-29T23:59:59.000Z', backendCulture: 'Invariant', postgresTimezone: 'UTC' };
    let observation;
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) =>
    {
        if (options.method === 'POST')
        {
            assert.equal(url, 'http://127.0.0.1:9876/api/local/comment-fixture/prepare');
            return Response.json({});
        }
        reads += 1;
        assert.equal(url, 'http://127.0.0.1:9876/__local/temporal-observation');
        assert.equal(options.headers['X-Fsus-Local-Temporal-Fixture-Secret'], 'temporal-test-secret');
        assert.equal(options.headers['X-Fsus-Test-Session'], resolveFixtureTestSession(context));
        return Response.json(observation);
    });
    for (const value of [
        {},
        { ...actual, businessEpochUtc: undefined },
        { ...actual, backendCulture: undefined },
        { ...actual, postgresTimezone: undefined },
        { ...actual, businessEpochUtc: '2024-03-01T00:00:00.000Z' },
        { ...actual, backendCulture: 'zh-CN' },
        { ...actual, postgresTimezone: 'Asia/Shanghai' }
    ])
    {
        observation = value;
        await assert.rejects(() => prepareCommentModeration(context), (error) =>
            error.message.startsWith('backend temporal observation requires actual ')
            || error.reasonCode?.startsWith('temporal.') === true);
    }
    assert.equal(reads, 7);
    observation = actual;
    // A valid clock is not a substitute for complete business-domain evidence.
    await assert.rejects(() => prepareCommentModeration(context), /backend result is stale or cross-plan/u);
});

test('comment verification rechecks the actual clock without replacing domain postconditions', async () =>
{
    const context = commentTemporalContext();
    const absent = await verifyCommentModeration(context, { temporalObservation: {} });
    assert.equal(absent.ok, false);
    assert.match(absent.reason, /requires actual businessEpochUtc/u);
    const complete = await verifyCommentModeration(context, {
        temporalObservation: { businessEpochUtc: '2024-02-29T23:59:59.000Z', backendCulture: 'Invariant', postgresTimezone: 'UTC' }
    });
    assert.equal(complete.ok, false);
    assert.match(complete.reason, /verified result is incomplete/u);
});
function clone(value)
{
    return structuredClone(value);
}

test('comment fixture inventory is closed, current, and complete', () =>
{
    const contract = readCommentFixtureInventory();
    assert.match(contract.inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(contract.inventory.actorModes, ['public', 'zk_anonymous']);
    assert.equal(commentFixtureInventoryErrors(contract.inventory).length, 0);
});

test('comment fixture inventory rejects legacy actors and missing state families', () =>
{
    const { inventory } = readCommentFixtureInventory();
    const legacy = clone(inventory);
    legacy.actorModes = ['public', 'legacy_server_visible_pseudonymous'];
    assert.ok(commentFixtureInventoryErrors(legacy).some((item) => item.includes('actor modes')));

    for (const id of [
        'comment.moderation.rejected', 'comment.moderation.spam', 'comment.delete.root',
        'comment.version.edited', 'comment.thread.depth-boundary'
    ])
    {
        const missing = clone(inventory);
        missing.capabilities = missing.capabilities.filter((item) => item.id !== id);
        assert.ok(commentFixtureInventoryErrors(missing).some((item) => item.includes(`missing capability ${id}`)));
    }
});

test('comment fixture inventory rejects queue shortcuts, same-state ambiguity, and text-only evidence', () =>
{
    const { inventory } = readCommentFixtureInventory();
    const queue = clone(inventory);
    queue.capabilities.find((item) => item.id === 'comment.queue.exact-membership').postconditions = ['admin.queue-exact', 'database.count-positive'];
    assert.ok(commentFixtureInventoryErrors(queue).some((item) => item.includes('shortcut')));

    const state = clone(inventory);
    state.stateRules.readModels.hidden = { admin: 'visible-exact', public: 'hidden-exact' };
    assert.ok(commentFixtureInventoryErrors(state).some((item) => item.includes('second state map')));

    const signal = clone(inventory);
    signal.capabilities.find((item) => item.id === 'comment.signal.verified').stateFields = ['classification', 'commentId', 'provider', 'version'];
    assert.ok(commentFixtureInventoryErrors(signal).some((item) => item.includes('stateFields')));
});

test('comment fixture inventory rejects arbitrary visibility, queue, and capability declarations', () =>
{
    const { inventory } = readCommentFixtureInventory();
    const state = clone(inventory);
    state.stateRules.readModels.approved.public = false;
    state.stateRules.queueMembership.approved = 'arbitrary-value';
    const stateErrors = commentFixtureInventoryErrors(state);
    assert.ok(stateErrors.some((item) => item.includes('queue membership')));
    assert.ok(stateErrors.some((item) => item.includes('read-model visibility')));

    const refs = clone(inventory);
    refs.capabilities.find((item) => item.id === 'comment.thread.root').requiredRefs = ['article.any'];
    assert.ok(commentFixtureInventoryErrors(refs).some((item) => item.includes('exact authority binding')));

    const proof = clone(inventory);
    proof.capabilities.find((item) => item.id === 'comment.thread.root').proofTests = ['self-declared-pass'];
    assert.ok(commentFixtureInventoryErrors(proof).some((item) => item.includes('exact authority binding')));
});

test('comment fixture inventory rejects duplicate/orphan capabilities and tamper', () =>
{
    const { inventory } = readCommentFixtureInventory();
    const duplicate = clone(inventory);
    duplicate.capabilities.splice(1, 0, clone(duplicate.capabilities[0]));
    assert.ok(commentFixtureInventoryErrors(duplicate).some((item) => item.includes('capabilities must be sorted')));

    const orphan = clone(inventory);
    orphan.capabilities[0].portId = 'second-comment-producer';
    assert.ok(commentFixtureInventoryErrors(orphan).some((item) => item.includes('unknown port')));

    const unknown = clone(inventory);
    unknown.capabilities[0].id = 'comment.zz.unregistered';
    unknown.capabilities.sort((left, right) => left.id.localeCompare(right.id));
    assert.ok(commentFixtureInventoryErrors(unknown).some((item) => item.includes('exact closed authority set')));

    const tamper = clone(inventory);
    tamper.unownedStatusMap = {};
    assert.ok(commentFixtureInventoryErrors(tamper).some((item) => item.includes('keys are not closed')));
});

test('comment fixture ownership is exact and bidirectional', () =>
{
    const contract = readCommentFixtureContract();
    assert.equal(commentFixtureOwnershipErrors(contract.inventory, contract.ownership).length, 0);
    assert.match(contract.ownershipDigest, /^sha256:[a-f0-9]{64}$/u);

    const secondProducer = clone(contract.ownership);
    secondProducer.producer.implementation = 'tests/browser-contract/default-fixture-provider.mjs';
    assert.ok(commentFixtureOwnershipErrors(contract.inventory, secondProducer)
        .some((item) => item.includes('unique comment-moderation')));

    const bypass = clone(contract.ownership);
    bypass.ports[0].storageWrites = 'direct-sql';
    assert.ok(commentFixtureOwnershipErrors(contract.inventory, bypass)
        .some((item) => item.includes('production ownership boundary')));

    const orphan = clone(contract.ownership);
    orphan.capabilityOwners.pop();
    assert.ok(commentFixtureOwnershipErrors(contract.inventory, orphan)
        .some((item) => item.includes('exact and bidirectional')));
});
