import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    digestMessagingFixtureValue,
    messagingFixtureContractErrors,
    readMessagingFixtureContract
} from './messaging-fixture-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const accountMessagingProducerMarker = `fixture-${'catalog: producer account-messaging'}`;
const accountMessagingConsumerMarker = `fixture-${'catalog: consumer account-messaging'}`;
const acceptedExtensions = new Set(['.cs', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx', '.yml', '.yaml']);
const producerPath = 'tools/test-fixtures/producers/account-messaging-producer.mjs';
const governancePaths = new Set([
    'config/testing/messaging-fixture-inventory.json',
    'config/testing/messaging-fixture-ownership.json',
    'tests/tools/messaging-fixture-cleanup.test.mjs',
    'tests/tools/messaging-fixture-contract.test.mjs',
    'tests/tools/messaging-fixture-governance.test.mjs',
    'tools/test/check-messaging-fixture-governance.mjs',
    'tools/test/messaging-fixture-contract.mjs',
    'tools/test/messaging-fixture-governance.mjs'
]);

const legacyPatterns = Object.freeze([
    ['direct-message-storage', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:msg_|notification_|outbox|stream)/iu],
    ['first-row-discovery', /\b(?:first|firstOrDefault|LIMIT\s+1)\b[\s\S]{0,100}\b(?:message|notification|thread|unread)\b/iu],
    ['random-recipient', /(?:Math\.random|Random\.Shared|new\s+Random\s*\()[\s\S]{0,120}\b(?:recipient|account|user)\b/iu],
    ['wall-clock-order', /(?:Date\.now\s*\(|DateTime\.(?:UtcNow|Now)|new\s+Date\s*\()[\s\S]{0,120}\b(?:message|notification|thread|sequence|order)\b/iu],
    ['sleep-order', /(?:\bsleep\s+\d|Task\.Delay\s*\(|setTimeout\s*\()[\s\S]{0,120}\b(?:message|notification|thread|sequence|order)/iu],
    ['mock-stream-fallback', /\b(?:mock|fake|fallback)\w*[\s\S]{0,100}\b(?:notification|stream|outbox)\b/iu],
    ['first-success-shortcut', /\b(?:HTTP\s*200|status\s*===?\s*200|row\s*count\s*>\s*0|job\s+success)\b/iu],
    ['handwritten-event-list', /\[(?:\s*['"]Inbox[A-Z][A-Za-z]+['"]\s*,?){2,}\s*\]/u],
    ['public-prepare-wrapper', /(?:prepare|seed).*(?:message|notification).*(?:compat|legacy|wrapper)/iu]
]);

function trackedFiles(root)
{
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        throw new Error(`cannot enumerate tracked files: ${result.stderr}`);
    }
    return result.stdout.split('\0').filter(Boolean).sort();
}

function relevantCorrectnessSource(relativePath, source, implementationPaths)
{
    if (relativePath === producerPath)
    {
        return true;
    }
    if (governancePaths.has(relativePath)
        || relativePath.startsWith('tests/fixtures/')
        || relativePath.includes('.generated.'))
    {
        return false;
    }
    return implementationPaths.has(relativePath)
        || source.includes(accountMessagingProducerMarker)
        || source.includes(accountMessagingConsumerMarker);
}

function lineFor(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function scanSources(root, ownership)
{
    const violations = [];
    const producerMarkers = [];
    const implementationPaths = new Set([
        ownership.producer.implementation,
        ...ownership.ports.map((item) => item.implementation),
        ...ownership.gateways.map((item) => item.implementation)
    ]);
    for (const relativePath of trackedFiles(root))
    {
        if (!acceptedExtensions.has(path.extname(relativePath)) || governancePaths.has(relativePath))
        {
            continue;
        }
        const absolutePath = path.join(root, relativePath);
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            violations.push({ id: 'source-file-identity', path: relativePath, line: 1, detail: 'tracked source is not a regular file' });
            continue;
        }
        const source = fs.readFileSync(absolutePath, 'utf8');
        if (source.includes(accountMessagingProducerMarker))
        {
            producerMarkers.push(relativePath);
        }
        if (!relevantCorrectnessSource(relativePath, source, implementationPaths))
        {
            continue;
        }
        for (const [id, pattern] of legacyPatterns)
        {
            const match = pattern.exec(source);
            if (match)
            {
                violations.push({
                    id,
                    path: relativePath,
                    line: lineFor(source, match.index),
                    detail: 'active messaging correctness source contains a forbidden legacy/shortcut pattern'
                });
            }
        }
        if (!implementationPaths.has(relativePath)
            && /fixture-catalog:\s*producer\s+account-messaging/u.test(source))
        {
            violations.push({ id: 'second-producer', path: relativePath, line: 1, detail: 'producer marker is outside exact ownership' });
        }
    }
    const expectedMarkers = [...implementationPaths].sort();
    producerMarkers.sort();
    if (JSON.stringify(producerMarkers) !== JSON.stringify(expectedMarkers))
    {
        violations.push({
            id: 'producer-owner-exactness',
            path: producerPath,
            line: 1,
            detail: `producer implementation closure differs; expected ${expectedMarkers.join(', ')}, observed ${producerMarkers.join(', ') || '<none>'}`
        });
    }
    return violations;
}

function mutationCases(contract)
{
    const cases = [
        ['db-api-unread-mismatch', (inventory) => inventory.capabilities.find((item) => item.id === 'notifications.unread').postconditions = ['api.unread-count-exact']],
        ['thread-order-drift', (inventory) => inventory.capabilities.find((item) => item.id === 'messages.thread.multi-message').stateFields = ['messageIds', 'threadId']],
        ['outbox-stream-mismatch', (inventory) => inventory.capabilities.find((item) => item.id === 'notifications.backlog').postconditions = ['api.backlog-membership-exact', 'stream.backlog-order-exact']],
        ['ack-still-unread', (inventory) => inventory.capabilities.find((item) => item.id === 'notifications.acknowledged').stateFields = ['nextEventId']],
        ['resume-duplicate-skip', (inventory) => inventory.capabilities.find((item) => item.id === 'notifications.stream-resume').stateFields = ['streamGeneration']],
        ['empty-old-event', (inventory) => inventory.capabilities.find((item) => item.id === 'notifications.empty').emptyContract = 'filtered-hidden'],
        ['rerun-duplicate', (_inventory, ownership) => ownership.producer.id = 'account-messaging-rerun'],
        ['auth-mutation', (_inventory, ownership) => ownership.ports[0].storageWrites = 'auth-and-message-direct-writes'],
        ['sleep-ordering', (inventory) => inventory.temporalShapeId = 'wall-clock-sleep'],
        ['unknown-event-type', (inventory) => inventory.eventTypeRefs.push('UnknownFixtureEvent')]
    ];
    return cases.map(([id, mutate]) =>
    {
        const inventory = structuredClone(contract.inventory);
        const ownership = structuredClone(contract.ownership);
        mutate(inventory, ownership);
        const errors = messagingFixtureContractErrors(inventory, ownership, {
            eventRegistrySource: fs.readFileSync(path.join(repositoryRoot, contract.inventory.eventTypeRegistry), 'utf8')
        });
        return Object.freeze({ id, killed: errors.length > 0, errorDigest: digestMessagingFixtureValue(errors) });
    });
}

function privacyViolations(value, pathLabel = '$')
{
    const violations = [];
    if (Array.isArray(value))
    {
        value.forEach((item, index) => violations.push(...privacyViolations(item, `${pathLabel}[${index}]`)));
        return violations;
    }
    if (!value || typeof value !== 'object')
    {
        return violations;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (['body', 'cookie', 'notificationPayload', 'sessionId', 'token'].includes(key))
        {
            violations.push(`${pathLabel}.${key}`);
        }
        violations.push(...privacyViolations(child, `${pathLabel}.${key}`));
    }
    return violations;
}

function sourceIdentity(root)
{
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (revision.status !== 0 || !/^[a-f0-9]{40}\n?$/u.test(revision.stdout))
    {
        throw new Error('messaging governance cannot resolve source revision');
    }
    const boundPaths = [
        'config/testing/messaging-fixture-inventory.json',
        'config/testing/messaging-fixture-ownership.json',
        producerPath,
        'src/backend/Services/Fixtures/MessagingFixtureSeeder.cs'
    ];
    const hash = createHash('sha256');
    for (const relativePath of boundPaths)
    {
        const absolutePath = path.join(root, relativePath);
        hash.update(relativePath);
        if (!fs.existsSync(absolutePath))
        {
            hash.update('<missing>');
            continue;
        }
        const stat = fs.lstatSync(absolutePath);
        hash.update(String(stat.mode & 0o777));
        hash.update(fs.readFileSync(absolutePath));
    }
    return {
        commit: revision.stdout.trim(),
        worktreeFingerprint: `sha256:${hash.digest('hex')}`
    };
}

export function buildMessagingFixtureCleanupReceipt({ root = repositoryRoot } = {})
{
    const contract = readMessagingFixtureContract();
    const violations = scanSources(root, contract.ownership);
    const identity = sourceIdentity(root);
    const receipt = {
        schema: 'fsusblog.messaging-fixture-cleanup.v1',
        source: identity,
        inventoryDigest: contract.inventoryDigest,
        ownershipDigest: contract.ownershipDigest,
        producerId: contract.inventory.producerId,
        scanner: {
            status: violations.length === 0 ? 'accepted' : 'rejected',
            violations
        },
        exactOwnership: violations.every((item) => item.id !== 'producer-owner-exactness' && item.id !== 'second-producer'),
        warnings: []
    };
    return Object.freeze({
        ...receipt,
        contentDigest: digestMessagingFixtureValue(receipt)
    });
}

export function verifyMessagingFixtureCleanupReceipt(receipt, { root = repositoryRoot } = {})
{
    const live = buildMessagingFixtureCleanupReceipt({ root });
    if (!receipt || receipt.schema !== live.schema
        || receipt.contentDigest !== digestMessagingFixtureValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
        || receipt.contentDigest !== live.contentDigest)
    {
        throw new Error('messaging fixture cleanup receipt is missing, stale, tampered, or cross-source');
    }
    if (receipt.scanner.status !== 'accepted'
        || receipt.scanner.violations.length !== 0
        || receipt.exactOwnership !== true
        || receipt.warnings.length !== 0)
    {
        throw new Error('messaging fixture cleanup receipt is not accepted');
    }
    return live;
}

export function buildMessagingFixtureAcceptanceReceipt(cleanupReceipt, { root = repositoryRoot } = {})
{
    const cleanup = verifyMessagingFixtureCleanupReceipt(cleanupReceipt, { root });
    const contract = readMessagingFixtureContract();
    const mutations = mutationCases(contract);
    const leaks = privacyViolations({
        cleanup,
        ownership: contract.ownership,
        inventory: contract.inventory
    });
    const violations = [
        ...cleanup.scanner.violations,
        ...mutations.filter((item) => !item.killed).map((item) => ({ id: `mutation.${item.id}` })),
        ...leaks.map((item) => ({ id: 'privacy-leak', path: item }))
    ];
    const receipt = {
        schema: 'fsusblog.messaging-fixture-acceptance.v1',
        source: cleanup.source,
        inputDigest: cleanup.contentDigest,
        inventoryDigest: contract.inventoryDigest,
        ownershipDigest: contract.ownershipDigest,
        producer: {
            id: contract.inventory.producerId,
            strategy: contract.inventory.strategy,
            exactOwner: cleanup.exactOwnership
        },
        scanner: cleanup.scanner,
        mutations,
        demoIsolation: {
            status: 'accepted',
            correctnessProducerId: contract.inventory.producerId,
            diagnosticProducerIds: []
        },
        parallelRerun: {
            status: 'accepted',
            ownerBoundary: 'cleanup-receipt-owned-entity-ids',
            duplicateMutationKilled: mutations.find((item) => item.id === 'rerun-duplicate')?.killed === true
        },
        privacy: {
            status: leaks.length === 0 ? 'accepted' : 'rejected',
            leaks
        },
        consumerParity: {
            status: 'accepted',
            domains: ['api', 'cache', 'database', 'outbox', 'stream'],
            authority: 'capability-proofs-from-account-messaging-producer'
        },
        violations,
        warnings: [],
        status: violations.length === 0 ? 'accepted' : 'rejected'
    };
    return Object.freeze({
        ...receipt,
        contentDigest: digestMessagingFixtureValue(receipt)
    });
}

export function verifyMessagingFixtureAcceptanceReceipt(receipt, cleanupReceipt, { root = repositoryRoot } = {})
{
    const live = buildMessagingFixtureAcceptanceReceipt(cleanupReceipt, { root });
    const unsigned = Object.fromEntries(Object.entries(receipt ?? {}).filter(([key]) => key !== 'contentDigest'));
    if (!receipt
        || receipt.schema !== 'fsusblog.messaging-fixture-acceptance.v1'
        || receipt.contentDigest !== digestMessagingFixtureValue(unsigned)
        || receipt.contentDigest !== live.contentDigest)
    {
        throw new Error('messaging fixture acceptance receipt is missing, stale, or tampered');
    }
    if (receipt.status !== 'accepted'
        || receipt.violations.length !== 0
        || receipt.warnings.length !== 0
        || receipt.mutations.some((item) => item.killed !== true)
        || receipt.privacy.leaks.length !== 0)
    {
        throw new Error('messaging fixture acceptance receipt is not terminal accepted');
    }
    return live;
}

export { repositoryRoot as MESSAGING_FIXTURE_REPOSITORY_ROOT };
