#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { collectAuditCoverage } from './test-asset-audit/coverage.mjs';
import { executeAuditLayers, summarizeAuditLayers } from './test-asset-audit/execution.mjs';
import { buildAuditInventory, compareAuditSnapshots } from './test-asset-audit/inventory.mjs';
import { detectAuditPreflight } from './test-asset-audit/preflight.mjs';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const profilePath = path.join(root, 'config/testing/test-asset-audit-profile.json');
const auditRoot = path.resolve(process.env.FSUSBLOG_TEST_ASSET_AUDIT_DIR || path.join(root, '.tmp/test-asset-audit'));

function parseArgs(argv)
{
    const options = { phase: 'full', out: path.join(auditRoot, 'report.json'), baseline: null, auditInput: null, layers: null };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--phase')
        {
            options.phase = argv[++index];
        }
        else if (argument === '--out')
        {
            options.out = path.resolve(root, argv[++index]);
        }
        else if (argument === '--baseline')
        {
            options.baseline = path.resolve(root, argv[++index]);
        }
        else if (argument === '--audit-input')
        {
            options.auditInput = path.resolve(root, argv[++index]);
        }
        else if (argument === '--layers')
        {
            options.layers = argv[++index].split(',').map((entry) => entry.trim()).filter(Boolean);
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    if (!['preflight', 'discovery', 'full'].includes(options.phase))
    {
        throw new Error('--phase must be preflight, discovery, or full');
    }
    return options;
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runDiscovery(runId)
{
    const out = path.join(auditRoot, 'retention.json');
    const result = spawnSync(process.execPath, [
        path.join(root, 'tools/check-test-retention.mjs'),
        '--out', out,
        '--run-id', runId
    ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0)
    {
        throw new Error(String(result.stderr || result.stdout || 'authoritative discovery failed'));
    }
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

async function resolveRetention(options, runId)
{
    if (!options.auditInput)
    {
        return runDiscovery(runId);
    }
    const matrixRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!matrixRunId)
    {
        throw new Error('--audit-input requires FSUSBLOG_TEST_RUN_ID');
    }
    const { loadRetentionAuditInput } = await import(
        new URL('../retention/audit-input.mjs', import.meta.url)
    );
    const retention = await loadRetentionAuditInput({ root, auditInput: options.auditInput });
    if (retention.producer?.runId !== matrixRunId)
    {
        throw new Error('audit input producer run id does not match FSUSBLOG_TEST_RUN_ID');
    }
    return retention;
}

function validateSelectedLayers(profile, selected)
{
    if (!selected)
    {
        return;
    }
    const known = new Set(profile.layers.map((entry) => entry.id));
    const unknown = selected.filter((entry) => !known.has(entry));
    if (unknown.length > 0)
    {
        throw new Error(`unknown audit layers: ${unknown.join(', ')}`);
    }
}

function preflightOutcome(preflight)
{
    const blocked = Object.entries(preflight.capabilities)
        .filter(([, value]) => value.status !== 'ready')
        .map(([id]) => id);
    return { outcome: blocked.length === 0 ? 'passed' : 'blocked', blocked };
}

// BEHAVIOR-OWNER: test-asset-audit-reconciliation
async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    validateSelectedLayers(profile, options.layers);
    const preflight = detectAuditPreflight(root);
    const preflightSummary = preflightOutcome(preflight);
    writeJson(path.join(auditRoot, 'preflight.json'), { ...preflight, ...preflightSummary });
    if (options.phase === 'preflight')
    {
        writeJson(options.out, { ...preflight, ...preflightSummary });
        console.log(`[test-asset-audit] preflight ${preflightSummary.outcome}; blocked=${preflightSummary.blocked.join(',') || 'none'}`);
        if (preflightSummary.outcome !== 'passed')
        {
            process.exitCode = 2;
        }
        return;
    }

    const runId = `test-asset-audit-${preflight.source.commit.slice(0, 12)}-${process.pid}`;
    const retention = await resolveRetention(options, runId);
    const inventory = buildAuditInventory(root, retention, profile);
    if (inventory.errors.length > 0)
    {
        throw new Error(`audit inventory failed:\n${inventory.errors.join('\n')}`);
    }
    writeJson(path.join(auditRoot, 'inventory.json'), inventory);

    let comparisonErrors = [];
    if (options.baseline)
    {
        const beforeReport = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
        const replacements = {
            ...JSON.parse(fs.readFileSync(path.join(root, profile.replacementManifest), 'utf8')),
            tierReplacements: inventory.retention.tierReplacements
        };
        comparisonErrors = compareAuditSnapshots(beforeReport.inventory, inventory, replacements);
    }
    const selected = options.phase === 'discovery' ? [] : options.layers;
    const receipts = executeAuditLayers({ root, profile, preflight, inventory, runId, selectedLayers: selected });
    const summary = summarizeAuditLayers(receipts);
    const currentCoverage = options.phase === 'full'
        ? collectAuditCoverage(root, receipts)
        : { status: 'not-requested', blockedReasons: ['discovery-phase'], backend: null, frontend: null, merged: null };
    if (comparisonErrors.length > 0)
    {
        summary.outcome = 'failed';
    }
    const report = {
        schema: 'fsusblog.test-asset-audit-report.v1',
        generatedAt: new Date().toISOString(),
        runId,
        phase: options.phase,
        source: preflight.source,
        fixedTimeGate: profile.fixedTimeGate,
        preflight: { ...preflight, ...preflightSummary },
        inventory,
        layers: receipts,
        comparison: { baseline: options.baseline ? path.relative(root, options.baseline).split(path.sep).join('/') : null, errors: comparisonErrors },
        coverage: {
            baseline: JSON.parse(fs.readFileSync(path.join(root, profile.coverageBaseline), 'utf8')).coverage,
            current: currentCoverage,
            frontendIncludeUniverse: inventory.frontendCoverageUniverse
        },
        replacementManifest: profile.replacementManifest,
        consumerMapping: Object.fromEntries(profile.layers.map((entry) => [entry.id, entry.producerTier])),
        summary
    };
    writeJson(options.out, report);
    console.log(`[test-asset-audit] ${summary.outcome}; discovered=${summary.totals.discovered} executed=${summary.totals.executed} passed=${summary.totals.passed} failed=${summary.totals.failed} skipped=${summary.totals.skipped} blocked=${summary.totals.blocked}`);
    if (summary.outcome === 'failed')
    {
        process.exitCode = 1;
    }
    else if (summary.outcome === 'blocked')
    {
        process.exitCode = 2;
    }
}

await main();
