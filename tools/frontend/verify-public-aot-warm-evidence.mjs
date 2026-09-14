#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { validatePublicAotWarmEvidence } from './public-aot-warm-evidence.mjs';

function parseArgs(argv)
{
    const options = { report: '', expectedRelease: '', expectedSlot: '', expectedPublicOrigin: '', requireScope: 'all', maxAgeSeconds: 900 };
    const aliases = {
        report: 'report',
        'expected-release': 'expectedRelease',
        'expected-slot': 'expectedSlot',
        'expected-public-origin': 'expectedPublicOrigin',
        'require-scope': 'requireScope',
        'max-age-seconds': 'maxAgeSeconds'
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        const rawKey = arg.startsWith('--') ? arg.slice(2) : '';
        const key = aliases[rawKey];
        if (key && argv[index + 1])
        {
            options[key] = key === 'maxAgeSeconds' ? Number(argv[index + 1]) : argv[index + 1];
            index += 1;
        }
    }
    if (!options.report)
    {
        throw new Error('--report is required');
    }
    if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 1 || options.maxAgeSeconds > 86400)
    {
        throw new Error('--max-age-seconds must be 1..86400');
    }
    return options;
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const evidence = JSON.parse(await readFile(options.report, 'utf8'));
    const errors = validatePublicAotWarmEvidence(evidence, options);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    console.log(`[public-aot-warm-evidence] ok routes=${evidence.routes.length} digest=${evidence.manifestDigest}`);
}

main().catch((error) =>
{
    console.error(`[public-aot-warm-evidence] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
