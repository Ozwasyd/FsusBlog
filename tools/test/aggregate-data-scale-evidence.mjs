#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { compareQueryTrends } = await import(new URL('../data-scale/query-matrix.mjs', import.meta.url));
const { failedQueryMatrix } = await import(new URL('../data-scale/run-query-matrix.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

export const dataScaleEvidenceSources = Object.freeze([
    { tier: 'scale-xs', path: '.tmp/scale/release-summaries/scale-xs.json' },
    { tier: 'scale-s', path: '.tmp/scale/release-summaries/scale-s.json' }
]);

function currentDataScaleEvidenceSources(root)
{
    const scaleRoot = path.resolve(process.env.FSUSBLOG_DATA_SCALE_ROOT ?? path.join(root, '.tmp/scale'));
    return ['scale-xs', 'scale-s'].map((tier) => ({
        tier,
        path: path.relative(root, path.join(scaleRoot, 'release-summaries', `${tier}.json`))
            .replaceAll(path.sep, '/')
    }));
}

function parseArgs(argv)
{
    const options = { root: repositoryRoot };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--root')
        {
            const value = argv[++index];
            if (!value)
            {
                throw new Error('--root requires a path');
            }
            options.root = path.resolve(value);
        }
        else
        {
            throw new Error(`unknown option: ${argument}`);
        }
    }
    return options;
}

function resolveSourceFile(root, source)
{
    const direct = path.resolve(root, source.path);
    if (!direct.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${source.tier} source escapes root`);
    }
    if (fs.existsSync(direct))
    {
        return direct;
    }
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (transport)
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8'));
        const matches = (manifest.objects ?? [])
            .flatMap((object) => object.archiveEntries ?? [])
            .map((entry) => path.resolve(root, entry.extractedPath))
            .filter((candidate) => path.basename(candidate) === path.basename(source.path));
        if (matches.length === 1)
        {
            return matches[0];
        }
        if (matches.length > 1)
        {
            throw new Error(`ambiguous ${source.tier} data-scale evidence in transport manifest`);
        }
    }
    throw new Error(`missing ${source.tier} data-scale evidence: ${source.path}`);
}

function readSummary(root, source)
{
    const absolute = resolveSourceFile(root, source);
    const summary = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    {
        throw new Error(`${source.tier} data-scale evidence must be a JSON object`);
    }
    if (summary.tier !== source.tier)
    {
        throw new Error(`${source.tier} data-scale evidence tier mismatch: ${String(summary.tier)}`);
    }
    if (typeof summary.status !== 'string' || summary.status.length === 0)
    {
        throw new Error(`${source.tier} data-scale evidence status is missing`);
    }
    const expectedRunIdentity = {
        commit: String(process.env.GITHUB_SHA ?? '').trim(),
        runId: String(process.env.GITHUB_RUN_ID ?? '').trim(),
        runAttempt: String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim(),
        producerJob: String(process.env.FSUSBLOG_DATA_SCALE_PRODUCER_JOB ?? '').trim()
    };
    const identityValues = Object.values(expectedRunIdentity);
    const currentRunIdentityRequired = identityValues.some((value) => value.length > 0);
    if (currentRunIdentityRequired
    && identityValues.some((value) => value.length === 0))
    {
        throw new Error('current run identity is incomplete for required data-scale evidence');
    }
    const observedRunIdentity = summary.runIdentity;
    if (currentRunIdentityRequired && (!observedRunIdentity
    || Object.entries(expectedRunIdentity).some(
        ([field, expected]) => String(observedRunIdentity[field] ?? '') !== expected
    )))
    {
        throw new Error(`${source.tier} data-scale evidence run identity mismatch`);
    }
    return {
        tier: source.tier,
        path: source.path,
        sourceLocation: path.relative(root, absolute).replaceAll(path.sep, '/'),
        status: summary.status,
        summary
    };
}

function aggregateStatus(entries)
{
    if (entries.every((entry) => entry.status === 'ok'))
    {
        return 'ok';
    }
    if (entries.some((entry) => !['ok', 'blocked', 'scheduled'].includes(entry.status)))
    {
        return 'failed';
    }
    if (entries.some((entry) => ['blocked', 'scheduled'].includes(entry.status)))
    {
        return 'blocked';
    }
    return 'ok';
}

export function aggregateDataScaleEvidence(rootValue = repositoryRoot)
{
    const root = path.resolve(rootValue);
    const sources = currentDataScaleEvidenceSources(root);
    const tiers = sources.map((source) => readSummary(root, source));
    const queryMatrices = tiers.map((entry) => entry.summary.observed?.queryMatrix
        ?? failedQueryMatrix(entry.tier, null, 'query matrix missing from current tier summary'));
    try
    {
        const scaleRoot = path.resolve(process.env.FSUSBLOG_DATA_SCALE_ROOT ?? path.join(root, '.tmp/scale'));
        const medium = readSummary(root, { tier: 'scale-m', path: path.relative(root, path.join(scaleRoot, 'release-summaries/scale-m.json')) });
        queryMatrices.push(medium.summary.observed?.queryMatrix ?? failedQueryMatrix('scale-m', null, 'scale-m query matrix missing'));
    }
    catch
    {
        queryMatrices.push(failedQueryMatrix('scale-m', null, 'current scale-m tier summary unavailable'));
    }
    let queryTrends;
    try
    {
        queryTrends = compareQueryTrends(queryMatrices);
        const expectedCommit = String(process.env.GITHUB_SHA ?? '').trim();
        if (expectedCommit && queryMatrices.some((matrix) => matrix.binding?.sourceCommit !== expectedCommit))
        {
            throw new Error('query matrix current source mismatch');
        }
    }
    catch
    {
        queryTrends = { status: 'failed', failures: ['query matrix binding or trend inputs invalid'], results: [] };
    }
    const summary = {
        schema: 'fsusblog.data-scale-evidence-summary.v1',
        status: queryTrends.status === 'ok' ? aggregateStatus(tiers) : 'failed',
        requiredTiers: sources.map((source) => source.tier),
        tiers,
        queryMatrices,
        queryTrends,
        generatedAt: new Date().toISOString()
    };
    const output = path.join(
        path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence')),
        'data-scale-summary.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(temporary, output);
    return { output, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        const result = aggregateDataScaleEvidence(options.root);
        console.log(`[data-scale-evidence] wrote ${path.relative(options.root, result.output)}`);
    }
    catch (error)
    {
        console.error(`[data-scale-evidence] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
