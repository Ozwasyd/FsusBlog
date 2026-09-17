#!/usr/bin/env node
/**
 * CLI: render/replace/check Markdown fact sections from FactObservationReceipts.
 *
 *   node tools/docs/generate-fact-sections.mjs --check --receipt path/to/receipt.json
 *   node tools/docs/generate-fact-sections.mjs --generate --receipt path/to/receipt.json
 *
 * Check mode never writes. Generate mode only replaces owned FSUSBLOG-GENERATED ranges.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, root, validateCatalogSchemaContract, loadCatalogSchema } from './generated-fact-sections/catalog.mjs';
import { processGeneratedFactSections } from './generated-fact-sections/generator.mjs';
import {
    formatGovernanceViolations,
    scanGeneratedFactSectionGovernance
} from './generated-fact-sections/governance.mjs';
import { GeneratedSectionErrorCode } from './generated-fact-sections/markers.mjs';

function printUsage()
{
    console.error('usage: generate-fact-sections.mjs --check|--generate [--receipt <path>]... [--catalog <path>] [--skip-governance]');
}

function parseArgs(argv)
{
    const options = {
        mode: null,
        receipts: [],
        catalogPath: undefined,
        skipGovernance: false
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--check')
        {
            options.mode = 'check';
            continue;
        }
        if (arg === '--generate' || arg === '--write')
        {
            options.mode = 'generate';
            continue;
        }
        if (arg === '--skip-governance')
        {
            options.skipGovernance = true;
            continue;
        }
        if (arg === '--receipt')
        {
            const value = argv[index + 1];
            if (!value)
            {
                throw new Error('--receipt requires a path');
            }
            options.receipts.push(value);
            index += 1;
            continue;
        }
        if (arg.startsWith('--receipt='))
        {
            options.receipts.push(arg.slice('--receipt='.length));
            continue;
        }
        if (arg === '--catalog')
        {
            options.catalogPath = argv[index + 1];
            index += 1;
            continue;
        }
        if (arg.startsWith('--catalog='))
        {
            options.catalogPath = arg.slice('--catalog='.length);
            continue;
        }
        if (arg === '--help' || arg === '-h')
        {
            printUsage();
            process.exit(0);
        }
        throw new Error(`unknown argument ${arg}`);
    }
    if (options.mode !== 'check' && options.mode !== 'generate')
    {
        throw new Error('exactly one of --check or --generate is required');
    }
    return options;
}

function main()
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        validateCatalogSchemaContract(loadCatalogSchema(root));
        const catalog = loadCatalog(root, options.catalogPath);

        if (!options.skipGovernance)
        {
            const violations = scanGeneratedFactSectionGovernance(root);
            if (violations.length > 0)
            {
                for (const line of formatGovernanceViolations(violations))
                {
                    console.error(`[generated-fact-sections] ${line}`);
                }
                process.exitCode = 1;
                return;
            }
        }

        if (catalog.sections.length === 0 && options.receipts.length === 0)
        {
            console.log(`[generated-fact-sections] ${options.mode} ok sections=0 (empty catalog)`);
            return;
        }

        if (catalog.sections.length > 0 && options.receipts.length === 0)
        {
            throw new Error('catalog declares sections; supply --receipt for each required extractor');
        }

        const receiptPaths = options.receipts.map((entry) =>
            path.isAbsolute(entry) ? entry : path.join(root, entry));

        const result = processGeneratedFactSections({
            repositoryRoot: root,
            mode: options.mode,
            catalog,
            receipts: receiptPaths
        });

        if (options.mode === 'check')
        {
            console.log(
                `[generated-fact-sections] check ok documents=${result.documents.length} sections=${catalog.sections.length}`
            );
        }
        else
        {
            console.log(
                `[generated-fact-sections] generate ok written=${result.written.length} documents=${result.documents.length}`
            );
        }
    }
    catch (error)
    {
        const code = error?.code ?? GeneratedSectionErrorCode.CATALOG_INVALID;
        console.error(`[generated-fact-sections] ${code}: ${error.message}`);
        if (error?.drifts)
        {
            for (const drift of error.drifts)
            {
                console.error(`[generated-fact-sections] drift ${drift.documentPath}: ${drift.message}`);
            }
        }
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}

export { main, parseArgs };
