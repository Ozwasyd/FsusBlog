import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { gitFixture, sourcePolicy } from './repository-source-snapshot-test-support.mjs';

const { collectSubmoduleCheckoutIdentities, verifySubmoduleCheckoutIdentities } = await import(new URL('../../tools/release-candidate/collect-source-aliases.mjs', import.meta.url));
const { snapshotRepositorySourceIdentity } = await import(new URL('../../tools/test/repository-source-snapshot.mjs', import.meta.url));

function fixture(t)
{
    const target = gitFixture(t);
    const parent = gitFixture(t);
    parent.git('commit', '--amend', '-qm', 'distinct parent repository root');
    parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', target.root, 'component');
    parent.git('commit', '-qm', 'declare actual component checkout');
    const checkoutRoot = path.join(parent.root, 'component');
    const inputs = () => ({ repositoryRoot: parent.root,
        parentSnapshot: snapshotRepositorySourceIdentity(parent.root, { sourcePolicy }),
        targetPolicies: { component: sourcePolicy } });
    return { parent, target, checkoutRoot, inputs };
}

test('submodule checkout follows actual declarations/index and verifies clean then content-level dirty state', (t) =>
{
    const f = fixture(t);
    const clean = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.equal(clean.checkouts.component.dirty, false);
    assert.equal(clean.checkouts.component.parentPointer, f.target.git('rev-parse', 'HEAD'));
    assert.equal(clean.checkouts.component.initialized, true);
    assert.equal(clean.checkouts.component.urlIdentityClass, 'local');
    assert.equal(verifySubmoduleCheckoutIdentities(clean, f.inputs()), clean);
    fs.writeFileSync(path.join(f.checkoutRoot, 'source.txt'), 'dirty first\n');
    const first = collectSubmoduleCheckoutIdentities(f.inputs());
    fs.writeFileSync(path.join(f.checkoutRoot, 'source.txt'), 'dirty other\n');
    const other = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.equal(first.checkouts.component.dirty, true);
    assert.equal(other.checkouts.component.dirty, true);
    assert.notEqual(first.contentDigest, other.contentDigest);
    assert.throws(() => verifySubmoduleCheckoutIdentities(first, f.inputs()), /mismatch/u);
});

test('submodule same source checkout at different physical roots has the same semantic receipt', (t) =>
{
    const f = fixture(t);
    const clone = path.join(f.target.root, '..', `${path.basename(f.target.root)}-parent-clone`);
    t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
    execFileSync('git', ['clone', '--local', '-q', f.parent.root, clone]);
    execFileSync('git', ['-C', clone, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet']);
    const clonedInputs = { ...f.inputs(), repositoryRoot: clone,
        parentSnapshot: snapshotRepositorySourceIdentity(clone, { sourcePolicy }) };
    assert.deepEqual(collectSubmoduleCheckoutIdentities(clonedInputs), collectSubmoduleCheckoutIdentities(f.inputs()));
});

test('submodule pointer/check-out mismatch fails closed', (t) =>
{
    const f = fixture(t);
    execFileSync('git', ['-C', f.checkoutRoot, 'config', 'user.name', 'Candidate Test']);
    execFileSync('git', ['-C', f.checkoutRoot, 'config', 'user.email', 'candidate@example.invalid']);
    fs.writeFileSync(path.join(f.checkoutRoot, 'source.txt'), 'new checkout commit\n');
    execFileSync('git', ['-C', f.checkoutRoot, 'commit', '-qam', 'different checkout head']);
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /pointer\/checkout HEAD mismatch/u);
});

test('submodule uninitialized checkout cannot resolve to the parent repository', (t) =>
{
    const f = fixture(t);
    fs.rmSync(f.checkoutRoot, { recursive: true, force: true });
    fs.mkdirSync(f.checkoutRoot);
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /explicit physical repository root/u);
});

test('submodule symlink checkout escapes and declaration path escapes are rejected', (t) =>
{
    const f = fixture(t);
    fs.rmSync(f.checkoutRoot, { recursive: true, force: true });
    fs.symlinkSync(f.target.root, f.checkoutRoot);
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /physical directory/u);
    f.parent.write('.gitmodules', '[submodule "component"]\npath = ../component\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /canonical\/contained/u);
});

test('submodule declarations, policies and parent source have exact closure', (t) =>
{
    const f = fixture(t);
    const inputs = f.inputs();
    assert.throws(() => collectSubmoduleCheckoutIdentities({ ...inputs, targetPolicies: {} }), /exactly cover/u);
    assert.throws(() => collectSubmoduleCheckoutIdentities({ ...inputs, targetPolicies: { ...inputs.targetPolicies, sibling: sourcePolicy } }), /exactly cover/u);
    f.parent.write('source.txt', 'changed parent bytes\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /stale\/cross-source/u);
    f.parent.write('.gitmodules', '[submodule "component"]\npath = component\npath = other\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /duplicate submodule declaration/u);
    f.parent.write('.gitmodules', '[submodule "orphan"]\npath = other\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /exact closure/u);
});

test('submodule collector and independent verifier leave current inputs/index/ref state unchanged', (t) =>
{
    const f = fixture(t);
    const inputs = f.inputs();
    const before = fs.statSync(path.join(f.parent.root, '.git', 'index'), { bigint: true });
    const targetBefore = snapshotRepositorySourceIdentity(f.checkoutRoot, { sourcePolicy });
    const receipt = collectSubmoduleCheckoutIdentities(inputs);
    verifySubmoduleCheckoutIdentities(receipt, inputs);
    const after = fs.statSync(path.join(f.parent.root, '.git', 'index'), { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    assert.deepEqual(snapshotRepositorySourceIdentity(f.parent.root, { sourcePolicy }), inputs.parentSnapshot);
    assert.deepEqual(snapshotRepositorySourceIdentity(f.checkoutRoot, { sourcePolicy }), targetBefore);
    assert.equal(JSON.stringify(receipt).includes('artifact'), false);
    assert.equal(JSON.stringify(receipt).includes('imageDigest'), false);
    assert.throws(() => verifySubmoduleCheckoutIdentities({ ...receipt, status: 'unverified' }, inputs), /mismatch/u);
});

test('submodule empty declarations verify without discovering an undeclared sibling repository', (t) =>
{
    gitFixture(t);
    const parent = gitFixture(t);
    const receipt = collectSubmoduleCheckoutIdentities({ repositoryRoot: parent.root,
        parentSnapshot: snapshotRepositorySourceIdentity(parent.root, { sourcePolicy }), targetPolicies: {} });
    assert.deepEqual(receipt.checkouts, {});
});

test('submodule nested checkout closure requires explicit policies instead of admitting only the outer pointer', (t) =>
{
    const f = fixture(t);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.target.root, 'nested']);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'nested checkout']);
    f.parent.git('add', 'component');
    f.parent.git('commit', '-qm', 'bind nested checkout');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /exactly cover/u);
});

function nestedFixture(t, depth = 2)
{
    let parent = gitFixture(t);
    parent.git('commit', '--amend', '-qm', 'distinct leaf repository root');
    for (let level = 0; level < depth; level += 1)
    {
        const outer = gitFixture(t);
        outer.git('commit', '--amend', '-qm', `distinct repository root ${level}`);
        outer.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', parent.root, 'component');
        outer.git('commit', '-qm', 'declare nested component checkout');
        parent = outer;
    }
    parent.git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet');
    const paths = Array.from({ length: depth }, (_, index) => Array(index + 1).fill('component').join('/'));
    const inputs = () => ({ repositoryRoot: parent.root,
        parentSnapshot: snapshotRepositorySourceIdentity(parent.root, { sourcePolicy }),
        targetPolicies: Object.fromEntries(paths.map((relative) => [relative, sourcePolicy])) });
    const git = (relative, ...args) => execFileSync('git', ['-C', path.join(parent.root, relative), ...args], { encoding: 'utf8' }).trim();
    return { parent, paths, inputs, git, leafRoot: path.join(parent.root, paths.at(-1)) };
}

test('submodule recursive closure binds every checkout and propagates dirty descendant contents', (t) =>
{
    const f = nestedFixture(t, 3);
    const clean = collectSubmoduleCheckoutIdentities(f.inputs());
    let entry = clean.checkouts.component;
    for (const relative of f.paths)
    {
        const snapshot = snapshotRepositorySourceIdentity(path.join(f.parent.root, relative), { sourcePolicy });
        assert.equal(entry.checkoutCommit, f.git(relative, 'rev-parse', 'HEAD'));
        assert.equal(entry.repositoryIdentityDigest, snapshot.repositoryIdentityDigest);
        assert.equal(entry.worktreeFingerprint, snapshot.snapshotDigest);
        assert.equal(entry.dirty, false);
        entry = entry.checkouts?.component;
    }
    assert.equal(entry, undefined);
    assert.equal(verifySubmoduleCheckoutIdentities(clean, f.inputs()), clean);
    fs.writeFileSync(path.join(f.leafRoot, 'source.txt'), 'first nested dirty bytes\n');
    const first = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.equal(first.checkouts.component.dirty, true);
    assert.equal(first.checkouts.component.checkouts.component.dirty, true);
    assert.equal(first.checkouts.component.checkouts.component.checkouts.component.dirty, true);
    fs.writeFileSync(path.join(f.leafRoot, 'source.txt'), 'other nested dirty bytes\n');
    assert.notEqual(collectSubmoduleCheckoutIdentities(f.inputs()).contentDigest, first.contentDigest);
    assert.throws(() => verifySubmoduleCheckoutIdentities(first, f.inputs()), /mismatch/u);
});

test('submodule recursive receipts are stable across physical clones and retain leaf fields', (t) =>
{
    const f = nestedFixture(t);
    const clone = gitFixture(t);
    clone.git('fetch', '-q', f.parent.root, 'HEAD');
    clone.git('reset', '--hard', 'FETCH_HEAD');
    clone.git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet');
    const receipt = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.deepEqual(collectSubmoduleCheckoutIdentities({ ...f.inputs(), repositoryRoot: clone.root,
        parentSnapshot: snapshotRepositorySourceIdentity(clone.root, { sourcePolicy }) }), receipt);
    assert.deepEqual(Object.keys(receipt.checkouts.component.checkouts.component).sort(),
        ['checkoutCommit', 'dirty', 'initialized', 'parentPointer', 'path', 'repositoryIdentityDigest',
            'sourcePolicyDigest', 'urlIdentityClass', 'worktreeFingerprint'].sort());
    const before = f.inputs();
    const snapshots = f.paths.map((relative) => snapshotRepositorySourceIdentity(path.join(f.parent.root, relative), { sourcePolicy }));
    const indexes = [''].concat(f.paths).map((relative) => f.git(relative, 'rev-parse', '--path-format=absolute', '--git-path', 'index'));
    const stats = indexes.map((index) => fs.statSync(index, { bigint: true }));
    verifySubmoduleCheckoutIdentities(receipt, f.inputs());
    assert.deepEqual(f.inputs(), before);
    assert.deepEqual(f.paths.map((relative) => snapshotRepositorySourceIdentity(path.join(f.parent.root, relative), { sourcePolicy })), snapshots);
    indexes.forEach((index, position) =>
    {
        const after = fs.statSync(index, { bigint: true });
        assert.equal(after.mtimeNs, stats[position].mtimeNs);
        assert.equal(after.ctimeNs, stats[position].ctimeNs);
    });
});

test('submodule recursive policies have exact closure and current policy identity', (t) =>
{
    const f = nestedFixture(t);
    const inputs = f.inputs();
    const receipt = collectSubmoduleCheckoutIdentities(inputs);
    delete inputs.targetPolicies[f.paths[1]];
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /exactly cover/u);
    const extra = f.inputs();
    extra.targetPolicies['component/undeclared'] = sourcePolicy;
    assert.throws(() => collectSubmoduleCheckoutIdentities(extra), /exactly cover/u);
    extra.targetPolicies = { ...f.inputs().targetPolicies, '../outside': sourcePolicy };
    assert.throws(() => collectSubmoduleCheckoutIdentities(extra), /canonical\/contained/u);
    const changed = f.inputs();
    changed.targetPolicies[f.paths[1]] = { ...sourcePolicy, untracked: 'reject' };
    assert.throws(() => verifySubmoduleCheckoutIdentities(receipt, changed), /mismatch/u);
    assert.throws(() => verifySubmoduleCheckoutIdentities({ ...receipt, checkouts: {
        component: { ...receipt.checkouts.component, checkouts: {} }
    } }, f.inputs()), /mismatch/u);
});

test('submodule nested checkout mismatched HEAD and missing checkout fail closed', (t) =>
{
    const f = nestedFixture(t);
    fs.writeFileSync(path.join(f.leafRoot, 'source.txt'), 'other nested commit\n');
    f.git(f.paths[1], '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'other nested HEAD');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /pointer\/checkout HEAD mismatch/u);
    fs.rmSync(f.leafRoot, { recursive: true, force: true });
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /ENOENT/u);
    fs.mkdirSync(f.leafRoot);
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /explicit physical repository root/u);
});

test('submodule recursive declaration/index closure and path containment are checked at each level', (t) =>
{
    const f = nestedFixture(t);
    const moduleFile = path.join(f.parent.root, 'component', '.gitmodules');
    const original = fs.readFileSync(moduleFile);
    fs.writeFileSync(moduleFile, '[submodule "component"]\npath = ../component\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /canonical\/contained/u);
    fs.writeFileSync(moduleFile, '[submodule "component"]\npath = component\npath = other\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /duplicate submodule declaration/u);
    fs.writeFileSync(moduleFile, '[submodule "orphan"]\npath = other\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /exact closure/u);
    fs.writeFileSync(moduleFile, original);
    f.git(f.paths[0], 'rm', '--cached', '.gitmodules');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /tracked regular source input/u);
    f.git(f.paths[0], 'reset', '-q', 'HEAD', '--', '.gitmodules');
    fs.rmSync(f.leafRoot, { recursive: true, force: true });
    fs.symlinkSync(f.parent.root, f.leafRoot);
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /physical directory/u);
});

test('submodule ancestor repository identity cycles fail even at different commits', (t) =>
{
    const f = fixture(t);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.target.root, 'nested']);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'nested checkout']);
    f.parent.git('add', 'component');
    f.parent.git('commit', '-qm', 'bind cyclic identity');
    const inputs = f.inputs();
    inputs.targetPolicies['component/nested'] = sourcePolicy;
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /repository identity cycle/u);
});

test('submodule repeated repository identity in sibling branches is allowed', (t) =>
{
    const f = fixture(t);
    f.parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.target.root, 'other');
    f.parent.git('commit', '-qm', 'declare sibling checkout');
    const inputs = f.inputs();
    inputs.targetPolicies.other = sourcePolicy;
    const receipt = collectSubmoduleCheckoutIdentities(inputs);
    assert.equal(receipt.checkouts.component.repositoryIdentityDigest, receipt.checkouts.other.repositoryIdentityDigest);
});

test('submodule maximum depth admits sixteen checkout edges and refuses the seventeenth', (t) =>
{
    const f = nestedFixture(t, 17);
    const inputs = f.inputs();
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /maximum depth/u);
    const root = path.join(f.parent.root, 'component');
    const receipt = collectSubmoduleCheckoutIdentities({ repositoryRoot: root,
        parentSnapshot: snapshotRepositorySourceIdentity(root, { sourcePolicy }),
        targetPolicies: Object.fromEntries(f.paths.slice(1).map((relative) => [relative.slice('component/'.length), sourcePolicy])) });
    let entry = receipt.checkouts.component;
    let depth = 0;
    while (entry)
    {
        depth += 1;
        entry = entry.checkouts?.component;
    }
    assert.equal(depth, 16);
});

test('submodule collection reobserves all nested targets after later checkout observation', (t) =>
{
    const f = nestedFixture(t);
    f.parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.leafRoot, 'later');
    f.parent.git('commit', '-qm', 'declare later sibling');
    const inputs = f.inputs();
    Object.defineProperty(inputs.targetPolicies, 'later', { enumerable: true, get()
    {
        fs.writeFileSync(path.join(f.leafRoot, 'source.txt'), 'changed after nested snapshot\n');
        return sourcePolicy;
    } });
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /checkout changed during collection/u);
});

test('submodule staged nested pointers remain dirty despite configured submodule ignore', (t) =>
{
    const f = nestedFixture(t);
    f.git('component', 'config', '--file', '.gitmodules', 'submodule.component.ignore', 'all');
    f.git('component', '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'declare ignore setting');
    f.parent.git('add', 'component');
    f.parent.git('commit', '-qm', 'bind ignore declaration');
    fs.writeFileSync(path.join(f.leafRoot, 'source.txt'), 'new staged nested pointer\n');
    f.git(f.paths[1], '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'new nested commit');
    f.git('component', 'update-index', '--cacheinfo', `160000,${f.git(f.paths[1], 'rev-parse', 'HEAD')},component`);
    const receipt = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.equal(receipt.checkouts.component.dirty, true);
    assert.equal(receipt.checkouts.component.checkouts.component.dirty, false);
});

test('submodule recursive collection rechecks physical containment after observation', (t) =>
{
    const f = nestedFixture(t);
    f.parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.leafRoot, 'later');
    f.parent.git('commit', '-qm', 'declare later checkout');
    const inputs = f.inputs();
    Object.defineProperty(inputs.targetPolicies, 'later', { enumerable: true, get()
    {
        const outer = path.join(f.parent.root, 'component');
        const moved = path.join(f.parent.root, 'moved-component');
        fs.renameSync(outer, moved);
        fs.symlinkSync(moved, outer);
        return sourcePolicy;
    } });
    assert.throws(() => collectSubmoduleCheckoutIdentities(inputs), /physical directory/u);
});

test('submodule nested untracked inputs and declaration changes invalidate old receipts', (t) =>
{
    const f = nestedFixture(t);
    const receipt = collectSubmoduleCheckoutIdentities(f.inputs());
    fs.writeFileSync(path.join(f.leafRoot, 'new-source.txt'), 'untracked nested source\n');
    const untracked = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.equal(untracked.checkouts.component.dirty, true);
    assert.equal(untracked.checkouts.component.checkouts.component.dirty, true);
    assert.notEqual(untracked.contentDigest, receipt.contentDigest);
    assert.throws(() => verifySubmoduleCheckoutIdentities(receipt, f.inputs()), /mismatch/u);
    fs.rmSync(path.join(f.leafRoot, 'new-source.txt'));
    f.git('component', 'config', '--file', '.gitmodules', 'submodule.component.url', '../another-declared-url');
    const changed = collectSubmoduleCheckoutIdentities(f.inputs());
    assert.notEqual(changed.checkouts.component.declarationDigest, receipt.checkouts.component.declarationDigest);
    assert.throws(() => verifySubmoduleCheckoutIdentities(receipt, f.inputs()), /mismatch/u);
});

test('submodule untracked declaration cannot introduce a checkout authority', (t) =>
{
    const parent = gitFixture(t);
    parent.write('.gitmodules', '[submodule "component"]\npath = component\nurl = ../component\n');
    assert.throws(() => collectSubmoduleCheckoutIdentities({ repositoryRoot: parent.root,
        parentSnapshot: snapshotRepositorySourceIdentity(parent.root, { sourcePolicy }), targetPolicies: {} }), /tracked regular source input/u);
});

test('submodule dirty observation never invokes configured external diff text conversion or fsmonitor', (t) =>
{
    const f = fixture(t);
    execFileSync('git', ['-C', f.checkoutRoot, 'config', 'diff.external', '/does-not-exist-candidate-external-diff']);
    fs.writeFileSync(path.join(f.checkoutRoot, 'source.txt'), 'staged bytes\n');
    execFileSync('git', ['-C', f.checkoutRoot, 'add', 'source.txt']);
    const gitDir = execFileSync('git', ['-C', f.checkoutRoot, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
    const hook = path.join(gitDir, 'candidate-fsmonitor.sh');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf observed > "$0.observed"\nprintf "candidate-token\\0"\n', { mode: 0o755 });
    execFileSync('git', ['-C', f.checkoutRoot, 'config', 'core.fsmonitor', hook]);
    execFileSync('git', ['-C', f.checkoutRoot, 'ls-files']);
    assert.equal(fs.existsSync(`${hook}.observed`), true);
    fs.rmSync(`${hook}.observed`);
    assert.equal(collectSubmoduleCheckoutIdentities(f.inputs()).checkouts.component.dirty, true);
    assert.equal(fs.existsSync(`${hook}.observed`), false);
});
