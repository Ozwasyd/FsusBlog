#!/usr/bin/env node

import process from 'node:process';

import { evaluateReleaseGate, readJson, writeJson } from './measurement-lib.mjs';

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
for (const name of ['search-console', 'crawler', 'report', 'experiments', 'release', 'commit', 'seo-change'])
{
    if (!options[name])
    {
        console.error(`[seo-release-gate] --${name} is required`);
        process.exit(2);
    }
}
if (!['true', 'false'].includes(options['seo-change']))
{
    console.error('[seo-release-gate] --seo-change must be true or false');
    process.exit(2);
}
const gate = evaluateReleaseGate({
    searchConsole: readJson(options['search-console']),
    crawler: readJson(options.crawler),
    report: readJson(options.report),
    registry: readJson(options.experiments),
    release: options.release,
    commit: options.commit,
    seoChanged: options['seo-change'] === 'true'
});
const output = options.output ?? '.tmp/seo/release-gate.json';
writeJson(output, gate);
for (const error of gate.errors)
{
    console.error(`[seo-release-gate] ${error}`);
}
console.log(`[seo-release-gate] status=${gate.status} cutoff=${gate.dataCutoff ?? 'unavailable'} output=${output}`);
if (gate.status !== 'ok')
{
    process.exitCode = 1;
}
