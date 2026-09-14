#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

import { collectSearchConsole, blockedSearchConsoleSnapshot, readJson, writeJson } from './measurement-lib.mjs';

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
const output = options.output ?? '.tmp/seo/search-console-daily.json';
const siteUrl = options.site ?? process.env.FSUSBLOG_SEARCH_CONSOLE_SITE;
const startDate = options.start;
const endDate = options.end;
const credentialFile = process.env.FSUSBLOG_SEARCH_CONSOLE_CREDENTIALS_FILE;
const inspectionFile = options['inspection-urls'];

let snapshot;
if (!siteUrl || !startDate || !endDate || !credentialFile)
{
    snapshot = blockedSearchConsoleSnapshot({
        siteUrl,
        startDate,
        endDate,
        reason: 'site/start/end and FSUSBLOG_SEARCH_CONSOLE_CREDENTIALS_FILE are required'
    });
}
else
{
    try
    {
        const stat = fs.lstatSync(credentialFile);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        {
            throw new Error('credential file must be a regular non-symlink file with mode 0600/0400');
        }
        snapshot = await collectSearchConsole({
            siteUrl,
            startDate,
            endDate,
            credential: readJson(credentialFile),
            inspectionUrls: inspectionFile ? readJson(inspectionFile) : [],
            inspectionLimit: Number(options['inspection-limit'] ?? 25)
        });
    }
    catch (error)
    {
        snapshot = blockedSearchConsoleSnapshot({ siteUrl, startDate, endDate, reason: error.message });
    }
}

writeJson(output, snapshot);
console.log(`[seo-search-console] status=${snapshot.status} cutoff=${snapshot.dataCutoff ?? 'unavailable'} output=${output}`);
if (snapshot.status === 'blocked')
{
    process.exitCode = 2;
}
