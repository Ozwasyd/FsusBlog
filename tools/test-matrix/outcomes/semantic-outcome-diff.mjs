import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';

import { analyzeStrongSemanticOutcome, assertOutcomeAnalysisData } from './strong-outcome-analysis.mjs';

const { canonicalJson } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

const categories = [
    'identityMismatch', 'planMismatch', 'missingTests', 'extraTests', 'statusChanges',
    'failureTopologyChanges', 'coverageChanges', 'stateDigestChanges', 'artifactDigestChanges',
    'policyChanges', 'volatileOnlyChanges'
];
const statusSets = ['passedTestIds', 'failedTestIds', 'skippedTestIds', 'blockedTestIds'];
const domains = {
    plannedTestIds: 'planMismatch', requiredProducerIds: 'planMismatch', scenarioIds: 'planMismatch',
    assertions: 'failureTopologyChanges', failures: 'failureTopologyChanges', failureTopology: 'failureTopologyChanges',
    coverageIds: 'coverageChanges', requiredCoverageIds: 'coverageChanges', observedCoverageIds: 'coverageChanges',
    stateSemanticDigests: 'stateDigestChanges', artifactSemanticDigests: 'artifactDigestChanges',
    projectionReceipts: 'artifactDigestChanges', producerOutcomeRefs: 'artifactDigestChanges',
    policyDigests: 'policyChanges', redactedSecrets: 'policyChanges', cleanFirstAttempt: 'policyChanges',
    qualificationEligible: 'policyChanges', producerStatus: 'statusChanges',
    producerStatusVector: 'statusChanges', completenessStatus: 'statusChanges',
    executedTestIds: 'statusChanges', passedTestIds: 'statusChanges', failedTestIds: 'statusChanges',
    skippedTestIds: 'statusChanges', blockedTestIds: 'statusChanges'
};
const recordKeys = {
    'records-by-id': 'id', 'records-by-semantic-id': 'semanticId', 'records-by-policy-id': 'policyId',
    'records-by-projection-id': 'projectionId', 'records-by-producer-id': 'producerId'
};

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`semantic outcome diff: ${message}`);
    }
}

function exactKeys(value, keys, label)
{
    require(value && !Array.isArray(value)
        && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields must be exact`);
}

function version(input)
{
    return {
        schema: input.outcome.schema, schemaVersion: input.outcome.schemaVersion,
        algorithm: input.outcome.fingerprintAlgorithmVersion,
        registryVersion: input.options.fieldDispositions.schemaVersion,
        registryDigest: input.options.expectedContractDigests.fieldDispositions,
        producerSchemaDigest: input.options.expectedContractDigests.producerSchema,
        aggregateSchemaDigest: input.options.expectedContractDigests.aggregateSchema
    };
}

function source(input)
{
    const outcome = input.outcome;
    return {
        schema: outcome.schema, sourceCommit: outcome.sourceCommit,
        runId: outcome.schedulerRunId ?? outcome.runId,
        producerId: outcome.producerId ?? null,
        producerAuthorityId: outcome.producerAuthorityId ?? null,
        contentDigest: outcome.contentDigest
    };
}

function flatten(value, declarations, schemaPath = '$', canonicalPath = '$', result = new Map(), identity = {})
{
    const entry = declarations.get(schemaPath);
    const rule = entry?.normalizationRule;
    if (Array.isArray(value))
    {
        for (const item of value)
        {
            const key = rule === 'ids' ? item : rule === 'canonical-record-set'
                ? canonicalJson([item.producerId, item.testId, item.assertionId, item.failureKind])
                : item[recordKeys[rule]];
            require(typeof key === 'string', `unregistered array identity ${schemaPath}`);
            const nextIdentity = item && typeof item === 'object'
                ? { ...identity, producerId: item.producerId ?? identity.producerId,
                    testId: item.testId ?? identity.testId,
                    assertionId: item.assertionId ?? (recordKeys[rule] === 'id' ? item.id : identity.assertionId) }
                : { ...identity, ...(schemaPath.endsWith('TestIds') ? { testId: item } : {}) };
            flatten(item, declarations, `${schemaPath}[]`, `${canonicalPath}[${JSON.stringify(key)}]`, result, nextIdentity);
        }
    }
    else if (value && typeof value === 'object')
    {
        for (const key of Object.keys(value))
        {
            flatten(value[key], declarations, `${schemaPath}.${key}`, `${canonicalPath}.${key}`, result, identity);
        }
    }
    else
    {
        result.set(canonicalPath, { value, schemaPath, entry, identity });
    }
    return result;
}

function side(entry)
{
    return { present: entry !== undefined, value: entry?.value ?? null };
}

function domain(entry)
{
    const top = entry.schemaPath.slice(2).split(/[.[]/u)[0];
    if (top === 'replayPlanDigest')
    {
        return 'planMismatch';
    }
    if (entry.entry?.category === 'execution-identity' && !['assertions', 'failures', 'failureTopology'].includes(top))
    {
        return 'identityMismatch';
    }
    if (top === 'assertions' && entry.schemaPath.endsWith('.status'))
    {
        return 'statusChanges';
    }
    const category = domains[top];
    require(category, `semantic field has no diff domain ${entry.schemaPath}`);
    return category;
}

function differences(left, right, declarations, roots, output, metadata = false)
{
    const leftFields = flatten(left, declarations, roots.schema, roots.path);
    const rightFields = flatten(right, declarations, roots.schema, roots.path);
    for (const canonicalPath of [...new Set([...leftFields.keys(), ...rightFields.keys()])].sort())
    {
        const l = leftFields.get(canonicalPath);
        const r = rightFields.get(canonicalPath);
        if (canonicalJson(side(l)) === canonicalJson(side(r)))
        {
            continue;
        }
        const entry = l ?? r;
        const category = metadata ? entry.entry.category === 'volatile-metadata'
            ? 'volatileOnlyChanges' : 'nonSemanticChanges' : domain(entry);
        output[category].push({
            path: canonicalPath, schemaPath: entry.schemaPath,
            domain: entry.schemaPath.split(/[.[]/u)[1], disposition: entry.entry?.category,
            producerId: entry.identity.producerId ?? output.sourceRefs.left.producerId,
            testId: entry.identity.testId ?? null, assertionId: entry.identity.assertionId ?? null,
            left: side(l), right: side(r), sourceRefs: output.sourceRefs
        });
    }
}

function testStatuses(outcome)
{
    return new Map(statusSets.flatMap((name) => outcome[name].map((id) => [id, name.slice(0, -7)])));
}

/** Compare independently expected strong DATA_ONLY values; never accept caller analysis flags. */
export function diffSemanticOutcomeData(left, right)
{
    for (const input of [left, right])
    {
        require(input && typeof input === 'object' && !types.isProxy(input)
            && Object.getPrototypeOf(input) === Object.prototype, 'plain comparison side required');
        const descriptor = input && Object.getOwnPropertyDescriptor(input, 'options');
        require(descriptor && Object.hasOwn(descriptor, 'value'), 'explicit side options required');
        require(descriptor.value && typeof descriptor.value === 'object' && !types.isProxy(descriptor.value),
            'plain external options required');
        const limitsDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, 'hostExpectedLimits');
        require(limitsDescriptor && Object.hasOwn(limitsDescriptor, 'value'), 'external host limits required');
        assertOutcomeAnalysisData(input, limitsDescriptor.value);
        exactKeys(input, ['outcome', 'options', 'metadata', 'members'], 'comparison side');
    }
    const versions = { left: version(left), right: version(right) };
    const output = {
        schema: 'fsusblog.semantic-outcome-diff.v1', dataOnly: true, producerVerificationPending: true,
        versions, sourceRefs: { left: source(left), right: source(right) },
        versionMismatch: null, inputsValidated: false, comparisonPerformed: false, semanticDrift: null,
        ...Object.fromEntries(categories.map((name) => [name, []])), nonSemanticChanges: []
    };
    if (canonicalJson(versions.left) !== canonicalJson(versions.right))
    {
        output.versionMismatch = versions;
        return output;
    }
    const l = analyzeStrongSemanticOutcome(left.outcome, left.options, left.metadata, left.members);
    const r = analyzeStrongSemanticOutcome(right.outcome, right.options, right.metadata, right.members);
    for (const [input, analysis] of [[left, l], [right, r]])
    {
        require(analysis.outcomeFingerprint === (input.outcome.outcomeFingerprint ?? input.outcome.aggregateOutcomeFingerprint),
            'claimed fingerprint mismatch');
        if (Object.hasOwn(input.outcome, 'semanticPayloadDigest'))
        {
            require(analysis.semanticPayloadDigest === input.outcome.semanticPayloadDigest, 'claimed semantic payload digest mismatch');
        }
    }
    const declarations = new Map(left.options.fieldDispositions.canonicalization.schemas
        .find((item) => item.schema === left.outcome.schema).fields.map((entry) => [entry.schemaPath, entry]));
    const metadataDeclarations = new Map(left.options.fieldDispositions.canonicalization.nestedFields
        .filter((entry) => entry.schemaPath.startsWith('$metadata')).map((entry) => [entry.schemaPath, entry]));
    differences(l.semanticPayload.outcome, r.semanticPayload.outcome, declarations, { schema: '$', path: '$' }, output);
    differences(l.metadata, r.metadata, metadataDeclarations, { schema: '$metadata', path: '$metadata' }, output, true);
    const leftTests = new Set(l.canonicalOutcome.plannedTestIds);
    const rightTests = new Set(r.canonicalOutcome.plannedTestIds);
    for (const [ids, other, category, leftPresent] of [
        [leftTests, rightTests, 'missingTests', true], [rightTests, leftTests, 'extraTests', false]
    ])
    {
        for (const id of [...ids].filter((item) => !other.has(item)).sort())
        {
            output[category].push({ testId: id, path: `$.plannedTestIds[${JSON.stringify(id)}]`,
                left: { present: leftPresent, value: leftPresent ? id : null },
                right: { present: !leftPresent, value: leftPresent ? null : id }, sourceRefs: output.sourceRefs });
        }
    }
    const leftStatuses = testStatuses(l.canonicalOutcome);
    const rightStatuses = testStatuses(r.canonicalOutcome);
    for (const id of [...leftTests].filter((item) => rightTests.has(item)).sort())
    {
        if (leftStatuses.get(id) !== rightStatuses.get(id))
        {
            output.statusChanges.push({ testId: id, path: `$.testStatus[${JSON.stringify(id)}]`,
                left: { present: true, value: leftStatuses.get(id) }, right: { present: true, value: rightStatuses.get(id) },
                sourceRefs: output.sourceRefs });
        }
    }
    output.comparisonPerformed = true;
    output.inputsValidated = true;
    output.semanticDrift = l.outcomeFingerprint !== r.outcomeFingerprint;
    return output;
}

function readReference(root, reference, maxBytes)
{
    exactKeys(reference, ['path', 'objectDigest'], 'content-addressed reference');
    require(typeof reference.path === 'string' && reference.path.length > 0 && !path.isAbsolute(reference.path)
        && !reference.path.includes('\\') && reference.path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'reference must be an explicit repository-relative path');
    require(/^sha256:[0-9a-f]{64}$/u.test(reference.objectDigest), 'reference SHA-256 required');
    require(realpathSync(root) === root, 'repository root alias forbidden');
    let absolute = root;
    for (const part of reference.path.split('/'))
    {
        absolute = path.join(absolute, part);
        require(!lstatSync(absolute).isSymbolicLink(), 'reference alias forbidden');
    }
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try
    {
        const before = fstatSync(descriptor, { bigint: true });
        require(before.isFile() && before.size <= BigInt(maxBytes), 'reference file or byte budget invalid');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let bytes = 0;
        while (bytes < buffer.length)
        {
            const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
            if (count === 0)
            {
                break;
            }
            bytes += count;
        }
        const after = fstatSync(descriptor, { bigint: true });
        const named = lstatSync(absolute, { bigint: true });
        require(bytes === Number(before.size) && before.size === after.size && before.ino === after.ino
            && before.dev === after.dev && named.ino === after.ino && named.dev === after.dev && !named.isSymbolicLink(),
        'reference changed while reading');
        const raw = buffer.subarray(0, bytes);
        require(`sha256:${createHash('sha256').update(raw).digest('hex')}` === reference.objectDigest, 'reference content digest mismatch');
        return JSON.parse(raw.toString('utf8'));
    }
    finally
    {
        closeSync(descriptor);
    }
}

/** Read-only content-addressed DATA_ONLY CLI. Host budgets are independent CLI arguments. */
export function runSemanticOutcomeDiffCli(argv)
{
    const keys = ['root', 'left', 'left-digest', 'right', 'right-digest', 'max-bytes',
        'max-depth', 'max-nodes', 'max-string-bytes', 'max-array-items', 'max-object-keys'];
    const args = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index]?.slice(2);
        require(argv[index]?.startsWith('--') && keys.includes(key) && !Object.hasOwn(args, key)
            && argv[index + 1] && !argv[index + 1].startsWith('--'), 'exact explicit CLI arguments required');
        args[key] = argv[index + 1];
    }
    exactKeys(args, keys, 'CLI arguments');
    const positive = (key) =>
    {
        require(/^[1-9][0-9]*$/u.test(args[key]) && Number.isSafeInteger(Number(args[key])), `positive finite ${key} required`);
        return Number(args[key]);
    };
    const limits = {
        maxDepth: positive('max-depth'), maxNodes: positive('max-nodes'), maxStringBytes: positive('max-string-bytes'),
        maxArrayItems: positive('max-array-items'), maxObjectKeys: positive('max-object-keys')
    };
    const root = path.resolve(args.root);
    const left = readReference(root, { path: args.left, objectDigest: args['left-digest'] }, positive('max-bytes'));
    const right = readReference(root, { path: args.right, objectDigest: args['right-digest'] }, positive('max-bytes'));
    for (const input of [left, right])
    {
        assertOutcomeAnalysisData(input, limits);
        require(canonicalJson(input.options.hostExpectedLimits) === canonicalJson(limits), 'input host budgets do not match external CLI budgets');
        for (const member of input.members)
        {
            require(canonicalJson(member.options.hostExpectedLimits) === canonicalJson(limits), 'member host budgets do not match external CLI budgets');
        }
    }
    const result = diffSemanticOutcomeData(left, right);
    return { result, exitCode: result.versionMismatch ? 2 : result.semanticDrift ? 1 : 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
{
    try
    {
        const { result, exitCode } = runSemanticOutcomeDiffCli(process.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
        process.exitCode = exitCode;
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 2;
    }
}
