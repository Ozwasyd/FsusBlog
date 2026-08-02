import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
    validateJsonSchema
} from '../../../tools/test-matrix/schema-validator/validate.mjs'

const root = resolve(import.meta.dirname, '../../..')
const contract = JSON.parse(readFileSync(resolve(
    root,
    'tests/fixtures/issue-orchestration/final-e2e-contract.json'
), 'utf8'))
const runtimePath = resolve(root, contract.runtimeOwner)

let runtimePromise
async function runtime() {
    assert.equal(existsSync(runtimePath), true, contract.runtimeOwner)
    runtimePromise ??= import(pathToFileURL(runtimePath).href)
    return runtimePromise
}

export async function assertPermanentLane(laneFile) {
    assert.ok(contract.laneFiles.includes(laneFile), laneFile)
    const loaded = await runtime()
    const result = await loaded.verifyPermanentE2ELane(laneFile)
    assert.equal(result.status, 'verified')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/u)
}

export async function assertPermanentCrossRepoE2E() {
    const loaded = await runtime()
    const result = await loaded.runPermanentCrossRepoE2E({
        repositoryRoot: root,
        fsusUIRoot: resolve(root, '../FsusUI'),
        live: process.env.FSUSBLOG_E2E_LIVE === '1'
    })
    assert.equal(result.status, 'verified')
    assert.equal(result.temporaryBootstrapUsed, false)
    assert.equal(result.falsePositiveDagDispatchCount, 0)
    assert.deepEqual(result.quiescenceViolations, [])
    assert.equal(result.mutationControlsKilled, 19)
    assert.match(result.receiptDigest, /^[a-f0-9]{64}$/u)
    const schema = JSON.parse(readFileSync(resolve(
        root,
        contract.receiptSchema
    ), 'utf8'))
    assert.deepEqual(validateJsonSchema(result, schema), [])
}
