import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {contract, encodeVisualArtifact, rasterize} = await import(new URL('../../tools/contracts/perception-character-v3-reference.mjs', import.meta.url));
const {disposeAudioEncoder, encodeAudioArtifact} = await import(new URL('../../tools/security/perception-character-v3-pool-media.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const corpusTool = path.join(root, 'tools/security/perception-character-v3-release-corpus.mjs');

test('compressed visual and deterministic audio artifacts satisfy release-profile primitives', () =>
{
    const sizes = [];
    for (let index = 0; index < 32; index += 1)
    {
        const seed = createHash('sha256').update(`release-gate-visual-${index}`).digest();
        const answer = [...Array(contract.answer.length)]
            .map((_, position) => contract.answer.alphabet[(index + position * 7) % contract.answer.alphabet.length])
            .join('');
        sizes.push(encodeVisualArtifact(rasterize(answer, seed), seed).length);
    }
    sizes.sort((left, right) => left - right);
    assert.equal(contract.media.visual.compression, 'zlib-deflate-level-9');
    assert.ok(sizes[Math.ceil(sizes.length * 0.50) - 1] <= 20 * 1024);
    assert.ok(sizes[Math.ceil(sizes.length * 0.95) - 1] <= 28 * 1024);
    assert.ok(sizes.at(-1) <= 32 * 1024);

    const serial = Buffer.from('01020304', 'hex');
    const first = encodeAudioArtifact('A7C9Q', {
        serialSeed: serial,
        temporaryId: 'deterministic-a'
    });
    const second = encodeAudioArtifact('A7C9Q', {
        serialSeed: serial,
        temporaryId: 'deterministic-b'
    });
    assert.deepEqual(first, second);
    disposeAudioEncoder();
});

test('fixture corpus writes review media and a non-release report without weakening release minimums', () =>
{
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-v3-corpus-gate-'));
    try
    {
        const fixture = spawnSync(process.execPath, [
            corpusTool,
            '--profile', 'fixture',
            '--visual', '12',
            '--audio', '2',
            '--workers', '2',
            '--output', output
        ], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
        const report = JSON.parse(fs.readFileSync(
            path.join(output, 'perception-character-v3-corpus-report.json'),
            'utf8'
        ));
        assert.equal(report.status, 'passed');
        assert.equal(report.releaseEligible, false);
        assert.equal(report.visual.count, 12);
        assert.equal(report.audio.count, 2);
        assert.ok(report.reviewFixtures.length >= 4);
        for (const entry of report.reviewFixtures)
            assert.equal(fs.existsSync(path.join(output, entry.path)), true);

        const undersizedRelease = spawnSync(process.execPath, [
            corpusTool,
            '--profile', 'release',
            '--visual', '9999',
            '--audio', '2000',
            '--workers', '2',
            '--output', output
        ], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.notEqual(undersizedRelease.status, 0);
        assert.match(undersizedRelease.stderr, /release corpus requires at least 10000 visual and 2000 audio/u);
    }
    finally
    {
        fs.rmSync(output, { recursive: true, force: true });
    }
});

test('release gate has two distinct receipt passes and no runtime generator registration', () =>
{
    const runner = fs.readFileSync(
        path.join(root, 'tools/security/run-perception-character-v3-release-gate.mjs'),
        'utf8'
    );
    const implementation = fs.readFileSync(
        path.join(root, 'tools/security/perception-character-v3-release-receipt.mjs'),
        'utf8'
    );
    const independent = fs.readFileSync(
        path.join(root, 'tools/security/perception-character-v3-independent-review.mjs'),
        'utf8'
    );
    assert.match(runner, /--visual', '10000'/u);
    assert.match(runner, /--audio', '2000'/u);
    assert.match(runner, /implementation-verification-receipt\.json/u);
    assert.match(runner, /independent-review-receipt\.json/u);
    assert.doesNotMatch(independent, /from '.\/perception-character-v3-release-receipt/u);
    assert.match(implementation, /ratios\?\.cpu >= 10/u);
    assert.match(implementation, /nonPayloadManagedAllocation >= 8/u);
    assert.match(independent, /retiredRuntimeAbsent/u);

    const runtime = [
        'src/backend/Program.cs',
        'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs',
        'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs'
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    assert.doesNotMatch(runtime, /perception-character-v3-(?:release-corpus|pool|spoken-atlas|vectors)\.mjs/iu);
});

test('production and release-final share one physical corpus and benchmark tier', () =>
{
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const runner = fs.readFileSync(
        path.join(root, 'tools/security/run-perception-character-v3-release-gate.mjs'),
        'utf8'
    );
    assert.equal(
        (matrix.match(/^\s+- id: perception-character-v3-release-gate$/gmu) ?? []).length,
        1
    );
    assert.equal(
        (matrix.match(/command: tools\/test\/lanes\/perception-character-v3-release-gate\.sh/gmu)
            ?? []).length,
        1
    );
    assert.match(
        matrix,
        /localProfiles:[\s\S]*?production:[\s\S]*?members:[\s\S]*?perception-character-v3-release-gate/u
    );
    assert.match(
        matrix,
        /- id: release-evidence[\s\S]*?executionDependsOn:[\s\S]*?perception-character-v3-release-gate/u
    );
    assert.match(
        matrix,
        /- id: release-final[\s\S]*?requiresEvidenceFrom:[\s\S]*?perception-character-v3-release-gate/u
    );
    assert.equal(
        (runner.match(/tools\/security\/perception-character-v3-release-corpus\.mjs/gmu) ?? []).length,
        1
    );
    assert.equal(
        (runner.match(/--perception-character-v3-pool-issue-profile/gmu) ?? []).length,
        1
    );
});
