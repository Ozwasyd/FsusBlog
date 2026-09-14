#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(repositoryRoot, 'config/testing/backend-qps-scenario-catalog.json');
const defaultOutDir = path.join(
    process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? path.join(repositoryRoot, '.tmp/perf'),
    'backend-qps');
const releaseEvidenceRoot = process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
  ?? path.join(repositoryRoot, '.tmp/release-evidence');
const defaultSummaryFile = path.join(releaseEvidenceRoot, 'backend-qps-summary.json');
const defaultRuntimeSequentialSummaryFile = path.join(releaseEvidenceRoot, 'backend-qps-runtime-sequential-summary.json');

export const EXPECTED_BACKEND_QPS_MODES = [
    'view-count-flush',
    'visitlog-invalidation',
    'cache-hit',
    'comment-cursor',
    'hotread',
    'cache-miss-singleflight',
    'risk-filter',
    'related-reading',
    'list-pagination',
    'article-detail-miss',
    'cache-registry',
    'cache-invalidation-batch',
    'index-plan'
];

export function loadCatalog(customPath = catalogPath)
{
    if (!fs.existsSync(customPath))
    {
        throw new Error(`missing backend QPS catalog file: ${customPath}`);
    }
    const raw = fs.readFileSync(customPath, 'utf8');
    const catalog = JSON.parse(raw.replace(/^\uFEFF/u, ''));
    if (catalog.schema !== 'fsusblog.backend-qps-scenario-catalog.v1')
    {
        throw new Error(`invalid catalog schema: ${catalog.schema}`);
    }
    if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 13)
    {
        throw new Error(`backend QPS catalog must contain exactly 13 scenarios, found ${catalog.scenarios?.length ?? 0}`);
    }
    const ids = new Set(catalog.scenarios.map((s) => s.id));
    for (const expected of EXPECTED_BACKEND_QPS_MODES)
    {
        if (!ids.has(expected))
        {
            throw new Error(`missing scenario in catalog: ${expected}`);
        }
    }
    return catalog;
}

class StaticSourceCache
{
    constructor(root)
    {
        this.root = root;
        this.cache = new Map();
    }

    getFile(relativePath)
    {
        if (!this.cache.has(relativePath))
        {
            const fullPath = path.join(this.root, relativePath);
            if (!fs.existsSync(fullPath))
            {
                throw new Error(`static invariant target file missing: ${relativePath}`);
            }
            this.cache.get(relativePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            this.cache.set(relativePath, content);
        }
        return this.cache.get(relativePath);
    }

    checkRequiredToken(relativePath, token)
    {
        const content = this.getFile(relativePath);
        return content.includes(token);
    }

    checkForbiddenToken(relativePath, token)
    {
        const content = this.getFile(relativePath);
        return content.includes(token);
    }
}

export function runStaticInvariants(scenario, sourceCache)
{
    const failures = [];
    for (const item of scenario.requiredTokens ?? [])
    {
        try
        {
            if (!sourceCache.checkRequiredToken(item.file, item.token))
            {
                failures.push(`missing token in ${item.file}: ${item.token}`);
            }
        }
        catch (err)
        {
            failures.push(err.message);
        }
    }
    for (const item of scenario.forbiddenTokens ?? [])
    {
        try
        {
            if (sourceCache.checkForbiddenToken(item.file, item.token))
            {
                failures.push(`forbidden token in ${item.file}: ${item.token}`);
            }
        }
        catch (err)
        {
            failures.push(err.message);
        }
    }
    return failures;
}

export function aggregateSummary(options = {})
{
    const outDir = options.outDir || process.env.FSUSBLOG_BACKEND_QPS_OUT_DIR || defaultOutDir;
    const summaryFile = options.summaryFile || process.env.FSUSBLOG_BACKEND_QPS_SUMMARY_FILE || defaultSummaryFile;
    const catalog = options.catalog || loadCatalog(options.catalogPath);
    const generatedAt = new Date().toISOString();

    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });

    const files = [];
    const missing = [];

    for (const mode of EXPECTED_BACKEND_QPS_MODES)
    {
        const file = path.join(outDir, `${mode}.json`);
        if (fs.existsSync(file))
        {
            files.push(file);
        }
        else
        {
            missing.push(mode);
        }
    }

    if (missing.length > 0)
    {
        console.error(`[backend-qps:aggregate] missing collector artifact(s): ${missing.join(' ')}`);
        if (options.failOnMissing !== false)
        {
            throw new Error(`missing collector artifacts: ${missing.join(', ')}`);
        }
    }

    const results = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')));
    const summary = {
        status: results.some((item) => item.status !== 'ok') || missing.length > 0 ? 'blocked' : 'ok',
        generatedAt,
        performance_baseline: results.find((item) => item.performance_baseline != null)?.performance_baseline ?? null,
        optional_deployment_layer: results.find((item) => item.optional_deployment_layer != null)?.optional_deployment_layer ?? null,
        artifactDir: path.relative(repositoryRoot, defaultOutDir).replaceAll(path.sep, '/'),
        expectedModes: EXPECTED_BACKEND_QPS_MODES,
        resultCount: results.length,
        evidenceModel: 'static-implementation-plus-runtime-measurement',
        staticEvidenceResults: results.map((item) => item.staticEvidence ?? null),
        runtimeMeasurementResults: results.map((item) => item.runtimeMeasurement ?? null),
        capacityConclusion: {
            countedAsCapacity: false,
            reason: 'backend-qps summary separates static implementation evidence from runtime probes; capacity conclusions come from load or benchmark lanes'
        },
        results
    };

    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[backend-qps:aggregate] wrote ${summaryFile}`);
    return summary;
}

export function executeScenarioProbe(mode, artifactPath)
{
    const probeScript = path.join(repositoryRoot, 'tools/test/lanes/runtime-evidence-probe.mjs');
    const nodeBin = process.env.FSUSBLOG_NODE || 'node';
    const result = spawnSync(nodeBin, [probeScript, 'backend-qps', mode, artifactPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env
    });

    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        console.error(`[backend-qps:${mode}] probe execution failed: ${result.stderr || result.stdout}`);
    }
}

export function executeRuntimeSequential(options = {})
{
    const outDir = options.outDir || process.env.FSUSBLOG_BACKEND_QPS_OUT_DIR || defaultOutDir;
    const runtimeSequentialSummaryFile = options.runtimeSequentialSummaryFile || process.env.FSUSBLOG_BACKEND_QPS_RUNTIME_SEQUENTIAL_SUMMARY_FILE || defaultRuntimeSequentialSummaryFile;

    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(path.dirname(runtimeSequentialSummaryFile), { recursive: true });

    const artifact = path.join(outDir, 'runtime-sequential.json');
    const probeScript = path.join(repositoryRoot, 'tools/test/lanes/runtime-evidence-probe.mjs');
    const nodeBin = process.env.FSUSBLOG_NODE || 'node';
    const result = spawnSync(nodeBin, [probeScript, 'backend-qps-sequential', artifact], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env
    });

    if (result.error)
    {
        throw result.error;
    }
    if (result.status !== 0)
    {
        throw new Error(`runtime sequential probe failed: ${result.stderr || result.stdout}`);
    }

    fs.copyFileSync(artifact, runtimeSequentialSummaryFile);
    console.log(`[backend-qps:runtime-sequential] wrote ${artifact} and ${runtimeSequentialSummaryFile}`);
}

export function runScenario(scenarioId, options = {})
{
    const catalog = options.catalog || loadCatalog(options.catalogPath);
    const scenario = catalog.scenarios.find((s) => s.id === scenarioId);
    if (!scenario)
    {
        throw new Error(`unknown backend QPS scenario: ${scenarioId}`);
    }

    const sourceCache = options.sourceCache || new StaticSourceCache(repositoryRoot);
    const outDir = options.outDir || process.env.FSUSBLOG_BACKEND_QPS_OUT_DIR || defaultOutDir;
    fs.mkdirSync(outDir, { recursive: true });

    const artifact = path.join(outDir, `${scenarioId}.json`);
    const staticFailures = runStaticInvariants(scenario, sourceCache);

    if (staticFailures.length > 0)
    {
        console.error(`[backend-qps:${scenarioId}] static invariant failures:\n${staticFailures.join('\n')}`);
    }

    executeScenarioProbe(scenarioId, artifact);

    if (fs.existsSync(artifact))
    {
        const data = JSON.parse(fs.readFileSync(artifact, 'utf8').replace(/^\uFEFF/u, ''));
        data.route = scenario.route;
        data.mode = scenario.trafficMode;
        data.generatedAt = new Date().toISOString();
        data.checks = scenario.checks;
        data.staticEvidence = {
            status: staticFailures.length === 0 ? 'ok' : 'blocked',
            evidenceType: 'static-implementation-evidence',
            checks: scenario.checks,
            failures: staticFailures
        };
        data.staticImplementationChecks = scenario.checks;
        if (staticFailures.length > 0)
        {
            data.status = 'blocked';
        }
        fs.writeFileSync(artifact, `${JSON.stringify(data, null, 2)}\n`);
    }
    else
    {
        const errorData = {
            status: 'blocked',
            scenario: scenarioId,
            evidenceType: 'backend-qps-collector-evidence',
            route: scenario.route,
            generatedAt: new Date().toISOString(),
            checks: scenario.checks,
            staticEvidence: {
                status: staticFailures.length === 0 ? 'ok' : 'blocked',
                evidenceType: 'static-implementation-evidence',
                checks: scenario.checks,
                failures: staticFailures
            },
            runtimeMeasurement: {
                status: 'blocked',
                error: 'probe_artifact_missing'
            }
        };
        fs.writeFileSync(artifact, `${JSON.stringify(errorData, null, 2)}\n`);
    }

    console.log(`[backend-qps:${scenarioId}] wrote ${artifact}`);
    return artifact;
}

export function runAllScenarios(options = {})
{
    const catalog = options.catalog || loadCatalog(options.catalogPath);
    const sourceCache = new StaticSourceCache(repositoryRoot);
    const blockedScenarios = [];

    let interrupted = false;
    const sigHandler = (sig) =>
    {
        interrupted = true;
        console.error(`[backend-qps-driver] caught ${sig}, writing partial evidence...`);
        try
        {
            aggregateSummary({ ...options, catalog, failOnMissing: false });
        }
        catch
        {
            // ignore in interrupt
        }
        process.exit(130);
    };

    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);

    for (const scenario of catalog.scenarios)
    {
        if (interrupted)
        {
            break;
        }
        try
        {
            runScenario(scenario.id, { ...options, catalog, sourceCache });
        }
        catch (err)
        {
            console.error(`[backend-qps:${scenario.id}] scenario failed: ${err.message}`);
            blockedScenarios.push(scenario.id);
        }
    }

    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);

    const summary = aggregateSummary({ ...options, catalog, failOnMissing: false });
    return {
        summary,
        blockedScenarios
    };
}

function main()
{
    const args = process.argv.slice(2);
    if (args.includes('--validate-catalog'))
    {
        const catalog = loadCatalog();
        console.log(`[backend-qps-catalog] valid catalog schema=${catalog.schema} count=${catalog.scenarios.length}`);
        process.exit(0);
    }

    const modeArg = args.find((a) => !a.startsWith('--'));
    const scenarioFlagIndex = args.indexOf('--scenario');
    const scenarioArg = scenarioFlagIndex >= 0 ? args[scenarioFlagIndex + 1] : modeArg;

    if (!scenarioArg)
    {
        runAllScenarios();
        process.exit(0);
    }

    if (scenarioArg === 'aggregate')
    {
        aggregateSummary();
        process.exit(0);
    }

    if (scenarioArg === 'backend-qps-runtime-sequential' || scenarioArg === 'runtime-sequential')
    {
        executeRuntimeSequential();
        process.exit(0);
    }

    runScenario(scenarioArg);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (err)
    {
        console.error(`[backend-qps-driver] error: ${err.message}`);
        process.exit(1);
    }
}
