import fs from 'node:fs';
import path from 'node:path';

import {
    assert, canonical, digest, exactKeys, loadPerformanceRun, readDocument, readRef,
    resolveLocator, runInvalidReasons, seal, verifySeal, writeNew
} from './production-fresh-contract.mjs';
import { classifyPerformanceRun } from './production-fresh-disposition.mjs';

export const cohortSchema = 'fsusblog.production-fresh.performance-cohort.v1';
export const ledgerGenesis = digest({ schema: 'fsusblog.production-fresh.performance-ledger.v1' });

export function distribution(values)
{
    assert(values.length > 0 && values.every(Number.isFinite), 'finite distribution samples required');
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    return { count: values.length, values: [...values], p50: percentile(0.5), p90: percentile(0.9),
        mean, standardDeviation: Math.sqrt(variance), spread: sorted.at(-1) - sorted[0] };
}

/** Validate output parents without creating directories or permitting replacement aliases. */
export function outputPath(root, locator)
{
    const parts = locator?.split('/') ?? [];
    assert(parts.length > 0 && parts.every(part => part && part !== '.' && part !== '..'
        && !/^(?:latest|current|active)$/iu.test(part)) && !path.isAbsolute(locator) && !locator.includes('\\'),
    'explicit output locator required');
    let parent = fs.realpathSync(root);
    for (const part of parts.slice(0, -1))
    {
        parent = path.join(parent, part);
        const stat = fs.lstatSync(parent);
        assert(stat.isDirectory() && !stat.isSymbolicLink(), 'output parent must be regular directory');
    }
    return path.join(parent, parts.at(-1));
}

function eligible(root, locator)
{
    const run = loadPerformanceRun(root, locator);
    const reasons = runInvalidReasons(run);
    assert(reasons.length === 0, `ineligible baseline run: ${reasons.join(',')}`);
    const classification = classifyPerformanceRun(root, run);
    assert(classification.status === 'classified', `ineligible baseline classification: ${classification.reasons.join(',')}`);
    for (const metric of classification.metrics)
    {
        if (metric.required && !['swapBytes', 'oomCount', 'resourceKillCount', 'benchmarkCv'].includes(metric.name))
        {
            assert(Number.isFinite(run.noise.floors[metric.name]), `missing baseline machine noise floor: ${metric.name}`);
        }
    }
    return { run, classification };
}

function ledgerEntries(root, locator)
{
    const bytes = fs.readFileSync(resolveLocator(root, locator), 'utf8');
    assert(bytes === '' || bytes.endsWith('\n'), 'partial append-only ledger write');
    const entries = bytes === '' ? [] : bytes.slice(0, -1).split('\n').map(line => JSON.parse(line));
    let previous = ledgerGenesis;
    const receipts = new Set();
    const runIds = new Set();
    let identityDigest = null;
    for (const [index, entry] of entries.entries())
    {
        exactKeys(entry, ['schema', 'sequence', 'previous', 'identityDigest', 'runRef', 'runId', 'digest'], 'ledger entry');
        verifySeal(entry, 'fsusblog.production-fresh.performance-ledger-entry.v1');
        assert(entry.sequence === index + 1 && entry.previous === previous, 'append-only ledger chain/sequence mismatch');
        assert(!receipts.has(entry.runRef.sha256) && !runIds.has(entry.runId), 'duplicate receipt/run');
        assert(identityDigest === null || entry.identityDigest === identityDigest, 'cross-identity ledger');
        readRef(root, entry.runRef);
        const { run } = eligible(root, entry.runRef.locator);
        assert(run.identityDigest === entry.identityDigest && run.receipt.binding.runId === entry.runId, 'ledger identity mismatch');
        receipts.add(entry.runRef.sha256);
        runIds.add(entry.runId);
        identityDigest = entry.identityDigest;
        previous = entry.digest;
    }
    return { entries, head: previous, identityDigest };
}

function createSnapshot(root, ledgerLocator, entries)
{
    assert(entries.length >= 3, 'baseline requires at least three clean first-attempt runs');
    const classifications = entries.map(entry => eligible(root, entry.runRef.locator).classification);
    const identities = classifications[0].metrics.map(metric => metric.name === 'longestUnproductiveMs'
        ? metric.name : canonical([metric.bundleId, metric.stepId, metric.name]));
    assert(classifications.every(item => canonical(item.metrics.map(metric => metric.name === 'longestUnproductiveMs'
        ? metric.name : canonical([metric.bundleId, metric.stepId, metric.name]))) === canonical(identities)), 'cohort metric roster drift');
    const statistics = classifications[0].metrics.map((metric, index) => ({
        bundleId: metric.bundleId, stepId: metric.stepId, name: metric.name, disposition: metric.disposition,
        required: metric.required, status: metric.status,
        distribution: metric.status === 'measured' ? distribution(classifications.map(item => item.metrics[index].value)) : null
    }));
    return seal({ schema: cohortSchema, identityDigest: entries[0].identityDigest,
        ledger: { locator: ledgerLocator, length: entries.length, head: entries.at(-1).digest },
        runs: entries.map(entry => entry.runRef), statistics });
}

/** Lock + append + fsync; all valid samples retained. expectedHead is an external previous anchor. */
export function captureCohort({ root, ledgerLocator, runLocators, expectedHead, outputLocator })
{
    assert(Array.isArray(runLocators) && runLocators.length > 0, 'explicit run locators required');
    assert(/^[a-f0-9]{64}$/u.test(expectedHead), 'explicit previous ledger head required');
    const ledger = outputPath(root, ledgerLocator);
    const output = outputPath(root, outputLocator);
    assert(!fs.existsSync(output), 'cohort snapshot already exists');
    const lock = `${ledger}.lock`;
    const lockFd = fs.openSync(lock, 'wx', 0o600);
    try
    {
        if (!fs.existsSync(ledger))
        {
            assert(expectedHead === ledgerGenesis, 'missing ledger cannot replace anchored history');
            const fd = fs.openSync(ledger, 'wx', 0o600);
            fs.closeSync(fd);
        }
        const previous = ledgerEntries(root, ledgerLocator);
        assert(previous.head === expectedHead, 'ledger anchor mismatch; replacement/truncation/concurrent append');
        const entries = [...previous.entries];
        const appended = [];
        for (const locator of runLocators)
        {
            const { run } = eligible(root, locator);
            assert(entries.every(entry => entry.runRef.sha256 !== run.ref.sha256 && entry.runId !== run.receipt.binding.runId),
                'duplicate receipt/run');
            assert(entries.length === 0 || entries[0].identityDigest === run.identityDigest, 'machine/plan/toolchain/policy identity drift');
            const entry = seal({ schema: 'fsusblog.production-fresh.performance-ledger-entry.v1', sequence: entries.length + 1,
                previous: entries.at(-1)?.digest ?? ledgerGenesis, identityDigest: run.identityDigest,
                runRef: run.ref, runId: run.receipt.binding.runId });
            entries.push(entry);
            appended.push(entry);
        }
        const snapshot = createSnapshot(root, ledgerLocator, entries);
        const fd = fs.openSync(ledger, 'a');
        try
        {
            fs.writeFileSync(fd, appended.map(entry => `${JSON.stringify(entry)}\n`).join(''));
            fs.fsyncSync(fd);
        }
        finally
        {
            fs.closeSync(fd);
        }
        writeNew(output, snapshot);
        return snapshot;
    }
    finally
    {
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

/** Recomputes identity, eligibility, provenance, all statistics and the anchored ledger prefix. */
export function inspectCohort(root, locator)
{
    const { value, ref } = readDocument(root, locator);
    verifySeal(value, cohortSchema);
    exactKeys(value, ['schema', 'identityDigest', 'ledger', 'runs', 'statistics', 'digest'], 'cohort');
    exactKeys(value.ledger, ['locator', 'length', 'head'], 'cohort ledger');
    assert(Number.isSafeInteger(value.ledger.length) && value.ledger.length >= 3, 'insufficient cohort');
    const { entries } = ledgerEntries(root, value.ledger.locator);
    assert(entries.length >= value.ledger.length, 'append-only ledger truncated');
    const prefix = entries.slice(0, value.ledger.length);
    assert(prefix.at(-1).digest === value.ledger.head, 'append-only ledger anchor tampered');
    const recomputed = createSnapshot(root, value.ledger.locator, prefix);
    assert(canonical(recomputed) === canonical(value), 'cohort distribution/provenance tampered');
    return { cohort: value, ref, runs: prefix.map(entry => loadPerformanceRun(root, entry.runRef.locator)) };
}
