import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    MESSAGING_FIXTURE_CAPABILITY_IDS,
    messagingFixtureContractErrors,
    readMessagingFixtureContract
} from '../../tools/test/messaging-fixture-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const clone = (value) => structuredClone(value);
const contract = readMessagingFixtureContract();
const eventRegistrySource = readFileSync(
    path.join(root, contract.inventory.eventTypeRegistry),
    'utf8'
);
const errorsFor = (mutate) =>
{
    const inventory = clone(contract.inventory);
    const ownership = clone(contract.ownership);
    mutate(inventory, ownership);
    return messagingFixtureContractErrors(inventory, ownership, { eventRegistrySource });
};

test('messaging inventory is closed, versioned, and exact against ownership', () =>
{
    assert.deepEqual(contract.capabilityIds, MESSAGING_FIXTURE_CAPABILITY_IDS);
    assert.match(contract.inventoryDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(contract.ownershipDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(contract.inventory.producerId, 'account-messaging');
    assert.equal(contract.ownership.capabilityOwners.length, contract.capabilityIds.length);
});

test('messaging inventory rejects handwritten notification types and unsupported states', () =>
{
    assert.match(errorsFor((inventory) => inventory.eventTypeRefs.push('FixtureOnlyEvent')).join('\n'), /unknown notification event type/u);
    assert.match(errorsFor((inventory) => inventory.conversationStates.push('withdrawn')).join('\n'), /conversation\/read states must match current production/u);
});

test('messaging inventory rejects hidden empty, shortcut proofs, and missing resume semantics', () =>
{
    assert.match(errorsFor((inventory) =>
    {
        inventory.capabilities.find((item) => item.id === 'notifications.empty').emptyContract = 'filtered-hidden';
    }).join('\n'), /does not distinguish exact zero/u);
    assert.match(errorsFor((inventory) =>
    {
        inventory.capabilities.find((item) => item.id === 'notifications.unread').postconditions = ['api.http-200'];
    }).join('\n'), /shortcut postcondition|missing an exact stream/u);
    assert.match(errorsFor((inventory) =>
    {
        inventory.capabilities.find((item) => item.id === 'notifications.stream-resume').stateFields = ['cursorFloorRetained'];
    }).join('\n'), /notification resume semantics are missing/u);
});

test('messaging inventory rejects duplicate or orphan capability ownership', () =>
{
    assert.match(errorsFor((inventory) => inventory.capabilities.push(clone(inventory.capabilities[0]))).join('\n'), /exact, sorted, and complete|duplicate capability/u);
    assert.match(errorsFor((_inventory, ownership) => ownership.capabilityOwners.pop()).join('\n'), /ownership must be exact/u);
    assert.match(errorsFor((_inventory, ownership) =>
    {
        ownership.capabilityOwners[0].portId = 'second-message-port';
    }).join('\n'), /owner mismatch/u);
});

test('messaging inventory rejects payload ownership and privacy drift', () =>
{
    assert.match(errorsFor((_inventory, ownership) => ownership.privacy.forbiddenFields.pop()).join('\n'), /privacy inventory is missing forbidden field token/u);
    assert.match(errorsFor((inventory) =>
    {
        inventory.capabilities[0].identityRoles = ['unowned-user'];
    }).join('\n'), /unowned identity role/u);
    assert.match(errorsFor((inventory) =>
    {
        inventory.capabilities[0].secondEventRegistry = 'fixture-map';
    }).join('\n'), /unknown field secondEventRegistry/u);
});
