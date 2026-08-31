import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')

test('aggregate requires explicit framework and randomized family authorities', () =>
{
    const result = spawnSync(process.execPath, [path.join(root, 'tools/test/aggregate-replay-qualification.mjs')], {
        cwd: root,
        encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /arguments must be unique --key value pairs|missing/u)
})

test('independent verifier refuses paths outside the repository before reading evidence', () =>
{
    const result = spawnSync(process.execPath, [path.join(root, 'tools/test/verify-replay-qualification.mjs'), '/tmp/replay.json'], {
        cwd: root,
        encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /path escapes repository/u)
})
