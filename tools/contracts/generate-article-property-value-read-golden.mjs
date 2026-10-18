import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts'), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const encode = wire.encodeArticlePropertyValueReadResponse;
const guid = '00112233-4455-6677-8899-aabbccddeeff';
const digest = 'a'.repeat(64);
const decimal = { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 28, negative: true };
const types = [
    { type: 0, text: 'zero\u0000 文 🌱 <>&\r\n' },
    { type: 1, number: decimal },
    { type: 2, boolean: false },
    { type: 3, utc: '638954208000000001' },
    { type: 4, optionId: guid },
    { type: 5, optionIds: [guid] },
    { type: 6, articleIds: ['9007199254740993', '9223372036854775807'] },
    { type: 7, url: 'https://example.invalid/Case?a=1' }
];
function id(index)
{
    return '00112233-4455-6677-8899-' + (index + 1).toString(16).padStart(12, '0');
}
function definition(index)
{
    const valueType = index % 8;
    return { schemaVersion: 1, definitionId: id(index), definitionOwnerUserId: '42', siteScope: 'primary-site',
        machineKey: `property_${index}`, displayNames: [{ locale: 'en', value: `Property ${index}` }],
        valueType, cardinality: valueType === 5 || valueType === 6 ? 1 : 0, required: false,
        presence: { missing: 0, null: 0, empty: 0 }, defaultValue: null,
        constraints: { minLength: null, maxLength: null, minNumber: null, maxNumber: null,
            minDateUtc: null, maxDateUtc: null, minItems: null, maxItems: null },
        options: valueType === 4 || valueType === 5 ? [{ optionId: guid, label: 'Display only', order: 0, status: 0,
            localizedLabels: [{ locale: 'en', value: 'Display only' }] }] : [],
        referencePolicy: valueType === 6 ? { cardinality: 1, permission: 0, allowCrossSite: false,
            allowDeleted: false, allowArchived: false, allowSelfReference: false, allowCycles: false } : null,
        urlPolicy: valueType === 7 ? { allowedSchemes: ['https'], allowRelative: false, allowAbsolute: true,
            maxLength: 2048, normalization: 0 } : null,
        searchEligible: false, filterable: false, sortable: false, displayPlacement: 1, visibilityScope: 0, status: 0,
        schemaRevision: '1', createdAtUtc: '638954208000000001', updatedAtUtc: '638954208000000001', contentDigest: digest };
}
function entry(index, value = types[index % 8], presence = 2, defaultApplied = false)
{
    return { definitionId: id(index), definitionSchemaRevision: '1', definitionDigest: digest, presence,
        value, valueDigest: digest, defaultApplied };
}
function response(count)
{
    const values = Array.from({ length: count }, (_, index) => entry(index));
    return { articleId: 7, currentArticleRevisionId: '9007199254740993', propertyRevision: count === 0 ? '0' : '1',
        current: count === 0 ? null : { snapshotId: guid, factsetId: guid,
            snapshot: { schemaVersion: 1, coordinates: { definitionOwnerUserId: '42', siteScope: 'primary-site',
                articleId: 7, propertyRevision: '1', articleRevisionId: '9007199254740993',
                draftId: null, draftServerRevision: null, publicationId: null }, values, contentDigest: digest },
            auditReference: guid, auditChainId: '00112233445566778899aabbccddeeff', auditRecordHash: digest },
        definitions: Array.from({ length: count }, (_, index) => definition(index)), reconciliation: [],
        scope: { definitionOwnerUserId: '42', siteScope: 'primary-site', definitionSchemaVersion: 1 } };
}
const cases = [];
function add(name, bytes, valid, note)
{
    cases.push({ name, frameType: 269, payloadHex: Buffer.from(bytes).toString('hex'), valid, ...(note ? { note } : {}) });
}
for (const count of [0, 1, 8, 1000])
{
    add(`current-${count}`, encode(response(count)), true);
}
const zero = encode(response(0));
// Independently specified LE layout, with revision greater than JS MAX_SAFE_INTEGER.
const independentZero = '02' + '07000000' + '0100000000002000' + '0000000000000000' + '00' + '00000000' + '00000000'
    + '01' + '2a00000000000000' + '0c000000' + '7072696d6172792d73697465' + '01000000';
if (Buffer.from(zero).toString('hex') !== independentZero)
{
    throw new Error('property_value_read_zero_layout_drift');
}
const single = response(1);
for (const [name, typed] of types.entries())
{
    const value = structuredClone(single);
    value.current.snapshot.values = [entry(0, typed)];
    value.definitions = [definition(name)];
    value.definitions[0].definitionId = id(0);
    add(`typed-${name}`, encode(value), true);
}
for (const presence of [0, 1])
{
    const value = structuredClone(single);
    value.current.snapshot.values = [entry(0, null, presence)];
    add(`presence-${presence}`, encode(value), true);
}
for (const typed of [{ type: 0, text: '' }, { type: 1, number: { lo: 0, mid: 0, hi: 0, scale: 0, negative: false }
}, { type: 5, optionIds: [] }, { type: 6, articleIds: [] }])
{
    const value = structuredClone(single);
    value.current.snapshot.values = [entry(0, typed)];
    add(`explicit-empty-${typed.type}`, encode(value), true);
}
const defaulted = structuredClone(single);
defaulted.current.snapshot.values = [entry(0, { type: 2, boolean: true }, 2, true)];
defaulted.definitions = [definition(2)];
defaulted.definitions[0].definitionId = id(0);
defaulted.definitions[0].presence.missing = 1;
defaulted.definitions[0].defaultValue = { kind: 2, value: { type: 2, boolean: true }
};
add('default-provenance', encode(defaulted), true);
const constrained = structuredClone(single);
constrained.definitions[0].constraints = { minLength: 0, maxLength: 16384, minNumber: decimal, maxNumber: { ...decimal, negative: false },
    minDateUtc: '0', maxDateUtc: '3155378975999999999', minItems: 0, maxItems: 1000 };
constrained.reconciliation = Array.from({ length: 6 }, (_, status) => ({ definitionId: id(0), status, reasonCode: 'property_definition_changed' }));
add('constraints-policies-statuses', encode(constrained), true);
const bytes = encode(single);
add('truncated', bytes.subarray(0, bytes.length - 1), false);
add('trailing', Buffer.concat([bytes, Buffer.from([0])]), false);
const version = bytes.slice();
version[0] = 3;
add('unknown-version', version, false);
const negative = zero.slice();
negative.fill(255, 5, 13);
add('negative-current-revision', negative, false);
for (const count of [-1, 1001, 2147483647])
{
    const corrupt = zero.slice();
    new DataView(corrupt.buffer).setInt32(22, count, true);
    add(`definitions-count-${count}`, corrupt, false);
}
// Locate a typed entry with a unique binary witness prefix, without inferring tag offsets from its decoder.
const valuePrefix = Buffer.concat([Buffer.from(id(0).replaceAll('-', ''), 'hex'), Buffer.from('0100000000000000', 'hex'), Buffer.from('40000000', 'hex'), Buffer.from(digest), Buffer.from([2, 1])]);
const entryOffset = Buffer.from(bytes).indexOf(valuePrefix);
if (entryOffset < 0)
{
    throw new Error('typed-entry-independent-prefix-missing');
}
const tagOffset = entryOffset + valuePrefix.length;
const badTag = bytes.slice();
badTag[tagOffset] = 8;
add('unknown-value-tag', badTag, false);
const invalidPresence = bytes.slice();
invalidPresence[tagOffset - 2] = 3;
add('unknown-presence', invalidPresence, false);
const mismatch = bytes.slice();
mismatch[tagOffset - 2] = 1;
add('presence-with-payload', mismatch, false);
const digestBytes = bytes.slice();
digestBytes[entryOffset + 28] = 0x47;
add('invalid-digest', digestBytes, false);
const zeroGuid = bytes.slice();
zeroGuid.fill(0, 22, 38);
add('empty-snapshot-guid', zeroGuid, false);
const numeric = structuredClone(single);
numeric.current.snapshot.values = [entry(0, types[1])];
const numberBytes = encode(numeric);
const numberOffset = Buffer.from(numberBytes).indexOf(valuePrefix) + valuePrefix.length;
const scale = numberBytes.slice();
scale[numberOffset + 13] = 29;
add('decimal-invalid-scale', scale, false);
const sign = numberBytes.slice();
sign[numberOffset + 14] = 2;
add('decimal-invalid-sign', sign, false);
const date = structuredClone(single);
date.current.snapshot.values = [entry(0, types[3])];
const dateBytes = encode(date);
const dateOffset = Buffer.from(dateBytes).indexOf(valuePrefix) + valuePrefix.length;
const badDate = dateBytes.slice();
new DataView(badDate.buffer).setBigInt64(dateOffset + 1, 3155378976000000000n, true);
add('date-out-of-range', badDate, false);
const emptySite = response(0);
emptySite.scope.definitionOwnerUserId = null;
add('empty-site-owner', encode(emptySite), true, 'Null means site owner; never substitute actor.');
const siteOwned = response(1);
siteOwned.scope.definitionOwnerUserId = null;
siteOwned.definitions[0].definitionOwnerUserId = null;
siteOwned.current.snapshot.coordinates.definitionOwnerUserId = null;
add('current-site-owner', encode(siteOwned), true);
const emptyOther = response(0);
emptyOther.scope = { definitionOwnerUserId: '9223372036854775807', siteScope: 'secondary-site', definitionSchemaVersion: 1 };
add('empty-other-owner-site', encode(emptyOther), true);
// Scope is trailing; mutate an independently located exact suffix, leaving all facts untouched.
const scopeSuffix = Buffer.from('01' + '2a00000000000000' + '0c000000' + '7072696d6172792d73697465' + '01000000', 'hex');
const scopedSingle = Buffer.from(encode(single));
const scopeOffset = scopedSingle.length - scopeSuffix.length;
if (!scopedSingle.subarray(scopeOffset).equals(scopeSuffix)) throw new Error('property_value_read_scope_suffix_drift');
for (const [name, patch] of [
    ['scope-owner-mismatch', b => b.writeBigInt64LE(43n, scopeOffset + 1)],
    ['scope-site-mismatch', b => b[scopeOffset + 13] = 0x78],
    ['scope-schema-unknown', b => b.writeInt32LE(2, b.length - 4)],
    ['scope-owner-zero', b => b.writeBigInt64LE(0n, scopeOffset + 1)],
    ['scope-owner-negative', b => b.writeBigInt64LE(-1n, scopeOffset + 1)],
    ['scope-owner-presence-unknown', b => b[scopeOffset] = 2],
    ['scope-site-leading-space', b => b[scopeOffset + 13] = 0x20],
    ['scope-site-control', b => b[scopeOffset + 13] = 0x00],
    ['scope-site-malformed-utf8', b => b[scopeOffset + 13] = 0xff]
])
{
    const corrupt = Buffer.from(scopedSingle); patch(corrupt); add(name, corrupt, false);
}
add('scope-missing', scopedSingle.subarray(0, scopeOffset), false);
const noDefinitions = response(1);
noDefinitions.definitions = [];
noDefinitions.current.snapshot.values = [];
const noDefinitionBytes = Buffer.from(encode(noDefinitions));
add('current-no-definitions', noDefinitionBytes, true, 'Scope binds existing snapshot coordinates even without definition descriptors.');
const coordinatePrefix = Buffer.from('01' + '2a00000000000000' + '0c000000' + '7072696d6172792d73697465' + '07000000', 'hex');
const coordinateOffset = noDefinitionBytes.indexOf(coordinatePrefix);
if (coordinateOffset < 0) throw new Error('scope-coordinate-prefix-missing');
const coordinateOwner = Buffer.from(noDefinitionBytes);
coordinateOwner.writeBigInt64LE(43n, coordinateOffset + 1);
add('snapshot-only-owner-mismatch', coordinateOwner, false);
const coordinateSite = Buffer.from(noDefinitionBytes);
coordinateSite[coordinateOffset + 13] = 0x78;
add('snapshot-only-site-mismatch', coordinateSite, false);
const manyDefinitions = Buffer.from(encode(response(8)));
const lastDefinitionPrefix = Buffer.concat([Buffer.from('01000000', 'hex'), Buffer.from(id(7).replaceAll('-', ''), 'hex'), scopeSuffix.subarray(0, scopeSuffix.length - 4)]);
const lastDefinitionOffset = manyDefinitions.indexOf(lastDefinitionPrefix);
if (lastDefinitionOffset < 0) throw new Error('scope-last-definition-prefix-missing');
manyDefinitions.writeBigInt64LE(43n, lastDefinitionOffset + 21);
add('last-definition-owner-mismatch', manyDefinitions, false);

const retired = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/article-property-value-read-wire-v1-retired.json'), 'utf8'));
for (const sample of retired.cases) add(`retired-v1-${sample.name}`, Buffer.from(sample.payloadHex, 'hex'), false, 'Exact former v1 witness retained; v2 rejects without permissive fallback.');
const out = JSON.stringify({ schemaVersion: 2, generatedBy: 'tools/contracts/generate-article-property-value-read-golden.mjs',
    note: 'Synthetic wire-only fixtures: lowercase digests are shape witnesses, not authentic persisted receipts or HTTP qualification. Current-1000 is modest descriptor/option distribution, not1000x1000options admission.', independentZero, cases }, null, 2) + '\n';
const target = path.join(root, 'tests/fixtures/protocol/article-property-value-read-wire-golden.json');
if (process.argv.includes('--check'))
{
    if (readFileSync(target, 'utf8') !== out)
    {
        throw new Error('property_value_read_golden_drift');
    }
}
else
{
    writeFileSync(target, out);
}

// Mutation roots reuse the same strict primitive producer and retain the original read witnesses.
const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
const mutationCases = [];
function mutationCase(record, name, value)
{
    const frameType = protocol.frameTypes.find(frame => frame.name === record).value;
    const bytes = wire[`encode${record}`](value);
    mutationCases.push({ record, name, frameType, payloadHex: Buffer.from(bytes).toString('hex'), valid: true });
    for (const [suffix, altered] of [
        ['truncated', bytes.slice(0, -1)], ['trailing', Uint8Array.from([...bytes, 0])],
        ['unknown-version', Uint8Array.from([255, ...bytes.slice(1)])]
    ])
    {
        mutationCases.push({ record, name: name + '-' + suffix, frameType, payloadHex: Buffer.from(altered).toString('hex'), valid: false });
    }
}
const baseCommand = { requestId: guid, definitionOwnerUserId: '42', siteScope: 'primary-site',
    articleId: 7, expectedArticleRevisionId: '9223372036854775807', expectedPropertyRevision: '0', mode: 1, changes: [] };
const extremes = [...types, { type: 1, number: { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 0, negative: false } },
    { type: 1, number: { lo: 1, mid: 0, hi: 0, scale: 28, negative: true } },
    { type: 3, utc: '0' }, { type: 3, utc: '3155378975999999999' }];
for (const [index, value] of extremes.entries())
{
    mutationCase('ArticlePropertyValueMutationCommand', `value-${index}`, { ...baseCommand,
        changes: [{ kind: 0, input: { definitionId: guid, definitionSchemaRevision: '9223372036854775807',
            definitionDigest: digest, presence: 2, value } }] });
}
mutationCase('ArticlePropertyValueMutationCommand', 'empty-replace', { ...baseCommand, mode: 0 });
mutationCase('ArticlePropertyValueMutationReceipt', 'persisted-value-receipt', { receiptId: guid,
    actorAdminPrincipalId: '9223372036854775807', requestId: guid, definitionOwnerUserId: '42', siteScope: 'primary-site',
    articleId: 7, expectedArticleRevisionId: '9223372036854775807', beforePropertyRevision: '0', afterPropertyRevision: '1',
    beforeSnapshotId: null, afterSnapshotId: guid, commandKind: 1, commandDigest: digest, contentDigest: digest,
    auditReference: guid, auditChainId: 'persisted-chain', auditRecordHash: digest, occurredAtUtc: '638954208000000001', idempotencyReplay: false });
const descriptor = definition(0);
const settings = Object.fromEntries(['valueType', 'cardinality', 'required', 'presence', 'defaultValue', 'constraints',
    'options', 'referencePolicy', 'urlPolicy', 'searchEligible', 'filterable', 'sortable', 'displayPlacement', 'visibilityScope']
    .map(key => [key, descriptor[key]]));
const definitionBase = { requestId: guid, definitionOwnerUserId: '42', siteScope: 'primary-site', definitionId: guid,
    expectedOwnerRevision: '0', expectedSchemaRevision: '1' };
for (const action of ['Create', 'Update', 'Rename', 'Deprecate', 'Delete'])
{
    mutationCase(`ArticlePropertyDefinition${action}Request`, `definition-${action.toLowerCase()}`,
        { ...definitionBase, machineKey: 'field', displayNames: descriptor.displayNames, settings });
}
mutationCase('ArticlePropertyDefinitionMutationReceipt', 'persisted-definition-receipt', {
    receiptId: guid, requestId: guid, actorAdminPrincipalId: '42', definitionOwnerUserId: '42', siteScope: 'primary-site',
    commandKind: 'create', commandDigest: digest, definitionId: guid, previousOwnerRevision: '0', ownerRevision: '1',
    previousSchemaRevision: '0', schemaRevision: '1', status: 0, beforeDefinitionDigest: digest, afterDefinitionDigest: digest,
    constraintDigest: digest, optionsDigest: digest, policyDigest: digest, flagsDigest: digest, obligations: [],
    auditReference: guid, auditDigest: digest, contentDigest: digest, occurredAtUtc: '638954208000000001', isIdempotentReplay: false });
// Independent LE/network-GUID layout oracle for the empty current-article command.
const independentEmptyMutation = '02' + '00112233445566778899aabbccddeeff' + '01' + '2a00000000000000'
    + '0c000000' + '7072696d6172792d73697465' + '07000000' + 'ffffffffffffff7f'
    + '0000000000000000' + '00' + '00000000';
if (mutationCases.find(item => item.name === 'empty-replace').payloadHex !== independentEmptyMutation)
{
    throw new Error('property_mutation_empty_layout_drift');
}
for (const [name, witness, offset, replacement] of [
    ['unknown-mode', 'empty-replace', 62, 255],
    ['invalid-owner-presence', 'empty-replace', 17, 2],
    ['unknown-change-kind', 'value-0', 67, 255],
    ['unknown-value-presence', 'value-0', 160, 255],
    ['invalid-value-presence-marker', 'value-0', 161, 2],
    ['unknown-typed-tag', 'value-0', 162, 255],
    ['invalid-decimal-scale', 'value-1', 175, 29],
    ['invalid-decimal-sign', 'value-1', 176, 2],
    ['invalid-site-utf8', 'empty-replace', 30, 255],
    ['trimmed-site', 'empty-replace', 30, 32],
    ['negative-article-revision', 'empty-replace', 53, 255]
])
{
    const sample = mutationCases.find(item => item.name === witness);
    const bytes = Buffer.from(sample.payloadHex, 'hex');
    bytes[offset] = replacement;
    mutationCases.push({ ...sample, name, payloadHex: bytes.toString('hex'), valid: false });
}
const mutationTarget = path.join(root, 'tests/fixtures/protocol/article-property-mutation-wire-golden.json');
const mutationOutput = JSON.stringify({ schema: 'fsusblog.article-property-mutation-wire-golden.v1', cases: mutationCases }, null, 2) + '\n';
if (process.argv.includes('--check'))
{
    if (readFileSync(mutationTarget, 'utf8') !== mutationOutput) throw new Error('property_mutation_golden_drift');
}
else
{
    writeFileSync(mutationTarget, mutationOutput);
}
