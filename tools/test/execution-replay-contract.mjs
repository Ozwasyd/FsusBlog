import { createHash, createHmac, randomBytes } from 'node:crypto';

export const REPLAY_PLAN_SCHEMA = 'fsusblog.test-execution-replay-plan.v1';
export const REPLAY_RECEIPT_SCHEMA = 'fsusblog.test-execution-replay-receipt.v1';
export const REPLAY_STREAM_VERSION = 'v1';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const seedPattern = /^seed256:[0-9a-f]{64}$/u;
const stableIdPattern = /^[a-z][a-z0-9.-]*$/u;
const frameworkPattern = /^[a-z][a-z0-9-]*$/u;
const forbiddenIdentityCharacters = /[\u0000-\u001f\u007f]/u;

export class ReplayContractError extends Error
{
    constructor(reasonCode, message, details = {})
    {
        super(`${reasonCode}: ${message}`);
        this.name = 'ReplayContractError';
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

function fail(reasonCode, message, details = {})
{
    throw new ReplayContractError(reasonCode, message, details);
}

function plainObject(value)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right)
{
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortedKeys(value)
{
    return Object.keys(value).sort(compareUtf8);
}

export function canonicalJson(value)
{
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
    {
        return JSON.stringify(value);
    }
    if (typeof value === 'number')
    {
        if (!Number.isFinite(value))
        {
            fail('replay.canonical-json-invalid', 'canonical JSON rejects non-finite numbers');
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    }
    if (plainObject(value))
    {
        return `{${sortedKeys(value).map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    fail('replay.canonical-json-invalid', 'canonical JSON only accepts JSON values');
}

export function canonicalDigest(value)
{
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function exactKeys(value, required, label, optional = [])
{
    if (!plainObject(value))
    {
        fail('replay.schema-invalid', `${label} must be an object`);
    }
    const allowed = new Set([...required, ...optional]);
    const missing = required.filter((field) => !(field in value));
    const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort(compareUtf8);
    if (missing.length > 0 || unknown.length > 0)
    {
        fail('replay.schema-invalid', `${label} fields are not exact`, { label, missing, unknown });
    }
    return value;
}

function requiredText(value, field)
{
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
      || forbiddenIdentityCharacters.test(value))
    {
        fail('replay.schema-invalid', `${field} must be non-empty exact text`);
    }
    return value;
}

function validateDigest(value, field)
{
    if (typeof value !== 'string' || !digestPattern.test(value))
    {
        fail('replay.digest-invalid', `${field} must be a sha256 digest`);
    }
    return value;
}

export function normalizeRootSeed(value)
{
    if (typeof value !== 'string')
    {
        fail('replay.root-seed-invalid', 'root seed must be a string');
    }
    const normalized = value.trim().toLowerCase();
    const withPrefix = /^[0-9a-f]{64}$/u.test(normalized) ? `seed256:${normalized}` : normalized;
    if (!seedPattern.test(withPrefix))
    {
        fail('replay.root-seed-invalid', 'root seed must contain exactly 256 bits encoded as lowercase hex');
    }
    return withPrefix;
}

export function resolveRootSeed({
    cliSeed,
    planSeed,
    mode = 'qualification',
    emitGenerated,
    generate = () => randomBytes(32)
} = {})
{
    if (!['qualification', 'diagnostic'].includes(mode))
    {
        fail('replay.root-seed-invalid', `unsupported replay mode: ${mode}`);
    }
    if (cliSeed != null && String(cliSeed).trim())
    {
        const rootSeed = normalizeRootSeed(cliSeed);
        if (planSeed != null && String(planSeed).trim()
          && normalizeRootSeed(planSeed) !== rootSeed)
        {
            fail('replay.root-seed-conflict', 'CLI root seed conflicts with the sealed plan seed');
        }
        return Object.freeze({ rootSeed, source: 'cli', sealed: true });
    }
    if (planSeed != null && String(planSeed).trim())
    {
        return Object.freeze({ rootSeed: normalizeRootSeed(planSeed), source: 'plan', sealed: true });
    }
    if (mode === 'qualification')
    {
        fail('replay.root-seed-missing', 'qualification requires an explicit CLI or plan root seed');
    }
    if (typeof emitGenerated !== 'function')
    {
        fail('replay.root-seed-unsealed', 'diagnostic root seed generation requires an immediate emitter');
    }
    const generated = generate();
    const bytes = Buffer.isBuffer(generated) ? generated : Buffer.from(generated ?? []);
    if (bytes.length !== 32)
    {
        fail('replay.root-seed-invalid', 'diagnostic generator must return exactly 32 bytes');
    }
    const rootSeed = `seed256:${bytes.toString('hex')}`;
    emitGenerated(rootSeed);
    return Object.freeze({ rootSeed, source: 'generated-diagnostic', sealed: true });
}

function stableIdentityText(value, field)
{
    const text = requiredText(value, field);
    const normalized = text.normalize('NFC');
    if (normalized !== text)
    {
        fail('replay.test-id-invalid', `${field} must already use Unicode NFC`);
    }
    return normalized;
}

function strictEncode(value)
{
    return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
        `%${character.codePointAt(0).toString(16).toUpperCase()}`);
}

function canonicalEncoded(value, field)
{
    let decoded;
    try
    {
        decoded = decodeURIComponent(value);
    }
    catch
    {
        fail('replay.test-id-invalid', `${field} contains invalid percent encoding`);
    }
    stableIdentityText(decoded, field);
    if (strictEncode(decoded) !== value)
    {
        fail('replay.test-id-invalid', `${field} is not canonically percent encoded`);
    }
    return decoded;
}

function canonicalSource(source)
{
    const normalized = stableIdentityText(source, 'source').replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized))
    {
        fail('replay.test-id-invalid', 'canonical test source must be repository relative');
    }
    const segments = normalized.split('/');
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..'))
    {
        fail('replay.test-id-invalid', 'canonical test source contains an empty or relative segment');
    }
    return segments.map(strictEncode).join('/');
}

export function canonicalTestId({ framework, source, name, caseIdentity = null })
{
    const normalizedFramework = stableIdentityText(framework, 'framework');
    if (!frameworkPattern.test(normalizedFramework))
    {
        fail('replay.test-id-invalid', 'framework must use lowercase kebab-case');
    }
    const names = Array.isArray(name) ? name : [name];
    if (names.length === 0)
    {
        fail('replay.test-id-invalid', 'canonical test name requires at least one segment');
    }
    const encodedName = names.map((segment, index) =>
        strictEncode(stableIdentityText(segment, `name[${index}]`))).join('/');
    let identifier = `${normalizedFramework}:${canonicalSource(source)}#${encodedName}`;
    if (caseIdentity !== null)
    {
        exactKeys(caseIdentity, ['kind', 'id'], 'caseIdentity');
        if (!['parameterized', 'property', 'fuzz'].includes(caseIdentity.kind))
        {
            fail('replay.test-id-invalid', `unsupported case identity kind: ${caseIdentity.kind}`);
        }
        identifier += `?case=${caseIdentity.kind}:${strictEncode(stableIdentityText(caseIdentity.id, 'caseIdentity.id'))}`;
    }
    return validateCanonicalTestId(identifier);
}

export function validateCanonicalTestId(identifier)
{
    if (typeof identifier !== 'string' || identifier !== identifier.trim())
    {
        fail('replay.test-id-invalid', 'canonical test ID must be exact text');
    }
    const match = /^(?<framework>[a-z][a-z0-9-]*):(?<source>[^#?]+)#(?<name>[^?]+)(?:\?case=(?<kind>parameterized|property|fuzz):(?<caseId>.+))?$/u.exec(identifier);
    if (!match?.groups)
    {
        fail('replay.test-id-invalid', `canonical test ID has invalid syntax: ${identifier}`);
    }
    const sourceSegments = match.groups.source.split('/');
    if (sourceSegments.some((segment) => !segment))
    {
        fail('replay.test-id-invalid', 'canonical test ID source contains an empty segment');
    }
    for (const [index, segment] of sourceSegments.entries())
    {
        const decoded = canonicalEncoded(segment, `source[${index}]`);
        if (decoded === '.' || decoded === '..' || decoded.includes('\\') || decoded.includes('/'))
        {
            fail('replay.test-id-invalid', 'canonical test ID source segment is ambiguous');
        }
    }
    for (const [index, segment] of match.groups.name.split('/').entries())
    {
        const decoded = canonicalEncoded(segment, `name[${index}]`);
        if (decoded.includes('/'))
        {
            fail('replay.test-id-invalid', 'canonical test ID name segment is ambiguous');
        }
    }
    if (match.groups.kind)
    {
        canonicalEncoded(match.groups.caseId, 'caseIdentity.id');
    }
    return identifier;
}

export function sortCanonicalTestIds(testIds)
{
    if (!Array.isArray(testIds))
    {
        fail('replay.discovery-invalid', 'test IDs must be an array');
    }
    const normalized = testIds.map(validateCanonicalTestId);
    const duplicates = normalized.filter((identifier, index) => normalized.indexOf(identifier) !== index);
    if (duplicates.length > 0)
    {
        fail('replay.test-id-duplicate', 'canonical test IDs must be unique', {
            duplicates: [...new Set(duplicates)].sort(compareUtf8)
        });
    }
    return normalized.sort(compareUtf8);
}

export function deriveReplayStream({
    rootSeed,
    producerId,
    canonicalTestId: consumerTestId,
    streamId,
    version = REPLAY_STREAM_VERSION
})
{
    const normalizedSeed = normalizeRootSeed(rootSeed);
    const producer = requiredText(producerId, 'producerId');
    if (!stableIdPattern.test(producer))
    {
        fail('replay.stream-invalid', 'producerId must use lowercase stable ID syntax');
    }
    const consumer = validateCanonicalTestId(consumerTestId);
    const stream = requiredText(streamId, 'streamId');
    if (!stableIdPattern.test(stream))
    {
        fail('replay.stream-invalid', 'streamId must use lowercase stable ID syntax');
    }
    if (version !== REPLAY_STREAM_VERSION)
    {
        fail('replay.stream-invalid', `unsupported replay stream derivation version: ${version}`);
    }
    const domain = canonicalJson({
        consumerTestId: consumer,
        domain: 'fsusblog.test-execution-replay-stream',
        producerId: producer,
        streamId: stream,
        version
    });
    const key = Buffer.from(normalizedSeed.slice('seed256:'.length), 'hex');
    const seed = `seed256:${createHmac('sha256', key).update(domain).digest('hex')}`;
    return Object.freeze({
        version,
        producerId: producer,
        streamId: stream,
        consumerTestId: consumer,
        seed
    });
}

function validateCanonicalIdArray(value, field, { sorted = false } = {})
{
    if (!Array.isArray(value))
    {
        fail('replay.schema-invalid', `${field} must be an array`);
    }
    const identifiers = value.map(validateCanonicalTestId);
    if (new Set(identifiers).size !== identifiers.length)
    {
        fail('replay.test-id-duplicate', `${field} contains duplicate canonical test IDs`);
    }
    if (sorted && canonicalJson(identifiers) !== canonicalJson([...identifiers].sort(compareUtf8)))
    {
        fail('replay.order-invalid', `${field} is not in canonical UTF-8 byte order`);
    }
    return identifiers;
}

function validateSource(value)
{
    exactKeys(value, ['commit', 'worktreeFingerprint'], 'source');
    if (!/^[0-9a-f]{40}$/u.test(value.commit))
    {
        fail('replay.source-invalid', 'source.commit must be a full lowercase Git object ID');
    }
    validateDigest(value.worktreeFingerprint, 'source.worktreeFingerprint');
    return value;
}

function validateProducer(value)
{
    exactKeys(value, ['id', 'framework'], 'producer');
    if (!stableIdPattern.test(requiredText(value.id, 'producer.id')))
    {
        fail('replay.producer-invalid', 'producer.id must use lowercase stable ID syntax');
    }
    if (!frameworkPattern.test(requiredText(value.framework, 'producer.framework')))
    {
        fail('replay.producer-invalid', 'producer.framework must use lowercase kebab-case');
    }
    return value;
}

function validateRun(value)
{
    exactKeys(value, ['id', 'mode'], 'run');
    requiredText(value.id, 'run.id');
    if (!['qualification', 'diagnostic'].includes(value.mode))
    {
        fail('replay.run-invalid', 'run.mode must be qualification or diagnostic');
    }
    return value;
}

function validateEntropySources(value, mode)
{
    if (!Array.isArray(value) || value.length !== 1)
    {
        fail('replay.entropy-unrecorded', 'entropySources must record exactly one root seed source');
    }
    const source = value[0];
    exactKeys(source, ['id', 'kind', 'source'], 'entropySources[0]');
    if (source.id !== 'root-seed' || source.kind !== 'root-seed'
      || !['cli', 'plan', 'generated-diagnostic'].includes(source.source))
    {
        fail('replay.entropy-unrecorded', 'entropySources contains an unknown entropy source');
    }
    if (mode === 'qualification' && source.source === 'generated-diagnostic')
    {
        fail('replay.entropy-unrecorded', 'qualification cannot generate a root seed');
    }
    return value;
}

function validateRandomStreams(value, { rootSeed, producerId, knownTestIds = null })
{
    if (!Array.isArray(value))
    {
        fail('replay.stream-invalid', 'randomStreams must be an explicit array, including []');
    }
    const streamIds = new Set();
    const bindings = new Set();
    for (const [index, stream] of value.entries())
    {
        exactKeys(stream, ['version', 'producerId', 'streamId', 'consumerTestId', 'seed'], `randomStreams[${index}]`);
        if (streamIds.has(stream.streamId))
        {
            fail('replay.stream-duplicate', `duplicate streamId: ${stream.streamId}`);
        }
        streamIds.add(stream.streamId);
        const binding = `${stream.streamId}\0${stream.consumerTestId}`;
        if (bindings.has(binding))
        {
            fail('replay.stream-duplicate', `duplicate random stream binding: ${stream.streamId}`);
        }
        bindings.add(binding);
        if (knownTestIds && !knownTestIds.has(stream.consumerTestId))
        {
            fail('replay.stream-unknown-consumer', `stream consumer is not in the canonical test set: ${stream.consumerTestId}`);
        }
        const expected = deriveReplayStream({
            rootSeed,
            producerId,
            canonicalTestId: stream.consumerTestId,
            streamId: stream.streamId,
            version: stream.version
        });
        if (canonicalJson(stream) !== canonicalJson(expected))
        {
            fail('replay.stream-tamper', `random stream seed or binding mismatch: ${stream.streamId}`);
        }
    }
    const ordered = [...value].sort((left, right) => compareUtf8(left.streamId, right.streamId));
    if (canonicalJson(value) !== canonicalJson(ordered))
    {
        fail('replay.stream-invalid', 'randomStreams must be sorted by streamId');
    }
    return value;
}

function validateOrderPolicy(value)
{
    exactKeys(value, ['kind', 'caseSensitivity'], 'orderPolicy');
    if (value.kind !== 'canonical-utf8-bytewise' || value.caseSensitivity !== 'sensitive')
    {
        fail('replay.order-invalid', 'unsupported canonical test order policy');
    }
    return value;
}

function validateShardPolicy(value, shardCount)
{
    exactKeys(value, ['kind', 'shardCount', 'emptyShards'], 'shardPolicy');
    if (value.kind !== 'contiguous-balanced' || !Number.isInteger(value.shardCount)
      || value.shardCount < 1 || value.shardCount !== shardCount
      || !['allow', 'forbid'].includes(value.emptyShards))
    {
        fail('replay.shard-invalid', 'unsupported or inconsistent shard policy');
    }
    return value;
}

function validateShards(value, testIds, shardPolicy)
{
    if (!Array.isArray(value) || value.length === 0)
    {
        fail('replay.shard-invalid', 'shards must contain explicit membership');
    }
    const expectedIds = new Set(testIds);
    const assigned = [];
    const shardIds = new Set();
    for (const [index, shard] of value.entries())
    {
        exactKeys(shard, ['id', 'testIds'], `shards[${index}]`);
        if (!stableIdPattern.test(requiredText(shard.id, `shards[${index}].id`)) || shardIds.has(shard.id))
        {
            fail('replay.shard-invalid', `invalid or duplicate shard ID: ${shard.id}`);
        }
        shardIds.add(shard.id);
        const identifiers = validateCanonicalIdArray(shard.testIds, `shards[${index}].testIds`);
        if (identifiers.length === 0 && shardPolicy.emptyShards === 'forbid')
        {
            fail('replay.shard-invalid', `empty shard is forbidden: ${shard.id}`);
        }
        assigned.push(...identifiers);
    }
    const duplicates = assigned.filter((identifier, index) => assigned.indexOf(identifier) !== index);
    const assignedSet = new Set(assigned);
    const missing = testIds.filter((identifier) => !assignedSet.has(identifier));
    const unknown = [...assignedSet].filter((identifier) => !expectedIds.has(identifier));
    if (duplicates.length > 0 || missing.length > 0 || unknown.length > 0 || assigned.length !== testIds.length)
    {
        fail('replay.shard-membership-mismatch', 'each canonical test ID must belong to exactly one shard', {
            duplicates: [...new Set(duplicates)].sort(compareUtf8),
            missing: missing.sort(compareUtf8),
            unknown: unknown.sort(compareUtf8)
        });
    }
    return value;
}

function validateWorkers(value)
{
    exactKeys(value, ['ids', 'assignmentPolicy'], 'workers');
    if (!Array.isArray(value.ids) || value.ids.length === 0
      || value.ids.some((identifier) => !stableIdPattern.test(identifier))
      || new Set(value.ids).size !== value.ids.length)
    {
        fail('replay.worker-invalid', 'workers.ids must be a non-empty unique stable ID array');
    }
    if (value.assignmentPolicy !== 'framework-owned-after-seal')
    {
        fail('replay.worker-invalid', 'unsupported worker assignment policy');
    }
    return value;
}

function validateFrameworkModes(value)
{
    if (!Array.isArray(value))
    {
        fail('replay.framework-mode-invalid', 'frameworkModes must be an explicit array');
    }
    const names = new Set();
    for (const [index, mode] of value.entries())
    {
        exactKeys(mode, ['name', 'value'], `frameworkModes[${index}]`);
        if (!stableIdPattern.test(requiredText(mode.name, `frameworkModes[${index}].name`))
          || names.has(mode.name))
        {
            fail('replay.framework-mode-invalid', `duplicate or invalid framework mode: ${mode.name}`);
        }
        names.add(mode.name);
        requiredText(mode.value, `frameworkModes[${index}].value`);
    }
    const ordered = [...value].sort((left, right) => compareUtf8(left.name, right.name));
    if (canonicalJson(value) !== canonicalJson(ordered))
    {
        fail('replay.framework-mode-invalid', 'frameworkModes must be sorted by name');
    }
    return value;
}

function validateSchedulerReadyPolicy(value)
{
    exactKeys(value, ['kind', 'dynamicReassignment'], 'schedulerReadyPolicy');
    if (value.kind !== 'sealed-shard-order' || value.dynamicReassignment !== false)
    {
        fail('replay.scheduler-policy-invalid', 'scheduler ready policy must preserve sealed shard order');
    }
    return value;
}

function commandIdentity(command)
{
    return {
        executable: command.executable,
        args: command.args,
        environmentDigest: command.environmentDigest
    };
}

function validateCommand(value)
{
    exactKeys(value, ['executable', 'args', 'environmentDigest', 'digest'], 'command');
    requiredText(value.executable, 'command.executable');
    if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== 'string'))
    {
        fail('replay.command-invalid', 'command.args must be an exact string array');
    }
    validateDigest(value.environmentDigest, 'command.environmentDigest');
    validateDigest(value.digest, 'command.digest');
    if (canonicalDigest(commandIdentity(value)) !== value.digest)
    {
        fail('replay.command-tamper', 'command executable, args or environment digest was modified');
    }
    return value;
}

export function planExactShards({ testIds, shardCount = 1, allowEmptyShards = false })
{
    const testEnumerationOrder = sortCanonicalTestIds(testIds);
    if (!Number.isInteger(shardCount) || shardCount < 1)
    {
        fail('replay.shard-invalid', 'shardCount must be a positive integer');
    }
    if (!allowEmptyShards && shardCount > testEnumerationOrder.length)
    {
        fail('replay.shard-invalid', 'shardCount would create empty shards');
    }
    const baseSize = Math.floor(testEnumerationOrder.length / shardCount);
    const remainder = testEnumerationOrder.length % shardCount;
    let offset = 0;
    const shards = Array.from({ length: shardCount }, (_, index) =>
    {
        const size = baseSize + (index < remainder ? 1 : 0);
        const shard = {
            id: `shard-${String(index + 1).padStart(4, '0')}`,
            testIds: testEnumerationOrder.slice(offset, offset + size)
        };
        offset += size;
        return shard;
    });
    const orderPolicy = {
        kind: 'canonical-utf8-bytewise',
        caseSensitivity: 'sensitive'
    };
    const shardPolicy = {
        kind: 'contiguous-balanced',
        shardCount,
        emptyShards: allowEmptyShards ? 'allow' : 'forbid'
    };
    return Object.freeze({
        testEnumerationOrder,
        orderPolicy,
        shards,
        shardPolicy,
        enumerationDigest: canonicalDigest(testEnumerationOrder),
        shardDigest: canonicalDigest({ shardPolicy, shards })
    });
}

export async function collectCanonicalDiscovery(adapter, context = {})
{
    exactKeys(adapter, ['discover'], 'discoveryAdapter');
    if (typeof adapter.discover !== 'function')
    {
        fail('replay.discovery-invalid', 'discovery adapter must expose discover(context)');
    }
    const discovered = await adapter.discover(Object.freeze({ ...context }));
    if (!Array.isArray(discovered))
    {
        fail('replay.discovery-invalid', 'discovery adapter must return an array');
    }
    const entries = discovered.map((entry, index) =>
    {
        exactKeys(entry, ['canonicalTestId', 'staticMetadata'], `discovery[${index}]`);
        validateCanonicalTestId(entry.canonicalTestId);
        if (!plainObject(entry.staticMetadata))
        {
            fail('replay.discovery-invalid', `discovery[${index}].staticMetadata must be an object`);
        }
        canonicalJson(entry.staticMetadata);
        return {
            canonicalTestId: entry.canonicalTestId,
            staticMetadata: entry.staticMetadata
        };
    });
    sortCanonicalTestIds(entries.map((entry) => entry.canonicalTestId));
    return entries.sort((left, right) => compareUtf8(left.canonicalTestId, right.canonicalTestId));
}

export function validateDiscoveryAgainstPlan(plan, discoveredTestIds)
{
    const normalizedPlan = validateReplayPlan(plan);
    const actual = sortCanonicalTestIds(discoveredTestIds);
    const expected = [...normalizedPlan.testEnumerationOrder].sort(compareUtf8);
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((identifier) => !actualSet.has(identifier));
    const extra = actual.filter((identifier) => !expectedSet.has(identifier));
    if (missing.length > 0 || extra.length > 0 || canonicalJson(actual) !== canonicalJson(expected))
    {
        fail('replay.discovery-drift', 'discovery set differs from the sealed replay plan', { missing, extra });
    }
    return Object.freeze({
        exact: true,
        testCount: actual.length,
        enumerationDigest: canonicalDigest(actual)
    });
}

function unsignedPlan(plan)
{
    const { planDigest, ...unsigned } = plan;
    return unsigned;
}

export function sealReplayPlan(input)
{
    if (!plainObject(input) || 'planDigest' in input)
    {
        fail('replay.schema-invalid', 'sealReplayPlan accepts an unsigned plan only');
    }
    const command = {
        ...input.command,
        digest: canonicalDigest(commandIdentity(input.command ?? {}))
    };
    const document = {
        ...input,
        command,
        enumerationDigest: canonicalDigest(input.testEnumerationOrder),
        shardDigest: canonicalDigest({ shardPolicy: input.shardPolicy, shards: input.shards })
    };
    const sealed = { ...document, planDigest: canonicalDigest(document) };
    return Object.freeze(validateReplayPlan(sealed));
}

export function validateReplayPlan(plan)
{
    exactKeys(plan, [
        'schema',
        'source',
        'producer',
        'run',
        'rootSeed',
        'entropySources',
        'randomStreams',
        'testEnumerationOrder',
        'orderPolicy',
        'shards',
        'shardPolicy',
        'workers',
        'frameworkModes',
        'schedulerReadyPolicy',
        'command',
        'enumerationDigest',
        'shardDigest',
        'planDigest'
    ], 'replayPlan');
    if (plan.schema !== REPLAY_PLAN_SCHEMA)
    {
        fail('replay.schema-unsupported', `unsupported replay plan schema: ${plan.schema}`);
    }
    validateSource(plan.source);
    validateProducer(plan.producer);
    validateRun(plan.run);
    const rootSeed = normalizeRootSeed(plan.rootSeed);
    validateEntropySources(plan.entropySources, plan.run.mode);
    const testIds = validateCanonicalIdArray(plan.testEnumerationOrder, 'testEnumerationOrder', { sorted: true });
    validateOrderPolicy(plan.orderPolicy);
    validateShardPolicy(plan.shardPolicy, plan.shards?.length);
    validateShards(plan.shards, testIds, plan.shardPolicy);
    validateWorkers(plan.workers);
    validateFrameworkModes(plan.frameworkModes);
    validateSchedulerReadyPolicy(plan.schedulerReadyPolicy);
    validateCommand(plan.command);
    validateRandomStreams(plan.randomStreams, {
        rootSeed,
        producerId: plan.producer.id,
        knownTestIds: new Set(testIds)
    });
    validateDigest(plan.enumerationDigest, 'enumerationDigest');
    validateDigest(plan.shardDigest, 'shardDigest');
    validateDigest(plan.planDigest, 'planDigest');
    if (plan.enumerationDigest !== canonicalDigest(testIds)
      || plan.shardDigest !== canonicalDigest({ shardPolicy: plan.shardPolicy, shards: plan.shards })
      || plan.planDigest !== canonicalDigest(unsignedPlan(plan)))
    {
        fail('replay.plan-tamper', 'replay plan content digest mismatch');
    }
    return plan;
}

function validateWorkerReceipts(value, testIds)
{
    if (!Array.isArray(value) || value.length === 0)
    {
        fail('replay.worker-invalid', 'receipt workers must be a non-empty array');
    }
    const workerIds = new Set();
    const assignments = [];
    for (const [index, worker] of value.entries())
    {
        exactKeys(worker, ['id', 'testIds'], `workers[${index}]`);
        if (!stableIdPattern.test(requiredText(worker.id, `workers[${index}].id`)) || workerIds.has(worker.id))
        {
            fail('replay.worker-invalid', `invalid or duplicate worker ID: ${worker.id}`);
        }
        workerIds.add(worker.id);
        assignments.push(...validateCanonicalIdArray(worker.testIds, `workers[${index}].testIds`));
    }
    const assignedSet = new Set(assignments);
    const expectedSet = new Set(testIds);
    const duplicates = assignments.filter((identifier, index) => assignments.indexOf(identifier) !== index);
    const missing = testIds.filter((identifier) => !assignedSet.has(identifier));
    const unknown = [...assignedSet].filter((identifier) => !expectedSet.has(identifier));
    if (duplicates.length > 0 || missing.length > 0 || unknown.length > 0)
    {
        fail('replay.worker-assignment-mismatch', 'receipt workers must exact-once own every actual test ID', {
            duplicates: [...new Set(duplicates)], missing, unknown
        });
    }
    return workerIds;
}

function validateAdmissionSequence(value, testIds, shardIds, workerIds)
{
    if (!Array.isArray(value) || value.length !== testIds.length)
    {
        fail('replay.admission-invalid', 'admissionSequence must exact-match actual test count');
    }
    for (const [index, admission] of value.entries())
    {
        exactKeys(admission, ['ordinal', 'testId', 'shardId', 'workerId'], `admissionSequence[${index}]`);
        if (admission.ordinal !== index || admission.testId !== testIds[index]
          || !shardIds.has(admission.shardId) || !workerIds.has(admission.workerId))
        {
            fail('replay.admission-invalid', `invalid admission binding at ordinal ${index}`);
        }
    }
}

function validateProcessOutcome(value)
{
    exactKeys(value, ['status', 'exitCode', 'signal'], 'processOutcome');
    if (!['passed', 'failed', 'cancelled'].includes(value.status)
      || !(value.exitCode === null || Number.isInteger(value.exitCode))
      || !(value.signal === null || (typeof value.signal === 'string' && value.signal.length > 0)))
    {
        fail('replay.process-outcome-invalid', 'processOutcome is invalid');
    }
    if (value.status === 'passed' && (value.exitCode !== 0 || value.signal !== null))
    {
        fail('replay.process-outcome-invalid', 'passed process outcome requires exitCode=0 and signal=null');
    }
}

function unsignedReceipt(receipt)
{
    const { receiptDigest, ...unsigned } = receipt;
    return unsigned;
}

export function sealReplayReceipt(input)
{
    if (!plainObject(input) || 'receiptDigest' in input)
    {
        fail('replay.schema-invalid', 'sealReplayReceipt accepts an unsigned receipt only');
    }
    const sealed = { ...input, receiptDigest: canonicalDigest(input) };
    return Object.freeze(validateReplayReceipt(sealed));
}

export function validateReplayReceipt(receipt)
{
    exactKeys(receipt, [
        'schema',
        'source',
        'producer',
        'run',
        'planDigest',
        'rootSeed',
        'entropySources',
        'randomStreams',
        'testIds',
        'shards',
        'workers',
        'admissionSequence',
        'processOutcome',
        'receiptDigest'
    ], 'replayReceipt');
    if (receipt.schema !== REPLAY_RECEIPT_SCHEMA)
    {
        fail('replay.schema-unsupported', `unsupported replay receipt schema: ${receipt.schema}`);
    }
    validateSource(receipt.source);
    validateProducer(receipt.producer);
    validateRun(receipt.run);
    validateDigest(receipt.planDigest, 'planDigest');
    const rootSeed = normalizeRootSeed(receipt.rootSeed);
    validateEntropySources(receipt.entropySources, receipt.run.mode);
    const testIds = validateCanonicalIdArray(receipt.testIds, 'testIds');
    const receiptShardPolicy = { emptyShards: 'allow' };
    validateShards(receipt.shards, testIds, receiptShardPolicy);
    const workerIds = validateWorkerReceipts(receipt.workers, testIds);
    validateAdmissionSequence(
        receipt.admissionSequence,
        testIds,
        new Set(receipt.shards.map((shard) => shard.id)),
        workerIds
    );
    validateProcessOutcome(receipt.processOutcome);
    validateRandomStreams(receipt.randomStreams, {
        rootSeed,
        producerId: receipt.producer.id
    });
    validateDigest(receipt.receiptDigest, 'receiptDigest');
    if (receipt.receiptDigest !== canonicalDigest(unsignedReceipt(receipt)))
    {
        fail('replay.receipt-tamper', 'replay receipt content digest mismatch');
    }
    return receipt;
}

function sameBinding(expected, actual, fields, reasonCode)
{
    for (const field of fields)
    {
        if (canonicalJson(expected[field]) !== canonicalJson(actual[field]))
        {
            fail(reasonCode, `${field} binding mismatch`, {
                field,
                expected: expected[field],
                actual: actual[field]
            });
        }
    }
}

export function validateReplayBundle({ plan, receipt })
{
    const normalizedPlan = validateReplayPlan(plan);
    const normalizedReceipt = validateReplayReceipt(receipt);
    sameBinding(normalizedPlan.source, normalizedReceipt.source,
        ['commit', 'worktreeFingerprint'], 'replay.source-binding-mismatch');
    sameBinding(normalizedPlan.producer, normalizedReceipt.producer,
        ['id', 'framework'], 'replay.producer-binding-mismatch');
    sameBinding(normalizedPlan.run, normalizedReceipt.run,
        ['id', 'mode'], 'replay.run-binding-mismatch');
    if (normalizedReceipt.planDigest !== normalizedPlan.planDigest
      || normalizedReceipt.rootSeed !== normalizedPlan.rootSeed)
    {
        fail('replay.plan-binding-mismatch', 'receipt does not bind the sealed plan and root seed');
    }
    if (canonicalJson(normalizedReceipt.entropySources) !== canonicalJson(normalizedPlan.entropySources))
    {
        fail('replay.entropy-unrecorded', 'actual entropy sources differ from the sealed plan');
    }
    if (canonicalJson(normalizedReceipt.randomStreams) !== canonicalJson(normalizedPlan.randomStreams))
    {
        fail('replay.stream-unknown', 'actual random streams differ from the sealed plan');
    }
    return Object.freeze({
        valid: true,
        planDigest: normalizedPlan.planDigest,
        receiptDigest: normalizedReceipt.receiptDigest
    });
}
