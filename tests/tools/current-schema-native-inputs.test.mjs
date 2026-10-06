import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectOriginalCurrentSchemaCollectorInputs, retainOriginalCurrentSchemaCollectorInputs }
    from '../../tools/test/current-schema-native-inputs.mjs';
import { encodeOriginalFileEpochObservation, originalFileEpochObservationSha256,
    originalLinuxDeviceNumbers, originalLinuxTimestampParts } from '../../tools/test/original-native-file-epoch.mjs';

const leafFields = ['deviceMajor', 'deviceMinor', 'inode', 'mode', 'links', 'uid', 'gid', 'size',
    'modifiedSeconds', 'modifiedNanoseconds', 'changedSeconds', 'changedNanoseconds'];
const directoryFields = ['deviceMajor', 'deviceMinor', 'inode', 'mode'];
const vectorFile = fileURLToPath(new URL('./fixtures/original-native-file-epoch-v1.json', import.meta.url));
const vectors = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
const observation = (vector) => ({ path: vector.path,
    leaf: Object.fromEntries(leafFields.map((field, index) => [field, vector.leaf[index]])),
    ancestors: vector.ancestors.map((row) => Object.fromEntries(directoryFields.map((field, index) => [field, row[index]]))) });

test('exact shared comparison vectors preserve uint64, signed bounds and Unicode path bytes', () =>
{
    for (const vector of vectors)
    {
        const input = observation(vector);
        assert.equal(encodeOriginalFileEpochObservation(input).toString('utf8'), vector.canonical);
        assert.equal(originalFileEpochObservationSha256(input), vector.sha256);
        for (const field of ['inode', 'size'])
        {
            const changed = structuredClone(input);
            changed.leaf[field] = (BigInt(changed.leaf[field]) - 1n).toString();
            assert.notEqual(originalFileEpochObservationSha256(changed), vector.sha256);
        }
        const reordered = structuredClone(input);
        reordered.ancestors.reverse();
        assert.notEqual(originalFileEpochObservationSha256(reordered), vector.sha256);
    }
});

test('comparison encoder refuses noncanonical and overflowing numeric input', () =>
{
    for (const value of ['-0', '+1', '01', '1e3', '18446744073709551616', 9007199254740993])
    {
        const changed = observation(vectors[0]);
        changed.leaf.inode = value;
        assert.throws(() => originalFileEpochObservationSha256(changed));
    }
    const changed = observation(vectors[0]);
    changed.leaf.changedSeconds = '-0';
    assert.throws(() => originalFileEpochObservationSha256(changed));
    changed.leaf.changedSeconds = '-1';
    changed.leaf.changedNanoseconds = '1000000000';
    assert.throws(() => originalFileEpochObservationSha256(changed));
});

test('Linux timestamp floor split and dev_t projection preserve boundary bits', () =>
{
    assert.deepEqual(originalLinuxTimestampParts(-1n), { seconds: '-1', nanoseconds: '999999999' });
    assert.deepEqual(originalLinuxTimestampParts(-1000000001n), { seconds: '-2', nanoseconds: '999999999' });
    assert.deepEqual(originalLinuxDeviceNumbers(0xffffffffffffffffn),
        { deviceMajor: '4294967295', deviceMinor: '4294967295' });
    assert.throws(() => originalLinuxDeviceNumbers(1));
});

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fixtureParent = path.join(repository, '.tmp');
const nativeOptions = { skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) };

function withFixture(run)
{
    fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
    const root = fs.mkdtempSync(path.join(fixtureParent, 'original-input-control-'));
    fs.chmodSync(root, 0o700);
    fs.mkdirSync(path.join(root, 'inputs'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'published'), { mode: 0o700 });
    const env = path.join(root, 'inputs/primary.env');
    const receipt = path.join(root, 'published/current-schema-receipt.bin');
    fs.writeFileSync(env, 'Database__Name=owned-file-control\n', { mode: 0o600 });
    // File-custody fixture only. This is not a valid native receipt or issuer.
    fs.writeFileSync(receipt, Buffer.from([0x46, 0x44, 0x2d, 0x63, 0x6f, 0x6e, 0x74, 0x72, 0x6f, 0x6c]), { mode: 0o600 });
    try { run({ root, env, receipt }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('actual held readonly inputs preserve shared offsets and close only on disposal', nativeOptions, () =>
{
    withFixture(({ root }) =>
    {
        const owner = retainOriginalCurrentSchemaCollectorInputs(root);
        try
        {
            const files = inspectOriginalCurrentSchemaCollectorInputs(owner);
            assert.deepEqual(files.map((file) => [file.role, file.targetDescriptor]),
                [['collector-environment', 4], ['collector-receipt', 5]]);
            const byte = Buffer.alloc(1);
            fs.readSync(files[0].descriptor, byte, 0, 1, null);
            assert.equal(byte.toString(), 'D');
            owner.validateUnchanged();
            fs.readSync(files[0].descriptor, byte, 0, 1, null);
            assert.equal(byte.toString(), 'a');
            owner.dispose();
            for (const file of files) assert.throws(() => fs.fstatSync(file.descriptor), { code: 'EBADF' });
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(owner), /actual open input custody/);
        }
        finally { owner.dispose(); }
    });
});

test('caller records and copied methods cannot import actual input custody', nativeOptions, () =>
{
    withFixture(({ root }) =>
    {
        const owner = retainOriginalCurrentSchemaCollectorInputs(root);
        try
        {
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs({ ...owner }), /actual open input custody/);
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(JSON.parse(JSON.stringify(owner))), /actual open input custody/);
        }
        finally { owner.dispose(); }
    });
});

test('same-byte rewrite revokes original epoch custody before a second inspection', nativeOptions, () =>
{
    withFixture(({ root, env }) =>
    {
        const owner = retainOriginalCurrentSchemaCollectorInputs(root);
        try
        {
            const bytes = fs.readFileSync(env);
            fs.writeFileSync(env, bytes);
            assert.throws(() => owner.validateUnchanged(), /epoch changed/);
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(owner), /actual open input custody/);
        }
        finally { owner.dispose(); }
    });
});

test('replacing leaf or ancestor refuses while original descriptors remain retained', nativeOptions, () =>
{
    for (const ancestor of [false, true])
    {
        withFixture(({ root, env }) =>
        {
            const owner = retainOriginalCurrentSchemaCollectorInputs(root);
            try
            {
                if (ancestor)
                {
                    fs.renameSync(path.join(root, 'inputs'), path.join(root, 'previous-inputs'));
                    fs.mkdirSync(path.join(root, 'inputs'), { mode: 0o700 });
                }
                else fs.renameSync(env, `${env}.previous`);
                fs.writeFileSync(env, 'Database__Name=owned-file-control\n', { mode: 0o600 });
                assert.throws(() => owner.validateUnchanged(), /ancestor incarnation changed|epoch changed/);
            }
            finally { owner.dispose(); }
        });
    }
});

test('actual taskroot/leaf permissions, links, symlinks and caps refuse', nativeOptions, () =>
{
    const mutations = [
        ({ root }) => fs.chmodSync(root, 0o755),
        ({ env }) => fs.chmodSync(env, 0o644),
        ({ env }) => fs.linkSync(env, `${env}.alias`),
        ({ env }) => { fs.renameSync(env, `${env}.real`); fs.symlinkSync(`${env}.real`, env); },
        ({ root }) => { fs.renameSync(path.join(root, 'inputs'), path.join(root, 'real-inputs'));
            fs.symlinkSync(path.join(root, 'real-inputs'), path.join(root, 'inputs')); },
        ({ env }) => fs.truncateSync(env, 1024 * 1024 + 1),
        ({ receipt }) => fs.truncateSync(receipt, 0)
    ];
    for (const mutate of mutations)
    {
        withFixture((fixture) =>
        {
            mutate(fixture);
            assert.throws(() => retainOriginalCurrentSchemaCollectorInputs(fixture.root));
        });
    }
});

test('empty environment stays accepted and cancellation closes borrowed descriptors', nativeOptions, () =>
{
    withFixture(({ root, env }) =>
    {
        fs.truncateSync(env, 0);
        const controller = new AbortController();
        const owner = retainOriginalCurrentSchemaCollectorInputs(root, { signal: controller.signal });
        const files = inspectOriginalCurrentSchemaCollectorInputs(owner);
        controller.abort(new Error('original input fixture cancellation'));
        assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(owner), /actual open input custody/);
        for (const file of files) assert.throws(() => fs.fstatSync(file.descriptor), { code: 'EBADF' });
        owner.dispose();
        assert.throws(() => retainOriginalCurrentSchemaCollectorInputs(root, { signal: controller.signal }), /fixture cancellation/);
    });
});

test('recycled writable descriptor refuses inspection instead of downgrading by reopening', nativeOptions, () =>
{
    withFixture(({ root, env }) =>
    {
        const owner = retainOriginalCurrentSchemaCollectorInputs(root);
        const files = inspectOriginalCurrentSchemaCollectorInputs(owner);
        fs.closeSync(files[0].descriptor);
        const replacement = fs.openSync(env, fs.constants.O_RDWR);
        try
        {
            assert.equal(replacement, files[0].descriptor);
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(owner), /read-only, non-O_PATH/);
            assert.throws(() => inspectOriginalCurrentSchemaCollectorInputs(owner), /actual open input custody/);
        }
        finally { owner.dispose(); }
    });
});

test('failed partial admission closes every retained ancestor and leaf descriptor', nativeOptions, () =>
{
    withFixture(({ root, receipt }) =>
    {
        fs.chmodSync(receipt, 0o644);
        const before = fs.readdirSync('/proc/self/fd').length;
        assert.throws(() => retainOriginalCurrentSchemaCollectorInputs(root));
        assert.equal(fs.readdirSync('/proc/self/fd').length, before);
    });
});
