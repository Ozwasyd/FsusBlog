#!/usr/bin/env node
import {
    existsSync,
    readFileSync,
    readdirSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTemporalLedger, TemporalContractError } from './temporal-context.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const producerBindingsPath = path.join(
    repositoryRoot,
    'config/testing/temporal-producer-bindings.json'
);
const fixtureInventoryPath = path.join(
    repositoryRoot,
    'config/testing/fixture-consumer-inventory.generated.json'
);

export const clockApiPatterns = Object.freeze([
    ['Date.now', /\bDate\.now\s*\(\s*\)/gu],
    ['new Date()', /\bnew\s+Date\s*\(\s*\)/gu],
    ['new Date(value)', /\bnew\s+Date\s*\(\s*[^)\s][^)]*\)/gu],
    ['Temporal.Now', /\bTemporal\.Now\.[A-Za-z]+\s*\(/gu],
    ['DateTime.UtcNow', /\bDateTime\.UtcNow\b/gu],
    ['DateTime.Now', /\bDateTime\.Now\b/gu],
    ['DateTime.Today', /\bDateTime\.Today\b/gu],
    ['DateTimeOffset.UtcNow', /\bDateTimeOffset\.UtcNow\b/gu],
    ['DateTimeOffset.Now', /\bDateTimeOffset\.Now\b/gu],
    ['TimeProvider.System', /\bTimeProvider\.System\b/gu],
    ['clock_timestamp', /\bclock_timestamp\s*\(\s*\)/giu],
    ['statement_timestamp', /\bstatement_timestamp\s*\(\s*\)/giu],
    ['transaction_timestamp', /\btransaction_timestamp\s*\(\s*\)/giu],
    ['timeofday', /\btimeofday\s*\(\s*\)/giu],
    ['postgres.now', /(?<![.\w])now\s*\(\s*\)/giu],
    ['CURRENT_TIMESTAMP', /\bCURRENT_TIMESTAMP\b/giu],
    ['CURRENT_DATE_TIME', /\b(?:CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP)\b/giu],
    ['file-timestamp', /\.(?:mtime|mtimeMs|mtimeNs|ctime|ctimeMs|birthtime|birthtimeMs)\b/gu],
    ['performance.now', /\bperformance\.now\s*\(\s*\)/gu],
    ['performance.timeOrigin', /\bperformance\.timeOrigin\b/gu],
    ['process.hrtime.bigint', /\bprocess\.hrtime\.bigint\s*\(\s*\)/gu],
    ['process.hrtime', /\bprocess\.hrtime\s*\(\s*[^)]*\)/gu],
    ['process.uptime', /\bprocess\.uptime\s*\(\s*\)/gu],
    ['Environment.TickCount64', /\bEnvironment\.TickCount64\b/gu],
    ['Stopwatch', /\bStopwatch\.(?:StartNew|GetTimestamp|GetElapsedTime)\s*\(/gu],
    ['setTimeout', /\bsetTimeout\s*\(/gu],
    ['AbortSignal.timeout', /\bAbortSignal\.timeout\s*\(/gu],
    ['pg_sleep', /\bpg_sleep\s*\(/giu],
    ['shell.date', /(?:^|[;&|][ \t]*)date(?:[ \t]+[^()\n]*)?(?=$|[;&|])/gmu],
    ['shell.epoch-seconds', /\$(?:EPOCHREALTIME|EPOCHSECONDS|SECONDS)\b/gu],
    ['shell.sleep', /(?:^|[;&|][ \t]*)sleep[ \t]+[0-9]+(?:\.[0-9]+)?(?=$|[;&|])/gmu]
]);

const repositoryScanRoots = Object.freeze(['src', 'tests', 'tools']);
const repositoryScanExtension = /\.(?:c|cc|cjs|cpp|cs|cxx|js|mjs|ps1|sh|sql|ts|tsx|vue)$/u;
const repositoryScanExcludedDirectories = new Set([
    '.git',
    '.tmp',
    'artifacts',
    'bin',
    'dist',
    'node_modules',
    'obj'
]);

function fail(reasonCode, message, details = {})
{
    throw new TemporalContractError(reasonCode, message, details);
}

function occurrences(source)
{
    const found = [];
    for (const [api, pattern] of clockApiPatterns)
    {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern))
        {
            found.push({ api, index: match.index, text: match[0] });
        }
    }
    return found.sort((left, right) => left.index - right.index || left.api.localeCompare(right.api));
}

function isCorrectnessTemporalCandidate(sourcePath, source)
{
    const producerDeclaration = /fixture-catalog:[ \t]+producer\b/u.test(source);
    if ((/\.test\.[cm]?[jt]s$/u.test(sourcePath)
      || sourcePath.startsWith('tests/backend/Unit/')
      || sourcePath.startsWith('tests/tools/'))
      && !producerDeclaration)
    {
        return false;
    }
    if (sourcePath === 'tools/test/check-wall-clock-governance.mjs')
    {
        return false;
    }
    return producerDeclaration
    || sourcePath.startsWith('tools/test-fixtures/')
    || sourcePath.startsWith('tools/data-scale/')
    || (sourcePath.startsWith('tests/browser-contract/')
      && !/\.test\.[cm]?[jt]s$/u.test(sourcePath))
    || sourcePath === 'tests/frontend/support/session-fixtures.mjs'
    || /(?:FSUSBLOG_TEMPORAL_CONTEXT_JSON|bindCorrectnessProducerTemporalArtifacts|TestTemporal(?:Runtime)?Context)/u
        .test(source);
}

export function discoverRepositoryTemporalSources({
    root = repositoryRoot,
    sourceOverrides = new Map()
} = {})
{
    const sources = new Map();
    const visit = (relative) =>
    {
        const absolute = path.join(root, relative);
        if (!existsSync(absolute))
        {
            return;
        }
        for (const entry of readdirSync(absolute, { withFileTypes: true }))
        {
            const child = path.posix.join(relative, entry.name);
            if (entry.isDirectory())
            {
                if (!repositoryScanExcludedDirectories.has(entry.name))
                {
                    visit(child);
                }
            }
            else if (repositoryScanExtension.test(entry.name))
            {
                const source = sourceOverrides.get(child)
          ?? readFileSync(path.join(root, child), 'utf8');
                if (isCorrectnessTemporalCandidate(child, source)
            && occurrences(source).length > 0)
                {
                    sources.set(child, source);
                }
            }
        }
    };
    for (const scanRoot of repositoryScanRoots)
    {
        visit(scanRoot);
    }
    for (const [sourcePath, source] of sourceOverrides)
    {
        if (isCorrectnessTemporalCandidate(sourcePath, source)
        && occurrences(source).length > 0)
        {
            sources.set(sourcePath, source);
        }
    }
    return sources;
}

export function validateWallClockGovernance({ ledger, sources })
{
    const unresolved = ledger.entries.filter((entry) =>
        entry.disposition === 'unknown' || entry.disposition === 'requires-explicit');
    if (unresolved.length > 0)
    {
        fail('temporal.ledger-unresolved', 'ledger contains unresolved dispositions', {
            callSiteIds: unresolved.map((entry) => entry.callSiteId)
        });
    }

    const governed = new Set(ledger.governedSources);
    const duplicateSources = ledger.governedSources.filter((source, index) =>
        ledger.governedSources.indexOf(source) !== index);
    if (duplicateSources.length > 0)
    {
        fail('temporal.ledger-source-mismatch', 'governedSources contains duplicates', { duplicateSources });
    }
    for (const entry of ledger.entries)
    {
        if (!governed.has(entry.path))
        {
            fail('temporal.ledger-source-mismatch', `${entry.callSiteId} path is outside governedSources`);
        }
        if (entry.clockKind === 'business-wall'
        && (entry.authorityKind !== 'canonical-business-epoch' || entry.ingress !== 'canonical-injected'))
        {
            fail('temporal.context-invalid', `${entry.callSiteId} business clock lacks canonical injection`);
        }
        if (entry.clockKind === 'monotonic-measurement'
        && (entry.authorityKind !== 'runtime-monotonic' || entry.ingress !== 'runtime-monotonic'))
        {
            fail('temporal.mixed-clock', `${entry.callSiteId} measurement clock is not runtime monotonic`);
        }
        if (entry.api === 'file-timestamp' && entry.ingress !== 'operability-only')
        {
            fail('temporal.context-invalid', `${entry.callSiteId} mtime may only support operability`);
        }
    }

    const entriesByPath = Map.groupBy(ledger.entries, (entry) => entry.path);
    for (const sourcePath of governed)
    {
        const source = sources.get(sourcePath);
        if (typeof source !== 'string')
        {
            fail('temporal.ledger-source-mismatch', `governed source is missing: ${sourcePath}`);
        }
        const discovered = occurrences(source);
        const entries = entriesByPath.get(sourcePath) ?? [];
        const covered = new Set();
        for (const entry of entries)
        {
            const first = source.indexOf(entry.sourceAnchor);
            const second = first < 0 ? -1 : source.indexOf(entry.sourceAnchor, first + entry.sourceAnchor.length);
            if (first < 0 || second >= 0)
            {
                fail('temporal.ledger-source-mismatch', `${entry.callSiteId} sourceAnchor must resolve exactly once`);
            }
            const matching = discovered.filter((candidate) =>
                candidate.api === entry.api
        && candidate.index >= first
        && candidate.index < first + entry.sourceAnchor.length);
            if (matching.length !== 1)
            {
                fail('temporal.ledger-source-mismatch', `${entry.callSiteId} does not bind exactly one ${entry.api} call`);
            }
            const key = `${matching[0].api}:${matching[0].index}`;
            if (covered.has(key))
            {
                fail('temporal.ledger-source-mismatch', `clock call has duplicate owners: ${sourcePath}:${key}`);
            }
            covered.add(key);
        }
        const uncovered = discovered.filter((candidate) => !covered.has(`${candidate.api}:${candidate.index}`));
        if (uncovered.length > 0)
        {
            fail('temporal.ledger-unresolved', `governed source has unowned clock calls: ${sourcePath}`, { uncovered });
        }
    }

    const mixedSymbols = [...Map.groupBy(ledger.entries, (entry) => `${entry.path}#${entry.symbol}`)]
        .filter(([, entries]) => new Set(entries.map((entry) => entry.clockKind)).size > 1)
        .map(([symbol]) => symbol);
    if (mixedSymbols.length > 0)
    {
        fail('temporal.mixed-clock', 'symbols mix temporal clock kinds', { mixedSymbols });
    }

    return {
        callSiteCount: ledger.entries.length,
        mixedClockCount: 0,
        pendingCount: 0,
        unknownCount: 0,
        governedSourceCount: governed.size
    };
}

export function verifyRepositoryWallClockGovernance({
    independentlyDiscoveredSources = discoverRepositoryTemporalSources()
} = {})
{
    const { document } = readTemporalLedger();
    const bindings = JSON.parse(readFileSync(producerBindingsPath, 'utf8'));
    const inventory = JSON.parse(readFileSync(fixtureInventoryPath, 'utf8'));
    const requiredClosure = new Set([
        ...inventory.producerImplementations.map((row) => row.source),
        ...(bindings.executionBoundarySources ?? []),
        ...independentlyDiscoveredSources.keys(),
        'tools/test/temporal-context.mjs',
        'tools/test/produce-temporal-qualification.mjs',
        'tools/test/run-deterministic-command.mjs'
    ]);
    const governed = new Set(document.governedSources);
    const missing = [...requiredClosure].filter((source) => !governed.has(source)).sort();
    const unexpected = [...governed].filter((source) => !requiredClosure.has(source)).sort();
    if (missing.length > 0 || unexpected.length > 0)
    {
        fail('temporal.ledger-source-mismatch', 'temporal ledger does not exact-match producer execution closure', {
            missing,
            unexpected
        });
    }
    const sources = new Map(document.governedSources.map((sourcePath) => [
        sourcePath,
        independentlyDiscoveredSources.get(sourcePath)
      ?? readFileSync(path.join(repositoryRoot, sourcePath), 'utf8')
    ]));
    return validateWallClockGovernance({ ledger: document, sources });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    try
    {
        const result = verifyRepositoryWallClockGovernance();
        process.stdout.write(`[wall-clock-governance] ok callSites=${result.callSiteCount} sources=${result.governedSourceCount} pending=0 unknown=0 mixedClock=0\n`);
    }
    catch (error)
    {
        process.stderr.write(`[wall-clock-governance] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
