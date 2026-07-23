import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/* eslint-disable import-x/no-relative-parent-imports */
import { requirePublicPreviewReleaseEvidence } from '../../tools/release/public-preview-release-evidence.mjs';
/* eslint-enable import-x/no-relative-parent-imports */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = path.join(root, 'tools/docs/public-preview-screenshots.mjs');
const sourceDirectory = path.join(root, 'docs/assets/screenshots');

test('verification evidence is deterministic and excludes local or runtime-noise identities', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-gallery-'));
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-public-preview-evidence-'));
    const evidence = path.join(evidenceRoot, 'verification.json');
    fs.cpSync(sourceDirectory, directory, { recursive: true });
    try
    {
        const run = () => spawnSync(process.execPath, [tool, 'compare', '--dir', directory, '--evidence', evidence], {
            cwd: root,
            encoding: 'utf8'
        });
        run();
        const first = fs.readFileSync(evidence);
        run();
        assert.deepEqual(fs.readFileSync(evidence), first);
        const document = JSON.parse(first.toString('utf8'));
        assert.equal(document.schema, 'fsusblog.public-preview-screenshot-verification.v1');
        assert.equal(Object.keys(document.images).length, 9);
        assert.match(document.sourceCommit, /^[a-f0-9]{40}$/u);
        assert.match(document.releaseId, /^\d{14}-[a-f0-9]{12}$/u);
        assert.match(document.visualInputDigest, /^[a-f0-9]{64}$/u);
        assert.match(document.commandVersion, /^[a-f0-9]{64}$/u);
        assert.doesNotMatch(first.toString('utf8'), /(?:\/home\/|container|generatedAt|finishedAt|runUrl|secret)/iu);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
});

test('release-final requires matching local public-preview evidence without a CI identity', () =>
{
    const commit = 'a'.repeat(40);
    const evidence = {
        schema: 'fsusblog.public-preview-screenshot-verification.v1',
        status: 'ok',
        sourceCommit: commit,
        releaseId: `20260723000000-${commit.slice(0, 12)}`,
        manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
        visualInputDigest: 'b'.repeat(64),
        runtimeAudit: true,
        layoutAudit: true,
        sanitizationCheck: true,
        images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`image-${index}`, 'c'.repeat(64)])),
        differences: [],
        commandVersion: 'd'.repeat(64)
    };
    const binding = {
        ...evidence,
        captureContextCount: 9,
        evidencePath: '.tmp/release-evidence/public-preview-screenshots.json',
        evidenceFileDigest: `sha256:${'e'.repeat(64)}`
    };
    assert.throws(() => requirePublicPreviewReleaseEvidence({
        commitSha: commit,
        browserContractReceipt: { publicPreview: binding },
        findReceiptFile: () => null,
        sha256Hex: () => 'e'.repeat(64),
        environment: {}
    }), /fails closed without local evidence/u);
    assert.deepEqual(requirePublicPreviewReleaseEvidence({
        commitSha: commit,
        browserContractReceipt: { publicPreview: binding },
        findReceiptFile: () => ({ file: '/local/evidence.json', receipt: evidence }),
        sha256Hex: () => 'e'.repeat(64),
        environment: {}
    }), evidence);
});
