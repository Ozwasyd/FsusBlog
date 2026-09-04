import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('comment fixture inventory rejects duplicate/orphan capabilities and tamper', () =>
{
    const { inventory } = readCommentFixtureInventory();
    const duplicate = clone(inventory);
    duplicate.capabilities.splice(1, 0, clone(duplicate.capabilities[0]));
    assert.ok(commentFixtureInventoryErrors(duplicate).some((item) => item.includes('capabilities must be sorted')));

    const orphan = clone(inventory);
    orphan.capabilities[0].portId = 'second-comment-producer';
    assert.ok(commentFixtureInventoryErrors(orphan).some((item) => item.includes('unknown port')));

    const tamper = clone(inventory);
    tamper.unownedStatusMap = {};
    assert.ok(commentFixtureInventoryErrors(tamper).some((item) => item.includes('keys are not closed')));
});
