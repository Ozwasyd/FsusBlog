#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { root } from './behavior-contract-catalog.mjs';
import {
    assertBehaviorTestBindings,
    formatBehaviorTestBindingReport,
    joinBehaviorTestEvidence,
    scanBehaviorTestBindings,
    validateExactBehaviorCoverage
} from './behavior-test-binding.mjs';

function parseArgs(argv)
{
    const options = {
        mode: 'bindings',
        observations: [],
        evidenceRoot: null,
        json: false,
        out: null
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--mode')
        {
            options.mode = argv[++index];
        }
        else if (argument === '--observations')
        {
            options.observations.push(path.resolve(root, argv[++index] ?? ''));
        }
        else if (argument === '--evidence-root')
        {
            options.evidenceRoot = path.resolve(root, argv[++index] ?? '');
        }
        else if (argument === '--json')
        {
            options.json = true;
        }
        else if (argument === '--out')
        {
            options.out = path.resolve(root, argv[++index] ?? '');
        }
        else if (argument === '--help' || argument === '-h')
        {
            options.help = true;
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    if (!['bindings', 'exact', 'all'].includes(options.mode))
    {
        throw new Error('--mode must be bindings, exact, or all');
    }
    return options;
}

function printHelp()
{
    console.log(`Usage: node tools/contracts/check-behavior-test-evidence.mjs [options]

Options:
  --mode bindings|exact|all   bindings: source scan only; exact: join observations; all: both
  --observations <path>       test observation artifact (repeatable; required for exact/all)
  --evidence-root <path>      root for producer report digest verification
  --json                      emit machine-readable report
  --out <path>                write receipt JSON
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help)
{
    printHelp();
    process.exit(0);
}

const json = options.json;
let exitCode = 0;
let report;

if (options.mode === 'bindings')
{
    const scan = scanBehaviorTestBindings();
    report = formatBehaviorTestBindingReport(scan);
    if (report.errors.length > 0)
    {
        exitCode = 1;
    }
    else if (!json)
    {
        console.log(`[behavior-test-evidence] bindings ok (${report.bindingCount} binding(s); catalog ${report.catalogDigest.slice(0, 12)})`);
    }
}
else
{
    if (options.observations.length === 0)
    {
        console.error('[behavior-test-evidence] exact coverage requires --observations <artifact> for this-round execution evidence');
        process.exit(2);
    }
    const receipt = joinBehaviorTestEvidence({
        observations: options.observations,
        evidenceRoot: options.evidenceRoot
    });
    report = receipt;
    if (options.mode === 'all' || options.mode === 'exact')
    {
        try
        {
            validateExactBehaviorCoverage(receipt);
            if (!json)
            {
                console.log(`[behavior-test-evidence] exact coverage ok (behaviors=${receipt.coverage.length}; evidence=${receipt.evidence.length}; raw=${receipt.rawResultDigest.slice(0, 18)})`);
            }
        }
        catch (error)
        {
            exitCode = 1;
            if (!json)
            {
                console.error(error instanceof Error ? error.message : String(error));
            }
        }
    }
}

if (options.out)
{
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
}
if (json)
{
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
process.exitCode = exitCode;

export { assertBehaviorTestBindings, joinBehaviorTestEvidence, validateExactBehaviorCoverage };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--assert-bindings'))
{
    assertBehaviorTestBindings();
}
