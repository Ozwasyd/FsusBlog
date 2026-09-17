import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const command = path.join(root, 'tools/security/perception-character-v3-pool.mjs');
const { buildSpokenPcm } = await import(new URL('../../tools/security/perception-character-v3-pool-media.mjs', import.meta.url));

function run(args, key)
{
    return spawnSync(process.execPath, [command, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_TEST_POOL_KEY: key.toString('hex') }
    });
}

function fixture()
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-v3-pool-'));
    const key = randomBytes(32);
    const generation = 'local-contract-generation';
    const common = ['--root', directory, '--generation', generation, '--key-env', 'FSUSBLOG_TEST_POOL_KEY'];
    const generated = run(['generate', ...common, '--key-version', 'pool-k1', '--visual', '3', '--audio', '2'], key);
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    return { directory, generation, key, common };
}

test('offline pool generator writes encrypted compact pack and validates every entry', () =>
{
    const value = fixture();
    try
    {
        const generationRoot = path.join(value.directory, value.generation);
        const manifest = JSON.parse(fs.readFileSync(path.join(generationRoot, 'manifest.json'), 'utf8'));
        const pack = fs.readFileSync(path.join(generationRoot, manifest.packFile));
        assert.equal(manifest.entries.length, 5);
        assert.equal(new Set(manifest.entries.map((entry) => entry.entryId)).size, 5);
        assert.deepEqual([...new Set(manifest.entries.map((entry) => entry.representation))].sort(), ['audio', 'visual']);
        assert.ok(manifest.entries.every((entry, index) => entry.offset === (index === 0
            ? 0
            : manifest.entries[index - 1].offset + manifest.entries[index - 1].length)));
        assert.doesNotMatch(JSON.stringify(manifest), /answer|artifactBase64|A7C9Q/iu);
        assert.doesNotMatch(pack.toString('latin1'), /artifactBase64|"answer"|A7C9Q/iu);
        const validated = run(['validate', ...value.common], value.key);
        assert.equal(validated.status, 0, validated.stderr || validated.stdout);
    }
    finally
    {
        fs.rmSync(value.directory, { recursive: true, force: true });
        value.key.fill(0);
    }
});

test('offline audio source binds the ordered five-character answer before Opus encoding', () =>
{
    const first = buildSpokenPcm('A7C9Q');
    const reordered = buildSpokenPcm('Q9C7A');
    try
    {
        assert.equal(first.length % (960 * 2), 0);
        assert.ok(first.some((value) => value !== 0));
        assert.notDeepEqual(first, reordered);
    }
    finally
    {
        first.fill(0);
        reordered.fill(0);
    }
});

test('pool validation fails closed for tamper, wrong key, duplicate IDs and contract drift', () =>
{
    for (const mutation of ['pack', 'key', 'duplicate', 'contract'])
    {
        const value = fixture();
        try
        {
            const generationRoot = path.join(value.directory, value.generation);
            const manifestPath = path.join(generationRoot, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            let key = value.key;
            if (mutation === 'pack')
            {
                const packPath = path.join(generationRoot, manifest.packFile);
                const pack = fs.readFileSync(packPath);
                pack[0] ^= 1;
                fs.writeFileSync(packPath, pack);
            }
            else if (mutation === 'key')
            {
                key = randomBytes(32);
            }
            else if (mutation === 'duplicate')
            {
                manifest.entries[1].entryId = manifest.entries[0].entryId;
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            }
            else
            {
                manifest.contractDigest = '0'.repeat(64);
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            }
            const checked = run(['validate', ...value.common], key);
            assert.notEqual(checked.status, 0, `${mutation} must fail closed`);
            if (key !== value.key)
            {
                key.fill(0);
            }
        }
        finally
        {
            fs.rmSync(value.directory, { recursive: true, force: true });
            value.key.fill(0);
        }
    }
});

test('runtime source leases final artifacts without importing the offline renderer', () =>
{
    assert.equal(fs.existsSync(path.join(root, 'src/backend/Services/Security/PerceptionCharacterV3Renderer.cs')), false);
    const provider = fs.readFileSync(path.join(root, 'src/backend/Services/Security/PerceptionCharacterV3Provider.cs'), 'utf8');
    const registration = fs.readFileSync(path.join(root, 'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs'), 'utf8');
    const pool = fs.readFileSync(path.join(root, 'src/backend/Services/Security/PerceptionCharacterV3ArtifactPool.cs'), 'utf8');
    assert.match(provider, /IPerceptionCharacterV3ArtifactPool artifactPool/u);
    assert.doesNotMatch(provider, /IPerceptionCharacterV3Renderer|RenderVisual|RenderAudio|EnterRenderAsync/u);
    assert.doesNotMatch(registration, /AddSingleton<IPerceptionCharacterV3Renderer/u);
    assert.doesNotMatch(pool, /RenderVisual|RenderAudio|buildVisualArtifact|buildAudioArtifact/u);
    assert.doesNotMatch(pool, /(?:StringSetAsync|HashSetAsync)[^;]*(?:artifact|answer)/iu);
    assert.match(pool, /redis\.call\('SET', KEYS\[2\], 'burned', 'NX'\)/u);
});
