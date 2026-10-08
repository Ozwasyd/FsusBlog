/* eslint-disable import-x/no-relative-parent-imports -- Exercise the existing asset producer with independently pinned fixture bytes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import vm from 'node:vm';

import { createCurrentReleaseBrowserArtifacts, createReleaseBrowserTrustScript } from '../../tools/storage/release-browser-projection.mjs';

import { currentReleaseAssetsFixture } from './support/current-release-assets-fixture.mjs';

const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

test('prebuild trust is fixed public key material without candidate digests and cannot be replaced', context =>
{
    const data = currentReleaseAssetsFixture(context);
    const signing = data.options.manifest.identity.signing;
    const bytes = fs.readFileSync(signing.publicKey.reference);
    const script = createReleaseBrowserTrustScript(bytes, signing.keyId, signing.publicKey.sha256);
    const realm = vm.createContext({});
    vm.runInContext(script, realm);
    assert.equal(realm.FsusCurrentReleaseBrowserTrust.publicKeySha256, signing.publicKey.sha256);
    assert.equal(script.includes(data.options.manifest.candidateId), false);
    assert.equal(script.includes(data.options.manifest.contentDigest), false);
    assert.equal(script.includes('PRIVATE KEY'), false);
    assert.throws(() => vm.runInContext("'use strict'; FsusCurrentReleaseBrowserTrust.keyId = 'other';", realm), /read only/u);
    assert.throws(() => vm.runInContext("Object.defineProperty(globalThis, 'FsusCurrentReleaseBrowserTrust', { value: {} });", realm), /redefine/u);
    assert.throws(() => createReleaseBrowserTrustScript(bytes, signing.keyId, digest('wrong')), /pinned public/u);
});

test('postseal projection consumes exact inventoried prebuild trust and does not alter the sealed source', async context =>
{
    const data = currentReleaseAssetsFixture(context);
    const before = JSON.stringify(data.options.manifest);
    const result = createCurrentReleaseBrowserArtifacts(data.options, data.privateKey);
    const verified = await globalThis.FsusCurrentReleaseAssets.verifyProjection(result.projectionBytes, data.trust);
    assert.equal(verified.candidateId, data.options.manifest.candidateId);
    assert.equal(result.projectionSha256, digest(result.projectionBytes));
    assert.equal(JSON.stringify(data.options.manifest), before);
    assert.equal(result.runtimeQualificationEligible, false);
    assert.equal(data.inventory.files.some(file => file.path === 'release-browser-projection.json'), false);
});

test('coherently signed missing or changed prebuild consumers cannot produce a browser bootstrap', context =>
{
    for (const mutate of [source => fs.writeFileSync(path.join(source, 'generated/current-release-trust.js'), 'untrusted'),
        source => fs.rmSync(path.join(source, 'current-release-assets.js'))])
    {
        const data = currentReleaseAssetsFixture(context, mutate);
        assert.throws(() => createCurrentReleaseBrowserArtifacts(data.options, data.privateKey), /inventoried prebuild trust/u);
    }
});

test('actual artifact CLI pins source/key bytes, is append-only and grants no runtime admission', context =>
{
    const data = currentReleaseAssetsFixture(context);
    const manifestPath = path.join(data.root, 'operational-manifest.json');
    const manifestBytes = Buffer.from(JSON.stringify(data.options.manifest));
    fs.writeFileSync(manifestPath, manifestBytes);
    const keyPath = path.join(data.root, 'source-control-private.pem');
    const keyBytes = data.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(keyPath, keyBytes, { mode: 0o600 });
    const output = path.join(data.root, 'release-browser-projection.json');
    const arguments_ = ['tools/storage/create-release-browser-artifacts.mjs', '--mode', 'projection',
        '--release-manifest', manifestPath, '--release-manifest-sha256', digest(manifestBytes),
        '--trust-policy', data.options.trustPolicyReference, '--trust-policy-sha256', data.options.trustPolicySha256,
        '--signing-key', keyPath, '--signing-key-sha256', digest(keyBytes), '--out', output];
    const run = args => spawnSync(process.execPath, args, { encoding: 'utf8' });
    for (let attempt = 0; attempt < 2; attempt++)
    {
        const result = run(arguments_);
        assert.equal(result.status, 0, result.stdout || result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.runtimeQualificationEligible, false);
        assert.equal(report.candidateId, data.options.manifest.candidateId);
        assert.equal(report.sha256, digest(fs.readFileSync(output)));
    }
    const drifted = [...arguments_];
    drifted[drifted.indexOf('--signing-key-sha256') + 1] = digest('wrong');
    const before = fs.readFileSync(output);
    assert.equal(run(drifted).status, 1);
    assert.deepEqual(fs.readFileSync(output), before);
    fs.chmodSync(output, 0o600);
    fs.writeFileSync(output, 'existing unrelated bytes');
    assert.equal(run(arguments_).status, 1);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing unrelated bytes');
    const unrelated = path.join(data.root, 'unrelated.bin');
    fs.writeFileSync(unrelated, 'outside this artifact');
    fs.rmSync(output);
    fs.symlinkSync(unrelated, output);
    assert.equal(run(arguments_).status, 1);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'outside this artifact');
    const parentAlias = path.join(data.root, 'parent-alias');
    fs.symlinkSync(data.source, parentAlias);
    const aliased = [...arguments_];
    aliased[aliased.indexOf('--out') + 1] = path.join(parentAlias, 'must-not-exist.json');
    assert.equal(run(aliased).status, 1);
    assert.equal(fs.existsSync(path.join(data.source, 'must-not-exist.json')), false);
    const publicKey = data.options.manifest.identity.signing.publicKey;
    const trustOut = path.join(data.root, 'prebuild-trust.js');
    const trustRun = run(['tools/storage/create-release-browser-artifacts.mjs', '--mode', 'trust',
        '--public-key', publicKey.reference, '--public-key-sha256', publicKey.sha256,
        '--key-id', data.trust.keyId, '--out', trustOut]);
    assert.equal(trustRun.status, 0, trustRun.stdout || trustRun.stderr);
    assert.equal(digest(fs.readFileSync(trustOut)), data.inventory.files.find(file => file.path === 'generated/current-release-trust.js').sha256);
    assert.equal(run([...arguments_, '--mode', 'projection']).status, 1);
    assert.equal(run([...arguments_, '--__proto__', 'unknown']).status, 1);
});
