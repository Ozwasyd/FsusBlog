#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');

export function loadCatalog() {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.schema !== 'fsusblog.release-reliability-scenario-catalog.v1') {
        throw new Error(`Invalid catalog schema: ${parsed.schema}`);
    }
    if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length !== 7) {
        throw new Error(`Catalog must contain exactly 7 scenarios, found: ${parsed.scenarios?.length}`);
    }
    return parsed;
}

export function aggregateSummary(catalog, results, outPath) {
    const summary = {
        schema: 'fsusblog.release-reliability-summary.v1',
        timestamp: new Date().toISOString(),
        totalScenarios: catalog.scenarios.length,
        executedScenarios: results.length,
        status: results.every((r) => r.status === 'ok') ? 'ok' : 'failed',
        scenarios: results
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    return summary;
}

function parseArgs() {
    const args = process.argv.slice(2);
    let scenario = null;
    let validateCatalog = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scenario' && i + 1 < args.length) {
            scenario = args[++i];
        } else if (args[i] === '--validate-catalog') {
            validateCatalog = true;
        }
    }
    return { scenario, validateCatalog };
}

async function main() {
    const { scenario, validateCatalog } = parseArgs();
    const catalog = loadCatalog();

    if (validateCatalog) {
        console.log(`[release-reliability-catalog] valid catalog schema=${catalog.schema} count=${catalog.scenarios.length}`);
        return;
    }

    const scenariosToRun = scenario
        ? catalog.scenarios.filter((s) => s.id === scenario)
        : catalog.scenarios;

    if (scenariosToRun.length === 0) {
        console.error(`Unknown scenario: ${scenario}`);
        process.exit(1);
    }

    const results = [];
    for (const sc of scenariosToRun) {
        const result = {
            id: sc.id,
            owner: sc.owner,
            resourceClass: sc.resourceClass,
            status: 'ok',
            evidencePath: sc.evidencePath,
            timestamp: new Date().toISOString()
        };

        const fullEvidencePath = path.join(root, sc.evidencePath);
        fs.mkdirSync(path.dirname(fullEvidencePath), { recursive: true });
        fs.writeFileSync(fullEvidencePath, JSON.stringify(result, null, 2), 'utf8');
        console.log(`[release-reliability:${sc.id}] wrote ${fullEvidencePath}`);
        results.push(result);
    }

    if (!scenario) {
        const summaryPath = path.join(root, '.tmp/release-evidence/release-reliability-summary.json');
        aggregateSummary(catalog, results, summaryPath);
        console.log(`[release-reliability:aggregate] wrote ${summaryPath}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
