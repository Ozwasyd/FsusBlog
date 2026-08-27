import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseRepositoryClaims } from '../../tools/docs/doc-claim.mjs'
import { root, validateMigrationLedgerData, validateRepositoryMigrationLedger } from '../../tools/docs/check-document-claim-migration-ledger.mjs'

const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))

test('repository migration ledger exactly covers catalog current documents', () =>
{
    assert.deepEqual(validateRepositoryMigrationLedger(), { scopeCount: 1, entryCount: 9 })
})

test('missing document entry and orphan section fail closed', () =>
{
    const input = {
        ledger: readJson('config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson('config/contracts/behavior-contracts.json'),
        lifecycle: readJson('config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(root).claims,
        sectionCatalog: readJson('config/contracts/generated-fact-sections.json')
    }
    const missing = structuredClone(input)
    missing.ledger.scopes[0].entries.pop()
    assert.throws(() => validateMigrationLedgerData(missing), /does not exactly match/u)
    const orphan = structuredClone(input)
    orphan.ledger.scopes[0].entries[0].generatedSectionIds = ['missing.section']
    assert.throws(() => validateMigrationLedgerData(orphan), /generated sections do not exactly match/u)
})
