import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractCurrentVersion } from '../../tools/governance/dependency-freshness.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
function fixture(t, source)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-docker-current-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'source'), source);
    return root;
}

test('literal Dockerfile and Compose references retain their immutable digest', t => {
    for (const [manager, source] of [
        ['dockerfile', `FROM redis:8.0@${digest} AS cache`],
        ['docker-compose', `services:\n  cache:\n    image: "redis:8.0@${digest}"`]
    ])
    {
        const root = fixture(t, source);
        assert.equal(extractCurrentVersion(root, { manager, packageName: 'redis', files: ['source'] }, {}), `8.0@${digest}`);
    }
});

test('custom container projections retain pins and reject inconsistent repeated identities', t => {
    const root = fixture(t, `redis:8.0@${digest}\nredis:8.0@${digest}\nversion=8.0`);
    const item = { id: 'redis', manager: 'custom.regex', datasource: 'docker', customManager: 'pins', packageName: 'redis', files: ['source'] };
    const config = { customManagers: [{ description: 'pins', depNameTemplate: 'redis', managerFilePatterns: ['/source/'], matchStrings: [
        'redis:(?<currentValue>[0-9.]+)@(?<currentDigest>sha256:[0-9a-f]{64})', 'version=(?<currentValue>[0-9.]+)'
    ] }] };
    assert.equal(extractCurrentVersion(root, item, config), `8.0@${digest}`);
    fs.appendFileSync(path.join(root, 'source'), `\nredis:8.0@sha256:${'b'.repeat(64)}`);
    assert.throws(() => extractCurrentVersion(root, item, config), /references-disagree/);
});

test('Dockerfile global ARG expansion preserves every flavor and ignores stage-scoped defaults', t => {
    const other = `sha256:${'b'.repeat(64)}`;
    const root = fixture(t, `ARG NODE_VERSION=24.1.0\nARG MUSL=${digest}\nARG GLIBC=${other}\nFROM node:\${NODE_VERSION}-alpine@\${MUSL} AS musl\nARG NODE_VERSION=99.0.0\nFROM --platform=linux/amd64 node:\${NODE_VERSION}-slim@\${GLIBC} AS glibc`);
    const item = { manager: 'dockerfile', packageName: 'node', files: ['source'] };
    assert.deepEqual(JSON.parse(extractCurrentVersion(root, item, {})), [`24.1.0-alpine@${digest}`, `24.1.0-slim@${other}`]);
    fs.writeFileSync(path.join(root, 'source'), 'FROM node:${MISSING}@${DIGEST}');
    assert.throws(() => extractCurrentVersion(root, item, {}), /argument-unresolved/);
});
