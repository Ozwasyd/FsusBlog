import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const seed = fileURLToPath(new URL('../../tools/data-scale/seed.sh', import.meta.url));

test('offline seed refuses unavailable or invalid ownership observations before SQL mutation', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-data-scale-seed-admission-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    const mutations = path.join(root, 'mutations');
    const docker = path.join(tools, 'docker');
    fs.writeFileSync(docker, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ps" ]]; then
    if [[ "$SEED_FAILURE" == "backend-inventory" ]]; then exit 23; fi
    exit 0
fi
if [[ "$*" == *"DBSIZE"* ]]; then printf '0\\n'; exit 0; fi
if [[ "$*" == *"pg_isready"* ]]; then exit 0; fi
if [[ "$*" == *"pg_stat_activity"* ]]; then
    case "$SEED_FAILURE" in
        database-inventory) exit 24 ;;
        invalid-count) printf 'unknown\\n' ;;
        foreign-connection) printf '1\\n' ;;
    esac
    exit 0
fi
printf 'unexpected SQL mutation\\n' >> "$SEED_MUTATIONS"
exit 99
`, { mode: 0o700 });
    for (const [failure, refusal] of [
        ['backend-inventory', 'dedicated backend inventory is unavailable'],
        ['database-inventory', 'dedicated database connection inventory is unavailable'],
        ['invalid-count', 'dedicated database connection inventory is invalid'],
        ['foreign-connection', 'offline seed requires isolation']
    ])
    {
        const result = spawnSync('bash', [seed, 'scale-xs'], {
            encoding: 'utf8', timeout: 10000,
            env: {
                ...process.env, PATH: `${tools}:${process.env.PATH}`,
                SEED_FAILURE: failure, SEED_MUTATIONS: mutations,
                FSUSBLOG_DATA_SCALE_OUT_DIR: path.join(root, failure),
                FSUSBLOG_TEST_NAMESPACE: 'scale-owned',
                FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-scale-postgres-owned',
                FSUSBLOG_REDIS_CONTAINER_NAME: 'fsusblog-scale-redis-owned',
                FSUSBLOG_DATA_SCALE_BACKEND_CONTAINER_NAME: 'fsusblog-scale-backend-owned',
                FSUSBLOG_DATA_SCALE_REQUIRE_EMPTY: '1'
            }
        });
        assert.equal(result.error, undefined, failure);
        assert.notEqual(result.status, 0, failure);
        assert.ok(result.stderr.includes(refusal), `${failure}: ${result.stderr}`);
        assert.equal(fs.existsSync(mutations), false, failure);
    }
});
