#!/usr/bin/env node
import fs from 'node:fs';

export function validateSummaryOnlyConsumerSource(source, label = 'consumer')
{
    const errors = [];
    if (/logicalTierProjection\.status|projection\.status/u.test(source)
    && (!/qualificationEligible/u.test(source) || !/entries/u.test(source) || !/external-executed/u.test(source)))
    {
        errors.push(`${label} reads projection status without entry, qualification, and external-binding validation`);
    }
    return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname)
{
    const files = process.argv.slice(2);
    const errors = files.flatMap((file) => validateSummaryOnlyConsumerSource(fs.readFileSync(file, 'utf8'), file));
    if (errors.length)
    {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
}
