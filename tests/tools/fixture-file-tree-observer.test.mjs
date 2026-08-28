/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { observeFileTree } from '../../tools/test-fixtures/observers/file-tree.mjs';
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';

import { runtimeIdentity } from './support/runtime-state-fixture.mjs';

const domain = 'fixture.public-content';
const identity = runtimeIdentity();

function fixture(t, entries)
{
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-file-observer-'));
    const root = path.join(sessionRoot, 'mutable', 'fixture');
    fs.mkdirSync(root, { recursive: true });
    for (const [name, value] of entries)
    {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
    }
    t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
    return {
        sessionRoot,
        root,
        handle: {
            owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
            catalogDigest: identity.catalogDigest,
            sessionRoot,
            root,
            rootId: 'public-content'
        }
    };
}

test('file-tree observer is order/mtime/path independent and content sensitive', async (t) =>
{
    const left = fixture(t, [['b.txt', 'b'], ['nested/a.txt', 'a']]);
    const right = fixture(t, [['nested/a.txt', 'a'], ['b.txt', 'b']]);
    const observe = (item) => observeFileTree({ domain, identity, context: { handles: { [domain]: item.handle } } });
    const first = await observe(left);
    const second = await observe(right);
    assert.equal(digestCanonical(first.semantic), digestCanonical(second.semantic));
    fs.utimesSync(left.root, new Date(0), new Date(0));
    assert.equal(digestCanonical((await observe(left)).semantic), digestCanonical(first.semantic));
    fs.writeFileSync(path.join(left.root, 'b.txt'), 'changed');
    assert.notEqual(digestCanonical((await observe(left)).semantic), digestCanonical(first.semantic));
});

test('file-tree observer rejects escape, dangling and unsupported entries', async (t) =>
{
    const item = fixture(t, [['safe.txt', 'safe']]);
    fs.symlinkSync('/etc/passwd', path.join(item.root, 'escape'));
    await assert.rejects(observeFileTree({ domain, identity, context: { handles: { [domain]: item.handle } } }), /path-escape/);
    fs.unlinkSync(path.join(item.root, 'escape'));
    fs.symlinkSync('missing', path.join(item.root, 'dangling'));
    await assert.rejects(observeFileTree({ domain, identity, context: { handles: { [domain]: item.handle } } }), /dangling/);
});
