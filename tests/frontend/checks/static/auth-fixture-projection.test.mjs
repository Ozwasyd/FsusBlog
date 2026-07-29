import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createAdminStepUpProofToken, readAdminAuthFixtureProjection } = await import(new URL("../../support/auth-fixture-projection.mjs", import.meta.url));

const receiptDigest = `sha256:${'a'.repeat(64)}`;

async function writeProjection(directory, document, name = 'auth-fixtures.json')
{
    const file = path.join(directory, name);
    await writeFile(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
}

test('admin proof delegates only after the private projection matches the active session', async () =>
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-auth-projection-'));
    try
    {
        const projectionFile = await writeProjection(directory, {
            sourceReceiptDigest: receiptDigest,
            admin: { id: 42, sessionId: 'admin-session-42' }
        });
        const calls = [];
        const token = createAdminStepUpProofToken({
            session: { adminId: 42, sessionId: 'admin-session-42' },
            action: 'article-delete',
            ttlSeconds: 30,
            projectionFile,
            proofProducer: (input) =>
            {
                calls.push(input);
                return 'proof-token';
            }
        });

        assert.equal(token, 'proof-token');
        assert.deepEqual(calls, [{
            adminId: 42,
            sessionId: 'admin-session-42',
            action: 'article-delete',
            ttlSeconds: 30
        }]);
        assert.deepEqual(readAdminAuthFixtureProjection({ projectionFile }), {
            adminId: 42,
            sessionId: 'admin-session-42',
            sourceReceiptDigest: receiptDigest
        });
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
});

test('admin proof rejects projection drift before invoking the proof producer', async () =>
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-auth-projection-drift-'));
    try
    {
        const projectionFile = await writeProjection(directory, {
            admin: { id: 42, sessionId: 'stale-session' }
        });
        let calls = 0;
        assert.throws(
            () => createAdminStepUpProofToken({
                session: { adminId: 42, sessionId: 'active-session' },
                projectionFile,
                proofProducer: () =>
                {
                    calls += 1;
                    return 'unexpected';
                }
            }),
            /does not match the active admin session/u
        );
        assert.equal(calls, 0);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
});

test('auth fixture projection rejects invalid receipt binding and symlink input', async () =>
{
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-auth-projection-private-'));
    try
    {
        const invalid = await writeProjection(directory, {
            sourceReceiptDigest: 'not-a-receipt-digest',
            admin: { id: 42, sessionId: 'admin-session-42' }
        });
        assert.throws(
            () => readAdminAuthFixtureProjection({ projectionFile: invalid }),
            /sourceReceiptDigest is invalid/u
        );

        const safe = await writeProjection(directory, {
            admin: { id: 42, sessionId: 'admin-session-42' }
        }, 'safe.json');
        const link = path.join(directory, 'linked.json');
        await symlink(safe, link);
        assert.throws(
            () => readAdminAuthFixtureProjection({ projectionFile: link }),
            /must not be a symlink/u
        );
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
});
