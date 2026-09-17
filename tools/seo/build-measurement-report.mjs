#!/usr/bin/env node

import process from 'node:process';

import { buildInventoryReport, readJson, writeJson } from './measurement-lib.mjs';

function args(argv)
{
    const values = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        values[argv[index]?.replace(/^--/u, '')] = argv[index + 1];
    }
    return values;
}

const options = args(process.argv.slice(2));
for (const name of ['inventory', 'search-console', 'crawler', 'experiments'])
{
    if (!options[name])
    {
        console.error(`[seo-report] --${name} is required`);
        process.exit(2);
    }
}
const report = buildInventoryReport({
    inventory: readJson(options.inventory),
    searchConsole: readJson(options['search-console']),
    crawler: readJson(options.crawler),
    experiments: readJson(options.experiments).experiments
});
const output = options.output ?? '.tmp/seo/url-inventory-report.json';
writeJson(output, report);
console.log(`[seo-report] status=${report.status} urls=${report.urls.length} diagnostics=${report.diagnostics.length} cutoff=${report.dataCutoff ?? 'unavailable'} output=${output}`);
if (report.status !== 'ok')
{
    process.exitCode = 2;
}
