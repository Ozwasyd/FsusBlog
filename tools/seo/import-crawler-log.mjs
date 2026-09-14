#!/usr/bin/env node

import dns from 'node:dns/promises';
import fs from 'node:fs';
import process from 'node:process';

import { importCrawlerEvents, writeJson } from './measurement-lib.mjs';

function args(argv)
{
    const values = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        values[argv[index]?.replace(/^--/u, '')] = argv[index + 1];
    }
    return values;
}

function readNdjson(file)
{
    return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) =>
    {
        try
        {
            return JSON.parse(line);
        }
        catch
        {
            throw new Error(`invalid NDJSON at line ${index + 1}`);
        }
    });
}

const options = args(process.argv.slice(2));
const input = options.input;
const output = options.output ?? '.tmp/seo/verified-crawler-daily.json';
const siteUrl = options.site ?? process.env.FSUSBLOG_SEARCH_CONSOLE_SITE;
const hashKeyFile = process.env.FSUSBLOG_CRAWLER_IP_HASH_KEY_FILE;
if (!input || !siteUrl || !hashKeyFile)
{
    console.error('[seo-crawler] --input, --site and FSUSBLOG_CRAWLER_IP_HASH_KEY_FILE are required');
    process.exit(2);
}
const stat = fs.lstatSync(hashKeyFile);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
{
    console.error('[seo-crawler] hash key file must be a regular non-symlink file with mode 0600/0400');
    process.exit(2);
}
const ipHashKey = fs.readFileSync(hashKeyFile);
if (Buffer.byteLength(ipHashKey) < 32)
{
    console.error('[seo-crawler] hash key must contain at least 32 bytes');
    process.exit(2);
}
const snapshot = await importCrawlerEvents(readNdjson(input), {
    resolver: dns,
    ipHashKey,
    siteUrl
});
writeJson(output, snapshot);
console.log(`[seo-crawler] verified=${snapshot.coverage.verifiedEvents} rejected=${snapshot.coverage.rejectedEvents} output=${output}`);
