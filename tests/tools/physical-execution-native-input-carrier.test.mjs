import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClosedNativeInputDirectory, inspectClosedNativeInputDirectory,
    closeClosedNativeInputDirectory, prepareRunOwnedDirectories, finalizeRunOwnedDirectories } from '../../tools/test/execution-envelope-directories.mjs';
import { beginOriginalNativeInputBrokerAttempt, createOriginalNativeInputCarrier, inspectOriginalNativeInputCarrier,
    nativeInputCarrierIsComplete } from '../../tools/test/physical-execution-native-input-carrier.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('JSON, copies and hostile records cannot import live transport authority or read input locators', async () =>
{
    for (const fake of [null, {}, Object.freeze({}), JSON.parse('{"reference":{}}'),
        new Proxy({}, { get() { throw new Error('must not inspect foreign authority fields'); } })])
    {
        assert.throws(() => inspectOriginalNativeInputCarrier(fake), /actual open in-process/u);
        assert.throws(() => beginOriginalNativeInputBrokerAttempt(fake), /actual open in-process/u);
        await assert.rejects(createOriginalNativeInputCarrier({ resourceBoundary: fake,
            resourceContext: null, originalNativeInputs: new Proxy({}, { get() { throw new Error('secret locator read'); } }) }),
        /original live resource-owner capability/u);
    }
    for (const value of [null, {}, { directory: { path: '/' } }, { schema: 'fsusblog.original-native-input-carrier.v1' }])
        assert.equal(nativeInputCarrierIsComplete(value), false);
});

test('the sole directory port consumes an actual privateTmp capability and pins its independent closed namespace', (context) =>
{
    const fixtureParent = path.join(root, '.tmp');
    fs.mkdirSync(fixtureParent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(fixtureParent, 'native-directory-control-'));
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const prepared = prepareRunOwnedDirectories({ repositoryRoot: fixture, cwd: fixture,
        runId: 'native-directory-control', producerId: 'ordinary-owned-directory', attemptId: 'attempt-1' });
    assert.throws(() => createClosedNativeInputDirectory({}), /original current-attempt directory capability/u);
    const capability = createClosedNativeInputDirectory(prepared.privateTmpCapability);
    const held = inspectClosedNativeInputDirectory(capability);
    assert.equal(path.dirname(held.reference.path), prepared.environment.TMPDIR);
    assert.equal(held.reference.guestSocketPath, `/tmp/${path.basename(held.reference.path)}/inputs.sock`);
    assert.ok(Buffer.byteLength(held.reference.guestSocketPath) <= 107);
    assert.ok(Object.isFrozen(held.reference.alias) && Object.isFrozen(held.reference.ancestors)
        && held.reference.ancestors.every(Object.isFrozen));
    assert.equal(fs.fstatSync(held.descriptor).ino, Number(held.reference.inode));
    assert.throws(() => inspectClosedNativeInputDirectory({ ...capability }), /actual open original owner/u);
    const foreign = path.join(held.reference.path, 'owner.sock');
    fs.writeFileSync(foreign, 'foreign carrier', { mode: 0o600 });
    assert.throws(() => closeClosedNativeInputDirectory(capability), /retains unremoved transport files/u);
    assert.ok(fs.existsSync(foreign));
    fs.unlinkSync(foreign);
    closeClosedNativeInputDirectory(capability);
    assert.throws(() => fs.fstatSync(held.descriptor), /EBADF/u);
    assert.throws(() => inspectClosedNativeInputDirectory(capability), /actual open original owner/u);
    assert.equal(finalizeRunOwnedDirectories(prepared).cleanup.status, 'complete');
});

test('deep valid original namespace may exceed startup data bound and remains explicitly closable without any resource grant', (context) =>
{
    const parent = path.join(root, '.tmp');
    fs.mkdirSync(parent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(parent, 'native-deep-control-'));
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const deep = path.join(fixture, ...Array.from({ length: 45 }, (_, index) => `owned${index}-${'x'.repeat(43)}`));
    fs.mkdirSync(deep, { recursive: true, mode: 0o700 });
    const prepared = prepareRunOwnedDirectories({ repositoryRoot: deep, cwd: deep,
        runId: 'run', producerId: 'ordinary-directory-only', attemptId: 'attempt-1' });
    const capability = createClosedNativeInputDirectory(prepared.privateTmpCapability);
    const held = inspectClosedNativeInputDirectory(capability);
    assert.ok(Buffer.byteLength(held.reference.path) < 4095);
    assert.ok(Buffer.byteLength(held.reference.guestSocketPath) <= 107);
    assert.ok(Buffer.byteLength(JSON.stringify({ directory: held.reference, files: [] })) > 65536);
    closeClosedNativeInputDirectory(capability);
    assert.throws(() => fs.fstatSync(held.descriptor), /EBADF/u);
    assert.ok(!fs.existsSync(held.reference.path));
    assert.equal(finalizeRunOwnedDirectories(prepared).cleanup.status, 'complete');
});
