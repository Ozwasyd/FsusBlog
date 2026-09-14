import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { scanAuditFixtureGovernance } = await import(new URL('../../tools/testing/check-audit-fixture-governance.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('audit fixture governance has one production writer and no retired actions', () =>
{
    const result = scanAuditFixtureGovernance(root);

    assert.equal(result.status, 'verified', result.errors.join('\n'));
    assert.deepEqual(result.directAuditSqlOwners, [
        'src/backend/Infrastructure/Audit/AuditLogStore.cs'
    ]);
    assert.equal(result.auditCapabilityCount, 9);
    assert.deepEqual(result.warnings, []);
    assert.match(result.contentDigest, /^[0-9a-f]{64}$/u);
});

test('audit fixture governance rejects direct SQL and unknown demo actions', async (context) =>
{
    const directory = await mkdtemp(path.join(tmpdir(), 'fsusblog-audit-governance-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await Promise.all([
        cp(path.join(root, 'config'), path.join(directory, 'config'), { recursive: true }),
        cp(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true }),
        cp(path.join(root, 'tests'), path.join(directory, 'tests'), { recursive: true }),
        cp(path.join(root, 'tools'), path.join(directory, 'tools'), { recursive: true })
    ]);
    const mutation = path.join(directory, 'tools', 'bad-audit-fixture.sql');
    await writeFile(
        mutation,
        "INSERT INTO sys_audit_log(action) VALUES ('anti-crawler.demo-signal');\n"
    );

    const result = scanAuditFixtureGovernance(directory);

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((item) => item.includes('direct audit SQL')));
    assert.ok(result.errors.some((item) => item.includes('retired unknown positive audit action')));
});
