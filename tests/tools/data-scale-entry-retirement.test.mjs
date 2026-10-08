import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateDataScaleTier } from '../../tools/data-scale/validate-tier.mjs';
import { scanDataScaleLegacyWrites } from '../../tools/governance/check-data-scale-legacy-writes.mjs';

test('retired entries cannot mutate any store or issue success evidence', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-scale-entry-retirement-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pg_isready"* ]]; then exit 0; fi
if [[ "$*" == *"SELECT count(*) FROM pg_stat_activity"* ]]; then printf '0\\n'; exit 0; fi
printf '%s\\n' "$*" >> "$RETIREMENT_MUTATIONS"
exit 99
`, { mode: 0o700 });
    for (const action of ['seed', 'cleanup'])
    {
        const result = spawnSync('bash', [path.resolve(`tools/data-scale/${action}.sh`), 'scale-xs'], {
            encoding: 'utf8', timeout: 10000,
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
                RETIREMENT_MUTATIONS: path.join(root, 'mutations'),
                FSUSBLOG_POSTGRES_CONTAINER_NAME: 'parity-retirement-owned',
                FSUSBLOG_DATA_SCALE_ROOT: path.join(root, 'artifacts'),
                FSUSBLOG_DATA_SCALE_OUT_DIR: path.join(root, 'artifacts') }
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /capability unavailable \(#2542\)/u);
        assert.match(result.stderr, /no verified receipt emitted/u);
        assert.equal(fs.existsSync(path.join(root, 'mutations')), false);
        assert.equal(fs.existsSync(path.join(root, 'artifacts')), false);
    }
});

test('actual tier criteria retain 100k articles and 1M comments without reinterpreting acceptance', () =>
{
    assert.deepEqual(validateDataScaleTier('scale-l-nightly'), { articleCount: 100000, commentCount: 1000000 });
    assert.throws(() => validateDataScaleTier('scale-million-articles'));
});

test('current execution sources are clear while runtime acceptance remains unavailable', () =>
{
    const result = scanDataScaleLegacyWrites();
    assert.equal(result.status, 'clear');
    assert.deepEqual(result.violations, []);
    assert.equal(Object.hasOwn(result, 'terminalReceipt'), false);
});
