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

test('submodule nested checkout closure is refused instead of admitting only the outer pointer', (t) =>
{
    const f = fixture(t);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', f.target.root, 'nested']);
    execFileSync('git', ['-C', f.checkoutRoot, '-c', 'user.name=Candidate Test', '-c', 'user.email=candidate@example.invalid', 'commit', '-qam', 'nested checkout']);
    f.parent.git('add', 'component');
    f.parent.git('commit', '-qm', 'bind nested checkout');
    assert.throws(() => collectSubmoduleCheckoutIdentities(f.inputs()), /nested submodule checkout closure capability/u);
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
