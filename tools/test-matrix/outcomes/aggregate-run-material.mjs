import { types } from 'node:util';

const { validateCurrentRunEvidenceContext } = await import(new URL('../../test/evidence-location-contract.mjs', import.meta.url));

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const testSetNames = Object.freeze(['planned', 'executed', 'passed', 'failed', 'skipped', 'blocked']);
const terminalSetNames = Object.freeze(['passed', 'failed', 'skipped', 'blocked']);
const memberFields = Object.freeze([
    'producerId', 'sealedOutcomeReference', 'expectedIdentity', 'identity', 'summary'
]);
const executionIdentityFields = Object.freeze([
    'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest', 'toolchainDigest', 'policyDigest'
]);
const identityFields = Object.freeze([
    'schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint',
    'candidateIdentity', 'buildIdentity', ...executionIdentityFields
]);

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function record(value, fields, label)
{
    require(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a record`);
    require(!types.isProxy(value), `${label} must not be a proxy`);
    const prototype = Object.getPrototypeOf(value);
    require(prototype === Object.prototype || prototype === null, `${label} prototype is invalid`);
    const keys = Reflect.ownKeys(value);
    require(keys.length === fields.length && fields.every((field) => keys.includes(field)), `${label} fields mismatch`);
    for (const field of fields)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        require(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), `${label}.${field} must be data`);
    }
}

function requireHostLimits(limits)
{
    record(limits, ['maxDepth', 'maxNodes', 'maxBytes', 'maxItems'], 'host expected material limits');
    for (const field of ['maxDepth', 'maxNodes', 'maxBytes', 'maxItems'])
    {
        require(Number.isSafeInteger(limits[field]) && limits[field] > 0,
            `host expected material limits.${field} must be a positive safe integer`);
    }
}

// Count serialized JSON string bytes without allocating an escaped copy.
function jsonStringBytes(value, remaining)
{
    require(value.length <= remaining, 'aggregate material bytes exceed host limit');
    let bytes = 2;
    for (let index = 0; index < value.length; index += 1)
    {
        const code = value.charCodeAt(index);
        if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
        {
            bytes += 2;
        }
        else if (code < 32)
        {
            bytes += 6;
        }
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff)
        {
            bytes += 4;
            index += 1;
        }
        else if (code >= 0xd800 && code <= 0xdfff)
        {
            bytes += 6;
        }
        else
        {
            bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
        }
        require(bytes <= remaining, 'aggregate material bytes exceed host limit');
    }
    return bytes;
}

function requireBoundedJson(value, limits)
{
    const active = new WeakSet();
    const frames = [{ value, depth: 0, exit: false }];
    let nodes = 0;
    let items = 0;
    let bytes = 0;
    while (frames.length > 0)
    {
        const frame = frames.pop();
        if (frame.exit)
        {
            active.delete(frame.value);
            continue;
        }
        nodes += 1;
        require(nodes <= limits.maxNodes, 'aggregate material nodes exceed host limit');
        require(frame.depth <= limits.maxDepth, 'aggregate material depth exceeds host limit');
        const current = frame.value;
        if (current === null || typeof current === 'boolean' || typeof current === 'number')
        {
            require(typeof current !== 'number' || Number.isFinite(current), 'aggregate material number is not JSON');
            bytes += String(current).length;
        }
        else if (typeof current === 'string')
        {
            bytes += jsonStringBytes(current, limits.maxBytes - bytes);
        }
        else
        {
            require(typeof current === 'object' && !types.isProxy(current), 'aggregate material value is not JSON data');
            const array = Array.isArray(current);
            const prototype = Object.getPrototypeOf(current);
            require(array ? prototype === Array.prototype
                : prototype === Object.prototype || prototype === null, 'aggregate material object is not plain JSON');
            require(!active.has(current), 'aggregate material contains a cycle');
            const length = array ? Object.getOwnPropertyDescriptor(current, 'length').value : null;
            require(!array || length <= limits.maxItems - items, 'aggregate material items exceed host limit');
            require(!array || length <= limits.maxNodes - nodes, 'aggregate material nodes exceed host limit');
            // A dense JSON array needs at least one byte per value plus separators.
            require(!array || 2 + length + Math.max(0, length - 1) <= limits.maxBytes - bytes,
                'aggregate material bytes exceed host limit');
            // Constructed object/extra-property key enumeration itself is not byte-bounded.
            const keys = Reflect.ownKeys(current);
            require(!array || keys.length === length + 1, 'aggregate material array is sparse or has extra properties');
            const count = array ? length : keys.length;
            require(count <= limits.maxItems - items, 'aggregate material items exceed host limit');
            require(count <= limits.maxNodes - nodes, 'aggregate material nodes exceed host limit');
            items += count;
            bytes += 2 + Math.max(0, count - 1);
            active.add(current);
            frames.push({ value: current, depth: frame.depth, exit: true });
            for (const key of keys)
            {
                if (array && key === 'length')
                {
                    continue;
                }
                require(typeof key === 'string', 'aggregate material symbol property is not JSON');
                if (array)
                {
                    require(/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < length,
                        'aggregate material array property is not an index');
                }
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                require(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'),
                    'aggregate material hidden or accessor property is not JSON data');
                if (!array)
                {
                    bytes += jsonStringBytes(key, limits.maxBytes - bytes) + 1;
                }
                require(bytes <= limits.maxBytes, 'aggregate material bytes exceed host limit');
                frames.push({ value: descriptor.value, depth: frame.depth + 1, exit: false });
            }
        }
        require(bytes <= limits.maxBytes, 'aggregate material bytes exceed host limit');
    }
}

function ids(values, label)
{
    require(Array.isArray(values) && Array.from(values).every((value) => typeof value === 'string' && value.length > 0),
        `${label} must be IDs`);
    require(new Set(values).size === values.length, `${label} contains duplicate IDs`);
    return [...values].sort();
}

function sameIdentityPart(actual, expected, label)
{
    record(actual, ['id', 'digest'], label);
    record(expected, ['id', 'digest'], `${label} expected`);
    require(typeof actual.id === 'string' && actual.id.length > 0 && digestPattern.test(actual.digest),
        `${label} is invalid`);
    require(actual.id === expected.id && actual.digest === expected.digest, `${label} mismatch`);
}

function requireIdentity(actual, expected, context, label)
{
    record(actual, identityFields, label);
    record(expected, identityFields, `${label} expected`);
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        require(actual[field] === expected[field] && actual[field] === context[field], `${label}.${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        sameIdentityPart(actual[field], expected[field], `${label}.${field}`);
        sameIdentityPart(actual[field], context[field], `${label}.${field} current run`);
    }
    for (const field of executionIdentityFields)
    {
        require(digestPattern.test(actual[field]) && actual[field] === expected[field], `${label}.${field} mismatch`);
    }
}

function requireReference(reference, context, label)
{
    record(reference, ['path', 'objectDigest'], label);
    require(typeof reference.path === 'string' && reference.path.length > 0
        && !reference.path.startsWith('/') && !reference.path.includes('\\')
        && !/[*?[\]{}]/u.test(reference.path)
        && reference.path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
    `${label}.path must be an explicit repository-relative reference`);
    require(context.ownedRoots.some((root) => reference.path.startsWith(`${root}/`)),
        `${label}.path escapes current-run owned roots`);
    require(digestPattern.test(reference.objectDigest), `${label}.objectDigest is invalid`);
}

function digestEntries(values, label)
{
    require(Array.isArray(values), `${label} must be an array`);
    const seen = new Set();
    for (const entry of values)
    {
        record(entry, ['id', 'digest'], label);
        require(typeof entry.id === 'string' && entry.id.length > 0 && !seen.has(entry.id), `${label} ID invalid or duplicate`);
        require(digestPattern.test(entry.digest), `${label} digest invalid`);
        seen.add(entry.id);
    }
    return values;
}

function stableOrder(left, right)
{
    for (const field of ['producerId', 'id'])
    {
        if (left[field] !== right[field])
        {
            return left[field] < right[field] ? -1 : 1;
        }
    }
    return 0;
}

function freeze(value)
{
    const pending = [value];
    const seen = new WeakSet();
    while (pending.length > 0)
    {
        const current = pending.pop();
        if (current && typeof current === 'object' && !seen.has(current))
        {
            seen.add(current);
            Object.values(current).forEach((child) => pending.push(child));
            Object.freeze(current);
        }
    }
    return value;
}

/**
 * Validate and collect aggregate material without granting producer authority.
 * Required IDs, expected identities and summaries here are data, not verified
 * capabilities. The original producer verifier must authenticate them before
 * any aggregate fingerprint, publication or checkpoint reference can exist.
 * This function neither reads paths nor canonicalizes/seals producer payloads.
 * Host limits are mandatory, separate from the producer material and have no
 * production defaults. JSON admission runs before cloning/collection and
 * again before the detached result clone. Limits describe this component's
 * resource boundary, not proof of an admitted producer/execution policy.
 */
export function prepareAggregateRunMaterial(options, hostExpectedLimits)
{
    requireHostLimits(hostExpectedLimits);
    record(options, ['requiredProducerIds', 'context', 'members'], 'aggregate material options');
    requireBoundedJson(options, hostExpectedLimits);
    const { requiredProducerIds, context, members } = options;
    // Match the original closed current-run context schema before its digest
    // validator descends into values; no unknown nested context is admitted.
    record(context, ['schema', 'schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint',
        'candidateIdentity', 'buildIdentity', 'ownedRoots', 'contentDigest'], 'current-run context');
    record(context.candidateIdentity, ['id', 'digest'], 'current-run candidate identity');
    record(context.buildIdentity, ['id', 'digest'], 'current-run build identity');
    validateCurrentRunEvidenceContext(context);
    const required = ids(requiredProducerIds, 'required producers');
    require(required.length > 0, 'required producers must not be empty');
    require(Array.isArray(members), 'aggregate members must be an array');
    const actual = ids(members.map((member) => member?.producerId), 'aggregate producers');
    require(actual.length === required.length && actual.every((id, index) => id === required[index]),
        'aggregate producer membership must be exact-one without missing or extra producers');
    const testSets = Object.fromEntries(testSetNames.map((name) => [name, []]));
    const coverage = { required: [], observed: [] };
    const stateDigests = [];
    const artifactDigests = [];
    const failureTopology = [];
    const statusVector = [];
    const producerReferences = [];
    let complete = true;
    for (const member of members)
    {
        record(member, memberFields, 'aggregate member');
        const { producerId, summary } = member;
        requireReference(member.sealedOutcomeReference, context, `${producerId} outcome reference`);
        requireIdentity(member.identity, member.expectedIdentity, context, producerId);
        record(summary, ['status', 'testSets', 'coverage', 'stateDigests', 'artifactDigests', 'failures'], `${producerId} summary`);
        require(['success', 'failed', 'cancelled', 'blocked', 'partial'].includes(summary.status), `${producerId} status invalid`);
        record(summary.testSets, testSetNames, `${producerId} test sets`);
        const local = Object.fromEntries(testSetNames.map((name) => [name, ids(summary.testSets[name], `${producerId} ${name}`)]));
        const planned = new Set(local.planned);
        const executed = new Set(local.executed);
        const passed = new Set(local.passed);
        const failed = new Set(local.failed);
        require(local.executed.every((id) => planned.has(id)), `${producerId} executed test is not planned`);
        const terminal = new Set();
        for (const name of terminalSetNames)
        {
            for (const id of local[name])
            {
                require(planned.has(id) && !terminal.has(id), `${producerId} terminal test invalid or repeated`);
                require(name === 'passed' || name === 'failed' ? executed.has(id) : !executed.has(id),
                    `${producerId} terminal test execution mismatch`);
                terminal.add(id);
            }
        }
        require(local.executed.every((id) => passed.has(id) || failed.has(id)),
            `${producerId} executed test lacks its terminal result`);
        require(terminal.size === planned.size, `${producerId} planned test lacks its terminal result`);
        record(summary.coverage, ['required', 'observed'], `${producerId} coverage`);
        const requiredCoverage = ids(summary.coverage.required, `${producerId} required coverage`);
        const observedCoverage = ids(summary.coverage.observed, `${producerId} observed coverage`);
        const observedCoverageSet = new Set(observedCoverage);
        const memberComplete = requiredCoverage.every((id) => observedCoverageSet.has(id));
        if (summary.status === 'success')
        {
            require(memberComplete && local.failed.length === 0,
                `${producerId} success conceals incomplete coverage or failed tests`);
        }
        require(Array.isArray(summary.failures), `${producerId} failures must be an array`);
        const failureIds = new Set();
        for (const failure of summary.failures)
        {
            record(failure, ['id', 'kind', 'identity'], `${producerId} failure`);
            require(typeof failure.id === 'string' && failure.id.length > 0 && !failureIds.has(failure.id)
                && typeof failure.kind === 'string' && failure.kind.length > 0,
            `${producerId} failure identity invalid or repeated`);
            require(failure.identity !== null && typeof failure.identity === 'object' && !Array.isArray(failure.identity),
                `${producerId} failure facts missing`);
            failureIds.add(failure.id);
            failureTopology.push({ producerId, ...structuredClone(failure) });
        }
        require(summary.status !== 'success' || summary.failures.length === 0, `${producerId} success conceals failures`);
        complete &&= memberComplete && summary.status !== 'partial';
        for (const name of testSetNames)
        {
            for (const id of local[name])
            {
                testSets[name].push({ producerId, id });
            }
        }
        for (const id of requiredCoverage)
        {
            coverage.required.push({ producerId, id });
        }
        for (const id of observedCoverage)
        {
            coverage.observed.push({ producerId, id });
        }
        for (const entry of digestEntries(summary.stateDigests, `${producerId} state`))
        {
            stateDigests.push({ producerId, ...entry });
        }
        for (const entry of digestEntries(summary.artifactDigests, `${producerId} artifacts`))
        {
            artifactDigests.push({ producerId, ...entry });
        }
        statusVector.push({ producerId, status: summary.status });
        producerReferences.push({ producerId, ...member.sealedOutcomeReference });
    }
    for (const values of [...Object.values(testSets), ...Object.values(coverage), stateDigests,
        artifactDigests, failureTopology, statusVector, producerReferences])
    {
        values.sort(stableOrder);
    }
    const status = ['failed', 'cancelled', 'blocked', 'partial'].find((value) => statusVector.some((member) => member.status === value))
        ?? (complete ? 'complete' : 'partial');
    const material = {
        dataOnly: true,
        producerVerificationPending: true,
        context,
        producerReferences,
        status,
        completeness: complete ? 'complete' : 'partial',
        testSets,
        coverage,
        stateDigests,
        artifactDigests,
        failureTopology,
        statusVector
    };
    requireBoundedJson(material, hostExpectedLimits);
    return freeze(structuredClone(material));
}
