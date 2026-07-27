#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanRepositoryFactExtractorGovernance } from './governance.mjs'
import { loadRegistry, root, validateOwnershipAgainstBehaviorCatalog, validateRegistry } from './registry.mjs'
import { validateReceiptSchemaContract } from './receipt.mjs'
import { loadReceiptSchema } from './registry.mjs'

function main()
{
    try
    {
        const registry = loadRegistry(path.join(root, 'config/contracts/behavior-fact-extractors.json'))
        const validated = validateRegistry(registry, root)
        validateOwnershipAgainstBehaviorCatalog(registry, undefined, root)
        validateReceiptSchemaContract(loadReceiptSchema())
        const governance = scanRepositoryFactExtractorGovernance(root)
        if (governance.errors.length > 0)
        {
            for (const error of governance.errors)
            {
                console.error(`[behavior-fact-extractors] ${error}`)
            }
            process.exitCode = 1
            return
        }
        console.log(
            `[behavior-fact-extractors] registry, ownership, receipt schema, and hermetic governance are clean; extractors=${registry.extractors.length} digest=${validated.digest}`
        )
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : error)
        process.exitCode = 1
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main()
}

export { main }
