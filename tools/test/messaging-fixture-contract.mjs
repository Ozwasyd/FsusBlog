import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inventoryFile = path.join(repositoryRoot, 'config/testing/messaging-fixture-inventory.json');
const ownershipFile = path.join(repositoryRoot, 'config/testing/messaging-fixture-ownership.json');

const expectedCapabilityIds = Object.freeze([
    'messages.empty',
    'messages.inbox.read',
    'messages.inbox.unread',
    'messages.conversation.closed',
    'messages.pagination.boundary',
    'messages.thread.multi-message',
    'messages.thread.single',
    'notifications.acknowledged',
    'notifications.backlog',
    'notifications.empty',
    'notifications.read',
    'notifications.stream-resume',
    'notifications.unread'
]);

const requiredPostconditionDomains = Object.freeze({
    messages: Object.freeze(['api', 'database']),
    notifications: Object.freeze(['api', 'stream'])
});

const stableIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function digestMessagingFixtureValue(value)
{
    return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isSortedUnique(values)
{
    return Array.isArray(values)
        && values.every((value, index) => typeof value === 'string'
            && stableIdPattern.test(value)
            && (index === 0 || values[index - 1] < value));
}

function isSortedUniqueStrings(values)
{
    return Array.isArray(values)
        && values.every((value, index) => typeof value === 'string'
            && value.length > 0
            && (index === 0 || values[index - 1] < value));
}

function exactArray(actual, expected)
{
    return Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
}

function activeNotificationEventTypes(source)
{
    const match = source.match(/public enum NotificationStreamEventType\s*:\s*short\s*\{([\s\S]*?)\n\}/u);
    if (!match)
    {
        throw new Error('canonical NotificationStreamEventType registry is unreadable');
    }
    return new Set([...match[1].matchAll(/^\s*([A-Z][A-Za-z0-9]+)\s*=\s*\d+,?\s*$/gmu)].map((item) => item[1]));
}

function validateClosedKeys(value, keys, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push(`${label} must be an object`);
        return;
    }
    for (const key of Object.keys(value))
    {
        if (!keys.includes(key))
        {
            errors.push(`${label} has unknown field ${key}`);
        }
    }
    for (const key of keys)
    {
        if (!Object.hasOwn(value, key))
        {
            errors.push(`${label} is missing ${key}`);
        }
    }
}

export function messagingFixtureContractErrors(inventory, ownership, {
    eventRegistrySource = fs.readFileSync(path.join(repositoryRoot, inventory?.eventTypeRegistry ?? ''), 'utf8')
} = {})
{
    const errors = [];
    validateClosedKeys(inventory, [
        'schema',
        'version',
        'producerId',
        'strategy',
        'temporalShapeId',
        'identityRoles',
        'conversationStates',
        'readStates',
        'eventTypeRegistry',
        'eventTypeRefs',
        'capabilities'
    ], 'inventory', errors);
    if (inventory?.schema !== 'fsusblog.messaging-fixture-inventory.v1' || inventory?.version !== 1)
    {
        errors.push('inventory schema/version is not current');
    }
    if (inventory?.producerId !== 'account-messaging' || inventory?.strategy !== 'transaction-fixture')
    {
        errors.push('inventory must bind the unique account-messaging transaction-fixture producer');
    }
    if (inventory?.temporalShapeId !== 'auth-security-messaging-account-lifecycle')
    {
        errors.push('inventory must consume the canonical messaging temporal shape');
    }
    if (!isSortedUnique(inventory?.identityRoles)
        || !isSortedUnique(inventory?.conversationStates)
        || !isSortedUnique(inventory?.readStates))
    {
        errors.push('identity roles, conversation states, and read states must be sorted unique stable IDs');
    }
    if (!exactArray(inventory?.conversationStates, ['closed', 'open', 'pending'])
        || !exactArray(inventory?.readStates, ['read', 'unread']))
    {
        errors.push('conversation/read states must match current production semantics exactly');
    }
    if (!exactArray(inventory?.capabilities?.map((item) => item.id), expectedCapabilityIds))
    {
        errors.push('messaging capability inventory must be exact, sorted, and complete');
    }

    const canonicalEvents = activeNotificationEventTypes(eventRegistrySource);
    if (!isSortedUniqueStrings(inventory?.eventTypeRefs))
    {
        errors.push('event type references must be sorted unique stable IDs');
    }
    for (const eventType of inventory?.eventTypeRefs ?? [])
    {
        if (!canonicalEvents.has(eventType))
        {
            errors.push(`unknown notification event type ${eventType}`);
        }
    }

    const seen = new Set();
    for (const capability of inventory?.capabilities ?? [])
    {
        const optionalEmpty = Object.hasOwn(capability, 'emptyContract');
        validateClosedKeys(capability, [
            'id',
            'portId',
            'identityRoles',
            'stateFields',
            'postconditions',
            ...(optionalEmpty ? ['emptyContract'] : [])
        ], `capability ${capability?.id ?? '<missing>'}`, errors);
        if (seen.has(capability.id))
        {
            errors.push(`duplicate capability ${capability.id}`);
        }
        seen.add(capability.id);
        if (!['message-lifecycle', 'notification-lifecycle'].includes(capability.portId))
        {
            errors.push(`capability ${capability.id} has unknown port ${capability.portId}`);
        }
        if (!isSortedUnique(capability.identityRoles)
            || !isSortedUniqueStrings(capability.stateFields)
            || !isSortedUnique(capability.postconditions))
        {
            errors.push(`capability ${capability.id} fields must be sorted unique stable IDs`);
        }
        if ((capability.identityRoles ?? []).some((role) => !inventory.identityRoles.includes(role)))
        {
            errors.push(`capability ${capability.id} has an unowned identity role`);
        }
        const family = capability.id.split('.')[0];
        for (const domain of requiredPostconditionDomains[family] ?? [])
        {
            if (!(capability.postconditions ?? []).some((id) => id.startsWith(`${domain}.`)))
            {
                errors.push(`capability ${capability.id} is missing an exact ${domain} postcondition`);
            }
        }
        if ((capability.postconditions ?? []).some((id) => /(?:count-positive|http-200|job-success|wildcard)/u.test(id)))
        {
            errors.push(`capability ${capability.id} uses a shortcut postcondition`);
        }
        if (capability.id.endsWith('.empty') && capability.emptyContract !== 'exact-zero-owned')
        {
            errors.push(`capability ${capability.id} does not distinguish exact zero from hidden/missing data`);
        }
        if (capability.id === 'notifications.stream-resume')
        {
            for (const field of ['acknowledgedCursor', 'cursorFloorRetained', 'expectedEventIds', 'missedGap'])
            {
                if (!capability.stateFields?.includes(field))
                {
                    errors.push(`notification resume semantics are missing ${field}`);
                }
            }
        }
        const requiredStateFields = {
            'messages.thread.multi-message': ['messageIds', 'sequence', 'threadId'],
            'notifications.acknowledged': ['acknowledgedCursor', 'expectedReplayEventIds', 'nextEventId']
        }[capability.id] ?? [];
        for (const field of requiredStateFields)
        {
            if (!capability.stateFields?.includes(field))
            {
                errors.push(`capability ${capability.id} is missing state field ${field}`);
            }
        }
        if (capability.id === 'notifications.backlog'
            && !capability.postconditions?.some((id) => id.startsWith('outbox.')))
        {
            errors.push('notifications.backlog must bind exact outbox identity');
        }
    }

    validateClosedKeys(ownership, [
        'schema',
        'inventory',
        'producer',
        'ports',
        'gateways',
        'capabilityOwners',
        'consumers',
        'privacy'
    ], 'ownership', errors);
    if (ownership?.schema !== 'fsusblog.messaging-fixture-ownership.v1'
        || ownership?.inventory !== 'config/testing/messaging-fixture-inventory.json')
    {
        errors.push('ownership schema/inventory identity is invalid');
    }
    if (ownership?.producer?.id !== inventory?.producerId
        || ownership?.producer?.strategy !== inventory?.strategy
        || ownership?.producer?.implementation !== 'tools/test-fixtures/producers/account-messaging-producer.mjs')
    {
        errors.push('ownership producer is not the unique account-messaging implementation');
    }
    const ports = new Set((ownership?.ports ?? []).map((item) => item.id));
    if (ports.size !== 2 || !ports.has('message-lifecycle') || !ports.has('notification-lifecycle'))
    {
        errors.push('ownership must expose exactly the message and notification lifecycle ports');
    }
    const expectedPortWrites = new Map([
        ['message-lifecycle', 'production-message-application-ports'],
        ['notification-lifecycle', 'production-outbox-fanout-stream-ports']
    ]);
    for (const port of ownership?.ports ?? [])
    {
        if (expectedPortWrites.get(port.id) !== port.storageWrites)
        {
            errors.push(`port ${port.id} crosses its production ownership boundary`);
        }
    }
    const gateways = ownership?.gateways ?? [];
    if (gateways.length !== 1
        || gateways[0]?.id !== 'loopback-http'
        || gateways[0]?.implementation !== 'src/backend/Modules/Endpoints/LocalMessagingFixtureEndpoints.cs'
        || !exactArray(gateways[0]?.delegatesTo, ['message-lifecycle', 'notification-lifecycle']))
    {
        errors.push('ownership must expose the exact loopback HTTP gateway delegation');
    }
    const owned = ownership?.capabilityOwners ?? [];
    if (!exactArray(owned.map((item) => item.capabilityId), expectedCapabilityIds))
    {
        errors.push('capability ownership must be exact and bidirectional');
    }
    for (const item of owned)
    {
        const capability = inventory?.capabilities?.find((candidate) => candidate.id === item.capabilityId);
        if (!capability || capability.portId !== item.portId || !ports.has(item.portId))
        {
            errors.push(`capability owner mismatch for ${item.capabilityId}`);
        }
    }
    const privacy = ownership?.privacy;
    if (!isSortedUniqueStrings(privacy?.ordinaryArtifactFields) || !isSortedUniqueStrings(privacy?.forbiddenFields))
    {
        errors.push('privacy field inventories must be sorted unique stable IDs');
    }
    for (const forbidden of ['body', 'cookie', 'notificationPayload', 'sessionId', 'token'])
    {
        if (!privacy?.forbiddenFields?.includes(forbidden))
        {
            errors.push(`privacy inventory is missing forbidden field ${forbidden}`);
        }
    }
    return errors;
}

export function readMessagingFixtureContract({ inventoryPath = inventoryFile, ownershipPath = ownershipFile } = {})
{
    const inventory = readJson(inventoryPath);
    const ownership = readJson(ownershipPath);
    const errors = messagingFixtureContractErrors(inventory, ownership);
    if (errors.length)
    {
        throw new Error(`messaging fixture contract invalid:\n${errors.join('\n')}`);
    }
    return Object.freeze({
        inventory,
        ownership,
        inventoryDigest: digestMessagingFixtureValue(inventory),
        ownershipDigest: digestMessagingFixtureValue(ownership),
        capabilityIds: Object.freeze([...expectedCapabilityIds])
    });
}

export { expectedCapabilityIds as MESSAGING_FIXTURE_CAPABILITY_IDS };
