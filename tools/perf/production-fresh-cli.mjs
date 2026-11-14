#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { captureCohort, inspectCohort, outputPath } from './production-fresh-cohort.mjs';
import { comparePerformance } from './production-fresh-comparator.mjs';
import { assert, readDocument, writeNew } from './production-fresh-contract.mjs';
import { createPerformanceVerdict } from './production-fresh-verdict.mjs';

export function runCli(args)
{
    const [command, ...flags] = args;
    const allowed = {
        capture: ['root', 'ledger', 'run', 'expected-head', 'out'], inspect: ['root', 'baseline'],
        compare: ['root', 'current-run', 'baseline', 'out'], verdict: ['root', 'comparison', 'binding', 'out']
    }[command];
    assert(allowed && flags.length % 2 === 0, 'use capture | inspect | compare | verdict with explicit option/value pairs');
    const options = {};
    for (let index = 0; index < flags.length; index += 2)
    {
        const name = flags[index].slice(2);
        assert(flags[index].startsWith('--') && allowed.includes(name) && flags[index + 1], 'unknown/missing CLI option');
        assert(name === 'run' || !Object.hasOwn(options, name), 'duplicate CLI option');
        options[name] = name === 'run' ? [...(options[name] ?? []), flags[index + 1]] : flags[index + 1];
    }
    assert(allowed.every(name => options[name]), 'all explicit locators/options are required');
    let value;
    if (command === 'capture')
    {
        value = captureCohort({ root: options.root, ledgerLocator: options.ledger,
            runLocators: options.run, expectedHead: options['expected-head'], outputLocator: options.out });
    }
    else if (command === 'inspect')
    {
        value = inspectCohort(options.root, options.baseline).cohort;
    }
    else if (command === 'compare')
    {
        value = comparePerformance({ root: options.root, currentLocator: options['current-run'], baselineLocator: options.baseline });
        writeNew(outputPath(options.root, options.out), value);
    }
    else
    {
        value = createPerformanceVerdict(options.root, options.comparison, readDocument(options.root, options.binding).value);
        writeNew(outputPath(options.root, options.out), value);
    }
    return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    try
    {
        const value = runCli(process.argv.slice(2));
        console.log(JSON.stringify(value, null, 4));
        if (['regression', 'not-evaluable'].includes(value.verdict))
        {
            process.exitCode = value.verdict === 'regression' ? 1 : 2;
        }
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 2;
    }
}
