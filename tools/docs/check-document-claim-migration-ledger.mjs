#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRepositoryClaims } from './doc-claim.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const readJson = (repositoryRoot, relative) => JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'))
const sorted = (values) => [...values].sort()
const pairKey = (behaviorId, documentPath) => `${behaviorId}\0${documentPath}`

function sameSet(left, right)
{
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

export function validateMigrationLedgerData({ ledger, catalog, lifecycle, claims, sectionCatalog })
{
    if (ledger?.schema !== 'fsusblog.document-claim-migration-ledger.v1' || !Array.isArray(ledger.scopes))
    {
        throw new Error('migration ledger schema is invalid')
    }
    const currentDocuments = new Set(lifecycle.documents.filter((entry) => entry.status === 'current').map((entry) => entry.path))
    const contracts = new Map(catalog.contracts.map((contract) => [contract.id, contract]))
    const claimsById = new Map(claims.map((claim) => [claim.declaration.claimId, claim]))
    const sectionsById = new Map(sectionCatalog.sections.map((section) => [section.sectionId, section]))
    const scopeIds = new Set()

    for (const scope of ledger.scopes)
    {
        if (scopeIds.has(scope.scopeId)) throw new Error(`duplicate migration scope ${scope.scopeId}`)
        scopeIds.add(scope.scopeId)
        const expectedPairs = []
        for (const behaviorId of scope.behaviorIds)
        {
            const contract = contracts.get(behaviorId)
            if (!contract || contract.status !== 'active' || contract.documentationPolicy !== 'required')
            {
                throw new Error(`${scope.scopeId} references non-required active behavior ${behaviorId}`)
            }
            for (const documentPath of contract.documents)
            {
                if (!currentDocuments.has(documentPath)) throw new Error(`${documentPath} is not current`)
                expectedPairs.push(pairKey(behaviorId, documentPath))
            }
        }
        const actualPairs = scope.entries.map((entry) => pairKey(entry.behaviorId, entry.documentPath))
        if (!sameSet(expectedPairs, actualPairs) || new Set(actualPairs).size !== actualPairs.length)
        {
            throw new Error(`${scope.scopeId} ledger does not exactly match BehaviorCatalog current documents`)
        }
        for (const entry of scope.entries)
        {
            for (const claimId of entry.claimIds)
            {
                const claim = claimsById.get(claimId)
                if (!claim || claim.declaration.behaviorId !== entry.behaviorId || claim.location.documentPath !== entry.documentPath)
                {
                    throw new Error(`${entry.documentPath} missing bound claim ${claimId}`)
                }
            }
            const expectedSections = sectionCatalog.sections
                .filter((section) => section.behaviorId === entry.behaviorId && section.documentPath === entry.documentPath)
                .map((section) => section.sectionId)
            if (!sameSet(expectedSections, entry.generatedSectionIds))
            {
                throw new Error(`${entry.documentPath} generated sections do not exactly match ledger`)
            }
            for (const sectionId of entry.generatedSectionIds)
            {
                const section = sectionsById.get(sectionId)
                if (!section) throw new Error(`missing generated section ${sectionId}`)
                const claimOwnsSection = entry.claimIds.some((claimId) => claimsById.get(claimId)?.declaration.generatedSectionId === sectionId)
                if (!claimOwnsSection) throw new Error(`${sectionId} has no ledger-bound DocClaim`)
            }
        }
    }
    return { scopeCount: ledger.scopes.length, entryCount: ledger.scopes.reduce((sum, scope) => sum + scope.entries.length, 0) }
}

export function validateRepositoryMigrationLedger(repositoryRoot = root)
{
    return validateMigrationLedgerData({
        ledger: readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson(repositoryRoot, 'config/contracts/behavior-contracts.json'),
        lifecycle: readJson(repositoryRoot, 'config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(repositoryRoot).claims,
        sectionCatalog: readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json')
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const result = validateRepositoryMigrationLedger(root)
        console.log(`[document-claim-migration-ledger] ok scopes=${result.scopeCount} entries=${result.entryCount}`)
    }
    catch (error)
    {
        console.error(`[document-claim-migration-ledger] ${error.message}`)
        process.exitCode = 1
    }
}
