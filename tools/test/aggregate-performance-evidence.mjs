#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    assertValidSaturationReport,
    readSaturationPolicy
} from '../perf/performance-saturation-v2.mjs';

import { validateMeasurementNoiseReceipt } from './measurement-noise-envelope.mjs';
import { resolveManifestWorkers } from './run-command-manifest.mjs';

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

export const performanceEvidenceSources = Object.freeze([
    { id: 'load-baseline', path: '.tmp/perf/release-summaries/load-baseline.json' },
    { id: 'load-peak', path: '.tmp/perf/release-summaries/load-expected-peak.json' },
    { id: 'backend-benchmark-regression', path: '.tmp/perf/release-summaries/backend-benchmark-regression.json' },
    {
        id: 'performance-saturation-v2',
        path: '.tmp/perf/release-summaries/performance-saturation-v2.json',
        missingAsBlocked: true
    }
]);

function currentPerformanceEvidenceSources(root)
{
    const performanceRoot = path.resolve(
        process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? path.join(root, '.tmp/perf'));
    return performanceEvidenceSources.map((source) => ({
        ...source,
        path: path.relative(
            root,
            path.join(performanceRoot, 'release-summaries', path.basename(source.path))
        ).replaceAll(path.sep, '/')
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
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (transport)
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8'));
        const matches = (manifest.objects ?? [])
            .flatMap((object) => object.archiveEntries ?? [])
            .map((entry) => path.resolve(root, entry.extractedPath))
            .filter((candidate) => path.basename(candidate) === path.basename(source.path));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`ambiguous ${source.id} performance evidence in transport manifest`);
        if (source.missingAsBlocked) return null;
        throw new Error(`missing ${source.id} performance evidence: ${source.path}`);
    }
    const direct = path.resolve(root, source.path);
    if (!direct.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${source.id} source escapes root`);
    }
    if (fs.existsSync(direct))
    {
        return direct;
    }
    if (source.missingAsBlocked)
    {
        return null;
    }
    throw new Error(`missing ${source.id} performance evidence: ${source.path}`);
}

async function readSummary(root, source)
{
    const absolute = resolveSourceFile(root, source);
    if (absolute === null)
    {
        return {
            id: source.id,
            path: source.path,
            sourceLocation: null,
            status: 'blocked',
            summary: {
                schema: 'fsusblog.performance-saturation-reference.v2',
                status: 'blocked',
                reason: 'capacity certification was not supplied; release capacity conclusions are unavailable'
            }
        };
    }
    let summary;
    try
    {
        summary = JSON.parse(await fs.promises.readFile(absolute, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${source.id} performance evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    {
        throw new Error(`${source.id} performance evidence must be a JSON object`);
    }
    if (typeof summary.status !== 'string' || summary.status.length === 0)
    {
        throw new Error(`${source.id} performance evidence status is missing`);
    }
    if (source.id === 'load-baseline' || source.id === 'load-peak')
    {
        if (summary.schema !== 'fsusblog.qualified-load-profile-summary.v1'
      || summary.qualificationEligible !== true
      || summary.productConclusionEligible !== true
      || !Array.isArray(summary.measurementNoiseAuthoritySequence))
        {
            throw new Error(`${source.id} performance evidence has no qualified measurement authority`);
        }
        validateMeasurementNoiseReceipt(summary.measurementNoiseEnvelope, {
            authoritySequence: summary.measurementNoiseAuthoritySequence
        });
        if (summary.measurementNoiseAuthority?.receiptDigest
      !== summary.measurementNoiseEnvelope.authority.contentDigest)
        {
            throw new Error(`${source.id} performance evidence authority binding is invalid`);
        }
    }
    if (source.id === 'performance-saturation-v2')
    {
        assertValidSaturationReport(summary, {
            expectedCommit: expectedCommitForRoot(root),
            expectedImageDigest: process.env.FSUSBLOG_EXPECTED_IMAGE_DIGEST || undefined,
            expectedPolicy: readSaturationPolicy(path.join(root, 'tests/performance/perf-policy.yml')).policy
        });
    }
    return {
        id: source.id,
        path: source.path,
        sourceLocation: path.relative(root, absolute).replaceAll(path.sep, '/'),
        status: summary.status,
        summary
    };
}

export function resolvePerformanceEvidenceWorkers({
    sourceCount = performanceEvidenceSources.length,
    ...runtime
} = {})
{
    if (!Number.isInteger(sourceCount) || sourceCount <= 0)
    {
        throw new Error('performance evidence source count must be a positive integer');
    }
    return Math.min(sourceCount, resolveManifestWorkers(runtime));
}

async function readAllSummaries(root, sources)
{
    const entries = new Array(sources.length);
    const failures = [];
    const workerCount = resolvePerformanceEvidenceWorkers({ sourceCount: sources.length });
    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () =>
    {
        while (nextIndex < sources.length)
        {
            const index = nextIndex;
            nextIndex += 1;
            try
            {
                entries[index] = await readSummary(root, sources[index]);
            }
            catch (error)
            {
                failures.push({ index, error });
            }
        }
    }));
    if (failures.length > 0)
    {
        failures.sort((left, right) => left.index - right.index);
        const errors = failures.map(({ error }) => error instanceof Error ? error : new Error(String(error)));
        const details = errors.map((error) => error.message).join('; ');
        throw new AggregateError(errors, `${errors.length} performance evidence source(s) failed: ${details}`);
    }
    return entries;
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

function expectedCommitForRoot(root)
{
    const declared = process.env.FSUSBLOG_EXPECTED_COMMIT_SHA || process.env.GITHUB_SHA;
    if (declared)
    {
        return declared;
    }
    try
    {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    }
    catch
    {
        return undefined;
    }
}

export async function aggregatePerformanceEvidence(rootValue = repositoryRoot)
{
    const root = path.resolve(rootValue);
    const sources = currentPerformanceEvidenceSources(root);
    const entries = await readAllSummaries(root, sources);
    const summary = {
        schema: 'fsusblog.performance-evidence-summary.v1',
        status: aggregateStatus(entries),
        requiredEvidenceIds: sources.map((source) => source.id),
        entries,
        generatedAt: new Date().toISOString()
    };
    const output = path.join(
        path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
      ?? path.join(root, '.tmp/release-evidence')),
        'perf-summary.json');
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.next-${process.pid}`;
    await fs.promises.writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`);
    await fs.promises.rename(temporary, output);
    return { output, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        const result = await aggregatePerformanceEvidence(options.root);
        console.log(`[performance-evidence] wrote ${path.relative(options.root, result.output)}`);
    }
    catch (error)
    {
        console.error(`[performance-evidence] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
