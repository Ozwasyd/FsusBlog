import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const adapter = path.join(root, 'tools/test/xunit-replay-adapter.mjs')

test('xUnit replay adapter fails before discovery when sealed execution inputs are incomplete', () =>
{
    const result = spawnSync(process.execPath, [adapter, '--assembly', 'missing.dll'], {
        cwd: root,
        encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing --output-dir/u)
})

test('xUnit replay adapter rejects duplicate authority arguments', () =>
{
    const result = spawnSync(process.execPath, [adapter,
        '--assembly', 'missing.dll', '--assembly', 'other.dll',
        '--output-dir', '.tmp/replay-negative', '--root-seed', `seed256:${'1'.repeat(64)}`,
        '--workers', '1', '--run-id', 'negative'
    ], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--assembly may appear only once/u)
})
