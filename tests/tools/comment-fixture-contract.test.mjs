import assert from 'node:assert/strict';
import test from 'node:test';

import {
    commentFixtureOwnershipErrors,
    readCommentFixtureContract,
    commentFixtureInventoryErrors,
    readCommentFixtureInventory
} from '../../tools/test/comment-fixture-contract.mjs';

function clone(value) { return structuredClone(value); }

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
