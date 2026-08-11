import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
    createArtifactDigestTable,
    readAndValidateArtifactDigestTable,
    validateArtifactRefs
} from '../../tools/test-matrix/artifact-digest-table.mjs';
import { digestDeclaredOutputs } from '../../tools/test-matrix/local-profile.mjs';

const execFileAsync = promisify(execFile);
const moduleFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/test-matrix/artifact-digest-table.mjs');

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-artifact-table-'));
    const file = path.join(root, '.tmp/build/run/generated/artifact-digest-table.json');
    const sourceState = { commit: 'abc123', worktreeFingerprint: 'fingerprint-1' };
    const table = createArtifactDigestTable({ root, file, runId: 'run', sourceState });
    return { root, file, sourceState, table };
}

function write(root, relativePath, content)
{
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function advanceMtime(file)
{
    const timestamp = new Date(fs.statSync(file).mtimeMs + 2_000);
    fs.utimesSync(file, timestamp, timestamp);
}

test('same physical file is content-hashed once and retains every producer', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    write(value.root, '.tmp/results/summary.json', '{"ok":true}\n');

    const first = value.table.digestDeclarations(['.tmp/results/summary.json'], {
        producer: { bundle: 'backend-tests', step: 'backend-unit' }
    });
    const second = value.table.digestDeclarations(['.tmp/results/summary.json'], {
        producer: { bundle: 'backend-tests', step: 'backend-fast' }
    });
    assert.deepEqual(second.digests, first.digests);
    assert.deepEqual(second.refs, first.refs);
    assert.equal(first.digests['.tmp/results/summary.json'], digestDeclaredOutputs(
        value.root, ['.tmp/results/summary.json'])['.tmp/results/summary.json']);

    const persisted = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    const record = persisted.artifacts[first.refs['.tmp/results/summary.json']];
    assert.deepEqual(record.producers, ['backend-tests/backend-fast', 'backend-tests/backend-unit']);
    assert.equal(persisted.metrics.fileReadBytes, fs.statSync(path.join(value.root, '.tmp/results/summary.json')).size);
    assert.ok(persisted.metrics.cacheHits >= 1);
});

test('hard-link aliases share one physical content read', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const first = write(value.root, '.tmp/results/first.bin', 'hard-linked');
    const second = path.join(value.root, '.tmp/results/second.bin');
    fs.linkSync(first, second);
    value.table.digestDeclarations(['.tmp/results/first.bin', '.tmp/results/second.bin']);
    const table = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    assert.equal(table.metrics.fileReadBytes, Buffer.byteLength('hard-linked'));
});

test('concurrent bundle writers merge atomically without duplicate content reads', async (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const artifactPath = '.tmp/results/shared.bin';
    write(value.root, artifactPath, 'shared-content');
    const script = `
    import { createArtifactDigestTable } from ${JSON.stringify(pathToFileURL(moduleFile).href)};
    const [root, file, producer] = process.argv.slice(1);
    createArtifactDigestTable({
      root,
      file,
      runId: 'run',
      sourceState: { commit: 'abc123', worktreeFingerprint: 'fingerprint-1' }
    }).digestDeclarations([${JSON.stringify(artifactPath)}], {
      producer: { bundle: producer, step: 'shared' }
    });
  `;
    await Promise.all(Array.from({ length: 6 }, (_, index) => execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', script, value.root, value.file, `bundle-${index}`]
    )));
    const table = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    const record = Object.values(table.artifacts)[0];
    assert.equal(record.producers.length, 6);
    assert.equal(table.metrics.fileReadBytes, Buffer.byteLength('shared-content'));
});

test('wildcards sharing one root reuse a deterministic directory walk', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    write(value.root, '.tmp/results/a/summary.json', 'a');
    write(value.root, '.tmp/results/b/summary.json', 'b');

    const first = value.table.digestDeclarations(['.tmp/results/**/*.json'], {
        producer: { bundle: 'backend-tests', step: 'union' }
    });
    const second = value.table.digestDeclarations(['.tmp/results/**/summary.*'], {
        producer: { bundle: 'backend-tests', step: 'projection' }
    });
    const directory = value.table.digestDeclarations(['.tmp/results'], {
        producer: { bundle: 'backend-tests', step: 'directory-proof' }
    });
    assert.equal(first.digests['.tmp/results/**/*.json'], digestDeclaredOutputs(
        value.root, ['.tmp/results/**/*.json'])['.tmp/results/**/*.json']);
    assert.equal(second.digests['.tmp/results/**/summary.*'], digestDeclaredOutputs(
        value.root, ['.tmp/results/**/summary.*'])['.tmp/results/**/summary.*']);
    assert.equal(directory.digests['.tmp/results'], digestDeclaredOutputs(
        value.root, ['.tmp/results'])['.tmp/results']);
    const persisted = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    assert.equal(persisted.metrics.directoryWalks, 1);
});

test('in-place overwrite, truncate and rename replacement invalidate cached content', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const file = write(value.root, '.tmp/results/value.bin', 'aaaa');
    const digest = () => value.table.digestDeclarations(['.tmp/results/value.bin'], {
        producer: { bundle: 'backend-tests', step: 'mutation-check' }
    }).digests['.tmp/results/value.bin'];

    const initial = digest();
    fs.writeFileSync(file, 'bbbb');
    advanceMtime(file);
    const overwritten = digest();
    fs.truncateSync(file, 2);
    advanceMtime(file);
    const truncated = digest();
    const replacement = write(value.root, '.tmp/results/replacement.bin', 'cc');
    fs.renameSync(replacement, file);
    advanceMtime(file);
    const renamed = digest();
    assert.equal(new Set([initial, overwritten, truncated, renamed]).size, 4);
});

test('symlink replacement changes the digest and an outside target is rejected', (t) =>
{
    const value = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-artifact-outside-'));
    t.after(() =>
    {
        fs.rmSync(value.root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    const firstTarget = write(value.root, '.tmp/results/first.txt', 'one');
    const secondTarget = write(value.root, '.tmp/results/second.txt', 'two');
    const link = path.join(value.root, '.tmp/results/current.txt');
    fs.symlinkSync(path.basename(firstTarget), link);
    const first = value.table.digestDeclarations(['.tmp/results/current.txt']).digests['.tmp/results/current.txt'];
    fs.unlinkSync(link);
    fs.symlinkSync(path.basename(secondTarget), link);
    const second = value.table.digestDeclarations(['.tmp/results/current.txt']).digests['.tmp/results/current.txt'];
    assert.notEqual(first, second);

    fs.unlinkSync(link);
    const escapedTarget = path.join(outside, 'escaped.txt');
    fs.writeFileSync(escapedTarget, 'escaped');
    fs.symlinkSync(escapedTarget, link);
    assert.throws(() => value.table.digestDeclarations(['.tmp/results/current.txt']), /outside the repository/u);
});

test('substitution records bind canonical path to every physical proof ref', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    write(value.root, '.tmp/results/a.trx', 'trx');
    write(value.root, '.tmp/results/coverage.json', 'coverage');
    const physical = value.table.digestDeclarations([
        '.tmp/results/a.trx',
        '.tmp/results/coverage.json'
    ], { producer: { bundle: 'backend-tests', step: 'union' } });
    const substitution = value.table.registerSubstitution(
        '.tmp/canonical/summary.json',
        physical.digests,
        physical.refs,
        { producer: { bundle: 'backend-tests', step: 'projection' } }
    );
    const table = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    const record = table.artifacts[substitution.artifactId];
    assert.deepEqual(record.actualArtifactRefs, physical.refs);
    assert.equal(record.digest, substitution.digest);
    validateArtifactRefs(
        { ...physical.digests, '.tmp/canonical/summary.json': substitution.digest },
        { ...physical.refs, '.tmp/canonical/summary.json': substitution.artifactId },
        table
    );
    assert.throws(() => validateArtifactRefs(
        { '.tmp/canonical/summary.json': substitution.digest },
        { '.tmp/canonical/summary.json': substitution.artifactId },
        table
    ), /substitution actual ref mismatch/u);
    assert.throws(() => value.table.registerSubstitution(
        '.tmp/canonical/summary.json',
        physical.digests,
        { ...physical.refs, '.tmp/results/unbound.json': Object.values(physical.refs)[0] }
    ), /requires physical refs/u);
    assert.throws(() => value.table.registerSubstitution(
        '.tmp/canonical/summary.json',
        { '.tmp/results/unbound.json': Object.values(physical.digests)[0] },
        { '.tmp/results/unbound.json': Object.values(physical.refs)[0] }
    ), /does not match path/u);
    assert.throws(() => value.table.registerSubstitution(
        '.tmp/canonical/summary.json',
        { '../escaped.json': Object.values(physical.digests)[0] },
        { '../escaped.json': Object.values(physical.refs)[0] }
    ), /path is invalid/u);
});

test('final table is source-bound, self-verifying and rejects corruption', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    write(value.root, '.tmp/results/summary.json', 'ok');
    value.table.digestDeclarations(['.tmp/results/summary.json']);
    const snapshot = path.join(value.root, '.tmp/release-evidence/artifact-digest-table.json');
    value.table.registerConsumers({
        'backend-unit': { summary: Object.values(JSON.parse(fs.readFileSync(value.file, 'utf8')).artifacts)[0].artifactId },
        'backend-fast': { summary: Object.values(JSON.parse(fs.readFileSync(value.file, 'utf8')).artifacts)[0].artifactId }
    });
    const descriptor = value.table.finalize(snapshot);
    const table = readAndValidateArtifactDigestTable(snapshot, {
        root: value.root,
        runId: 'run',
        sourceState: value.sourceState,
        expectedContentDigest: descriptor.contentDigest
    });
    assert.equal(table.status, 'final');
    assert.equal(descriptor.comparison.logicalReadCount, 2);
    assert.ok(descriptor.comparison.beforeEstimated.fileReadBytes >= descriptor.comparison.afterMeasured.fileReadBytes);
    assert.throws(() => readAndValidateArtifactDigestTable(snapshot, {
        root: value.root,
        runId: 'other-run',
        sourceState: value.sourceState
    }), /run ID mismatch/u);

    table.metrics.shaCalls += 1;
    fs.writeFileSync(snapshot, `${JSON.stringify(table, null, 2)}\n`);
    assert.throws(() => readAndValidateArtifactDigestTable(snapshot, {
        root: value.root,
        runId: 'run',
        sourceState: value.sourceState
    }), /content digest mismatch/u);
});

test('finalization rejects content or directory membership changed after its last digest', (t) =>
{
    for (const mode of ['content', 'directory'])
    {
        const value = fixture();
        t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
        const artifact = write(value.root, '.tmp/results/a.json', 'a');
        value.table.digestDeclarations([mode === 'content' ? '.tmp/results/a.json' : '.tmp/results/**/*.json']);
        if (mode === 'content')
        {
            write(value.root, '.tmp/results/a.json', 'b');
            advanceMtime(artifact);
        }
        else
        {
            write(value.root, '.tmp/results/b.json', 'b');
        }
        assert.throws(() => value.table.finalize(), /changed after its final digest/u);
    }

    const finalized = fixture();
    t.after(() => fs.rmSync(finalized.root, { recursive: true, force: true }));
    write(finalized.root, '.tmp/results/a.json', 'a');
    finalized.table.digestDeclarations(['.tmp/results/a.json']);
    const snapshot = path.join(finalized.root, '.tmp/release-evidence/table.json');
    const descriptor = finalized.table.finalize(snapshot);
    write(finalized.root, '.tmp/results/a.json', 'b');
    advanceMtime(path.join(finalized.root, '.tmp/results/a.json'));
    assert.throws(() => readAndValidateArtifactDigestTable(snapshot, {
        root: finalized.root,
        runId: 'run',
        sourceState: finalized.sourceState,
        expectedContentDigest: descriptor.contentDigest
    }), /changed after its final digest/u);
});

test('wildcard finalization ignores unrelated new files but rejects a new match', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    write(value.root, '.tmp/results/a.json', 'a');
    value.table.digestDeclarations(['.tmp/results/**/*.json']);
    write(value.root, '.tmp/results/notes.txt', 'unrelated');
    const descriptor = value.table.finalize();
    assert.match(descriptor.contentDigest, /^sha256:/u);
    assert.ok(descriptor.metrics.directoryWalks >= 2, 'finalization must rescan wildcard membership');

    const changed = fixture();
    t.after(() => fs.rmSync(changed.root, { recursive: true, force: true }));
    write(changed.root, '.tmp/results/a.json', 'a');
    changed.table.digestDeclarations(['.tmp/results/**/*.json']);
    write(changed.root, '.tmp/results/b.json', 'new match');
    assert.throws(() => changed.table.finalize(), /directory changed after its final digest/u);
});

test('missing, empty wildcard and traversal declarations still fail closed', (t) =>
{
    const value = fixture();
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(value.root, '.tmp/results'), { recursive: true });
    assert.throws(() => value.table.digestDeclarations(['.tmp/results/missing.json']), /missing/u);
    assert.throws(() => value.table.digestDeclarations(['.tmp/results/**/*.json']), /missing/u);
    assert.throws(() => value.table.digestDeclarations(['../escaped.json']), /invalid/u);
});

test('table file and parent symlink escapes are rejected', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-artifact-table-path-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-artifact-table-path-outside-'));
    t.after(() =>
    {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    write(root, '.tmp/results/value.txt', 'value');
    const identity = {
        root,
        runId: 'run',
        sourceState: { commit: 'abc123', worktreeFingerprint: 'fingerprint-1' }
    };
    const file = path.join(root, '.tmp/direct-table.json');
    fs.symlinkSync(path.join(outside, 'table.json'), file);
    assert.throws(() => createArtifactDigestTable({ ...identity, file })
        .digestDeclarations(['.tmp/results/value.txt']), /cannot be a symlink/u);

    const parent = path.join(root, '.tmp/escaped-parent');
    fs.symlinkSync(outside, parent);
    assert.throws(() => createArtifactDigestTable({ ...identity, file: path.join(parent, 'table.json') })
        .digestDeclarations(['.tmp/results/value.txt']), /parent resolves outside/u);
});
