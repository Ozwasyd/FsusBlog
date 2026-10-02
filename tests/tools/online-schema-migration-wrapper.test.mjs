import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const wrapper = path.join(root, 'tools/db/run-online-migrations.sh');

test('retired wrapper refuses expand dry-run before launching Server', (t) =>
{
    const fixture = createFixture(t);
    const result = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'expand',
        '--dry-run'
    ]);

    assertRetired(fixture, result);
});

test('retired wrapper refuses backfill with or without a resume id', (t) =>
{
    const fixture = createFixture(t);
    const missing = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'backfill-resume'
    ]);
    assertRetired(fixture, missing);

    const migrationId = '20260712-post-example-backfill';
    const resumed = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'backfill-resume',
        '--id', migrationId
    ]);
    assertRetired(fixture, resumed);
});

test('retired wrapper refuses Contract even with evidence or destructive confirmation', (t) =>
{
    const fixture = createFixture(t);
    const missingConfirmation = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'contract',
        '--evidence', fixture.evidence
    ]);
    assertRetired(fixture, missingConfirmation);

    const dryRun = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'contract',
        '--evidence', fixture.evidence,
        '--dry-run'
    ]);
    assertRetired(fixture, dryRun);

    const confirmed = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'contract',
        '--evidence', fixture.evidence,
        '--confirm-destructive'
    ]);
    assertRetired(fixture, confirmed);
});

test('retired wrapper does not read required files or evaluate hostile arguments', (t) =>
{
    const fixture = createFixture(t);
    fs.rmSync(fixture.manifest);
    fs.rmSync(fixture.envFile);
    fs.rmSync(fixture.evidence);
    const shellMarker = path.join(fixture.directory, 'argument-evaluated');
    const result = run(fixture, [
        '--release-manifest', fixture.manifest,
        '--env-file', fixture.envFile,
        '--phase', 'contract',
        '--id', `$(touch ${shellMarker})`,
        '--confirm-destructive'
    ]);

    assertRetired(fixture, result);
    assert.equal(fs.existsSync(shellMarker), false);
});

test('retired wrapper refuses empty and unknown invocations without launching a tool', (t) =>
{
    const fixture = createFixture(t);
    assertRetired(fixture, run(fixture, []));
    assertRetired(fixture, run(fixture, ['--renamed-upgrade', '--phase=expand']));
});

function assertRetired(fixture, result)
{
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', code: 'schema_wrapper_retired' });
    assert.equal(fs.existsSync(fixture.processMarker), false);
    assert.equal(result.stderr, '');
}

function createFixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-online-schema-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const server = path.join(directory, 'fake-server.mjs');
    const manifest = path.join(directory, 'release.json');
    const envFile = path.join(directory, 'server.env');
    const evidence = path.join(directory, 'contract-evidence.json');
    const processMarker = path.join(directory, 'server-started');
    fs.writeFileSync(server, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(processMarker)}, 'started');\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`);
    fs.writeFileSync(manifest, '{"schema":"fsusblog.release-manifest.v1","releaseId":"20260720-current"}\n');
    fs.writeFileSync(envFile, 'ConnectionStrings__DefaultConnection=redacted\n');
    fs.writeFileSync(evidence, '{"rollbackManifestSealed":true}\n');
    return { directory, server, manifest, envFile, evidence, processMarker };
}

function run(fixture, args)
{
    return spawnSync('bash', [
        wrapper,
        '--server-dll', fixture.server,
        ...args
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            DOTNET_BIN: process.execPath
        }
    });
}
