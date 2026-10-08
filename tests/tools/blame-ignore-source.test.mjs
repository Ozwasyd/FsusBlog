import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const { validateBlameIgnoreSourceReceipt } = await import(new URL('../../tools/test-matrix/blame-ignore-source.mjs', import.meta.url));
const { unsupportedSourceStageFiles, sourceGovernanceChildEntries, sourceGovernanceExecutableEntries } =
    await import(new URL('../../tools/test-matrix/pr-impact-plan.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const checker = 'tools/test-matrix/blame-ignore-source.mjs';
const metadata = '.git-blame-ignore-revs';
const baseline = JSON.parse(execFileSync(process.execPath, [checker, '--root', path.resolve(repository),
    '--base', git(repository, ['rev-parse', 'HEAD']), '--head', git(repository, ['rev-parse', 'HEAD'])],
{ cwd: repository, encoding: 'utf8' }));
const originalText = fs.readFileSync(path.join(repository, metadata), 'utf8');

function git(root, args)
{
    return execFileSync('git', ['-C', root, '-c', 'user.name=Source metadata control',
        '-c', 'user.email=source-metadata-control@example.invalid', ...args], { encoding: 'utf8' }).trim();
}

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-blame-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, ['clone', '--quiet', '--shared', '--no-checkout', repository, '.']);
    git(root, ['read-tree', 'HEAD']);
    git(root, ['checkout', 'HEAD', '--', metadata, ...baseline.authority.map(value => value.path)]);
    fs.mkdirSync(path.dirname(path.join(root, checker)), { recursive: true });
    fs.copyFileSync(path.join(repository, checker), path.join(root, checker));
    return { root, base: baseline.head };
}

function commit(root, files, message = 'test(governance): exercise isolated metadata refusal\n\nRefs: #3659')
{
    git(root, ['add', '--', ...files]);
    git(root, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
    return git(root, ['rev-parse', 'HEAD']);
}

function run(value, { base = value.base, head = git(value.root, ['rev-parse', 'HEAD']) } = {})
{
    const result = spawnSync(process.execPath, [checker, '--root', value.root, '--base', base, '--head', head],
        { cwd: value.root, encoding: 'utf8' });
    return { ...result, receipt: result.stdout ? JSON.parse(result.stdout) : null };
}

function refusal(value, pattern)
{
    const result = run(value);
    assert.equal(result.status, 1);
    assert.match([result.stderr, ...(result.receipt?.errors ?? [])].join('\n'), pattern);
    assert.equal(result.receipt?.qualificationEligible ?? false, false);
}

test('ordinary metadata uses real original history and only a consumer-validated receipt admits the exact path', t =>
{
    const value = fixture(t);
    fs.appendFileSync(path.join(value.root, metadata), '\n# ordinary SOURCE metadata control\n');
    const head = commit(value.root, [metadata]);
    const result = run(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.receipt.qualificationEligible, false);
    assert.equal(result.receipt.authority.length, 10);
    assert.deepEqual(unsupportedSourceStageFiles([metadata], [], [], result.receipt), [metadata]);
    validateBlameIgnoreSourceReceipt({ repositoryRoot: value.root, trustedBaseCommit: value.base,
        expectedHead: head, receipt: result.receipt });
    assert.deepEqual(unsupportedSourceStageFiles([metadata, 'nested/.git-blame-ignore-revs', 'unknown.bin', 'build.csproj'],
        [], [], result.receipt), ['nested/.git-blame-ignore-revs', 'unknown.bin', 'build.csproj']);
    assert.deepEqual(unsupportedSourceStageFiles([metadata], [], [], structuredClone(result.receipt)), [metadata]);
    assert.deepEqual(unsupportedSourceStageFiles([metadata], [], [], true), [metadata]);
    assert.throws(() =>
    {
        result.receipt.metadata.path = 'nested/.git-blame-ignore-revs';
    }, TypeError);
    assert.throws(() =>
    {
        result.receipt.qualificationEligible = true;
    }, TypeError);
});

for (const [name, mutate, pattern] of [
    ['duplicate SHA', text => `${text}\n${baseline.metadata.headBlob}\n${baseline.metadata.headBlob}\n`, /duplicate/u],
    ['invalid uppercase SHA', text => `${text}\n${baseline.head.toUpperCase()}\n`, /full lowercase SHA/u],
    ['unknown SHA', text => `${text}\n${'0'.repeat(40)}\n`, /does not exist/u],
    ['removed mandatory legacy', () => '# removed mandatory historical registrations\n', /missing blame-ignore entry/u],
    ['non-style commit', text => `${text}\n${baseline.head}\n`, /must point to a style commit/u]
])
{
    test(`original repository owner refuses ${name}`, t =>
    {
        const value = fixture(t);
        fs.writeFileSync(path.join(value.root, metadata), mutate(originalText));
        commit(value.root, [metadata]);
        refusal(value, pattern);
    });
}

test('an existing style revision outside actual HEAD ancestry is refused', t =>
{
    const value = fixture(t);
    const tree = git(value.root, ['rev-parse', 'HEAD^{tree}']);
    const sibling = git(value.root, ['commit-tree', tree, '-p', value.base, '-m', 'style(governance): isolated unregistered control']);
    fs.appendFileSync(path.join(value.root, metadata), `\n${sibling}\n`);
    commit(value.root, [metadata]);
    refusal(value, /not reachable from HEAD/u);
});

for (const [name, parents] of [['root', []], ['merge', ['HEAD', 'HEAD~1']]])
{
    test(`original owner refuses a real ${name} commit`, t =>
    {
        const value = fixture(t);
        const tree = git(value.root, ['rev-parse', 'HEAD^{tree}']);
        const revision = git(value.root, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]),
            '-m', 'style(governance): isolated parent-count control']);
        fs.appendFileSync(path.join(value.root, metadata), `\n${revision}\n`);
        commit(value.root, [metadata]);
        refusal(value, /must not be a merge or root commit/u);
    });
}

test('a reachable style commit without the required format contract is refused', t =>
{
    const value = fixture(t);
    fs.appendFileSync(path.join(value.root, metadata), '\n# reachable control\n');
    const revision = commit(value.root, [metadata], 'style(governance): isolated absent contract control');
    fs.appendFileSync(path.join(value.root, metadata), `${revision}\n`);
    commit(value.root, [metadata]);
    refusal(value, /lacks a format-only commit contract/u);
});

for (const structural of [false, true])
{
    test(`original actual parent diff refuses ${structural ? 'structural' : 'token'} change despite format syntax`, t =>
    {
        const value = fixture(t);
        const file = structural ? 'src/backend/SourceMetadataNegativeControl.cs' : 'src/backend/Program.cs';
        fs.mkdirSync(path.dirname(path.join(value.root, file)), { recursive: true });
        const before = structural ? '' : git(value.root, ['show', `HEAD:${file}`]);
        fs.writeFileSync(path.join(value.root, file), `${before}\nint sourceMetadataNegativeControl = 1;\n`);
        // These fields test commit syntax only. No formatter or runtime receipt
        // is created, and complete qualification remains the original owner's gate.
        const revision = commit(value.root, [file], 'style(governance): isolated format refusal control\n\n'
            + 'Change-Class: format-only\nFormatter: unit-control@1.0 :: unit-control\n'
            + 'Idempotence-Evidence: unit-control-not-runtime.json\nRefs: #3659');
        fs.appendFileSync(path.join(value.root, metadata), `\n${revision}\n`);
        commit(value.root, [metadata]);
        refusal(value, structural ? /adds, copies, deletes, or renames/u : /changes non-whitespace/u);
    });
}

for (const [name, mutate, pattern] of [
    ['missing', (root, file) => fs.unlinkSync(file), /ENOENT/u],
    ['deleted from HEAD', (root, file) =>
    {
        fs.unlinkSync(file);
        commit(root, [metadata]);
    }, /ENOENT/u],
    ['dirty physical bytes', (root, file) => fs.appendFileSync(file, '\n# uncommitted\n'), /bytes disagree/u],
    ['index differs from HEAD', (root, file) =>
    {
        fs.appendFileSync(file, '\n# staged\n');
        git(root, ['add', metadata]);
    }, /bytes disagree/u],
    ['symlink', (root, file) =>
    {
        fs.renameSync(file, `${file}.target`);
        fs.symlinkSync(`${file}.target`, file);
    }, /ELOOP/u],
    ['hardlink', (root, file) => fs.linkSync(file, `${file}.alias`), /regular nonexecutable/u],
    ['executable', (root, file) => fs.chmodSync(file, 0o755), /regular nonexecutable/u],
    ['invalid UTF-8', (root, file) => fs.writeFileSync(file, Buffer.from([0xff])), /exact UTF-8/u],
    ['NUL', (root, file) => fs.appendFileSync(file, Buffer.from([0])), /exact UTF-8/u]
])
{
    test(`ordinary held metadata refuses ${name}`, t =>
    {
        const value = fixture(t);
        mutate(value.root, path.join(value.root, metadata));
        refusal(value, pattern);
    });
}

test('candidate replacement of original validator is refused before import', t =>
{
    const value = fixture(t);
    const file = 'tools/governance/change-contract.mjs';
    fs.appendFileSync(path.join(value.root, file), '\nthrow new Error("candidate owner must never execute");\n');
    commit(value.root, [file]);
    refusal(value, /cannot replace previous-trusted authority/u);
});

test('a HEAD executable mode cannot be hidden by restoring an ordinary index and physical mode', t =>
{
    const value = fixture(t);
    const file = path.join(value.root, metadata);
    fs.chmodSync(file, 0o755);
    commit(value.root, [metadata]);
    fs.chmodSync(file, 0o644);
    git(value.root, ['add', metadata]);
    refusal(value, /HEAD\/index\/physical bytes disagree/u);
});

test('receipt head, trusted base, content, closure, status and qualification forgeries refuse admission', t =>
{
    const value = fixture(t);
    const receipt = run(value).receipt;
    for (const mutate of [
        result =>
        {
            result.head = '0'.repeat(40);
        },
        result =>
        {
            result.trustedBase = '0'.repeat(40);
        },
        result =>
        {
            result.metadata.contentDigest = '0'.repeat(64);
        },
        result =>
        {
            result.metadata.path = 'nested/.git-blame-ignore-revs';
        },
        result =>
        {
            result.authority.pop();
        },
        result =>
        {
            result.status = 'failure';
        },
        result =>
        {
            result.qualificationEligible = true;
        },
        result =>
        {
            result.extra = true;
        }
    ])
    {
        const changed = structuredClone(receipt);
        mutate(changed);
        assert.throws(() => validateBlameIgnoreSourceReceipt({ repositoryRoot: value.root,
            trustedBaseCommit: value.base, expectedHead: value.base, receipt: changed }));
        assert.deepEqual(unsupportedSourceStageFiles([metadata], [], [], changed), [metadata]);
    }
    fs.appendFileSync(path.join(value.root, metadata), '\n# receipt replay after physical change\n');
    assert.throws(() => validateBlameIgnoreSourceReceipt({ repositoryRoot: value.root,
        trustedBaseCommit: value.base, expectedHead: value.base, receipt }), /bytes disagree/u);
});

test('only the fixed metadata checker and its refusal suite are registered execution ports', () =>
{
    assert.equal(sourceGovernanceChildEntries.blameIgnore, checker);
    assert.ok(sourceGovernanceExecutableEntries().includes('tests/tools/blame-ignore-source.test.mjs'));
    const source = fs.readFileSync(new URL('../../tools/test-matrix/source-governance.mjs', import.meta.url), 'utf8');
    assert.match(source, /evidence\.changedFiles\.includes\('\.git-blame-ignore-revs'\)/u);
});
