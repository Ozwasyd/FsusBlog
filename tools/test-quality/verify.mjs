#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { loadCanonicalInventory } from '../test-inventory/api.mjs';

import { renderQualitySummary, verifyQualityArtifact } from './artifact.mjs';
import { runConformanceCorpus } from './conformance.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const artifactPath = path.resolve(root, process.argv[2] ?? '.tmp/release-evidence/test-quality-summary.json');
const generatedSummaryPath = path.resolve(root, process.argv[3] ?? '.tmp/release-evidence/test-quality-summary.generated.md');
const oracleFactsPath = path.resolve(root, process.argv[4] ?? '.tmp/release-evidence/test-oracle-facts.json');

try
{
    const inventory = loadCanonicalInventory(root, { requireArtifact: true, runAdapters: false });
    const conformance = runConformanceCorpus(root);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    const oracleFacts = JSON.parse(readFileSync(oracleFactsPath, 'utf8'));
    verifyQualityArtifact({ root, inventory, conformance, artifact, oracleFacts });
    if (readFileSync(generatedSummaryPath, 'utf8') !== renderQualitySummary(artifact))
    {
        throw new Error('generated test-quality summary differs from the sealed artifact');
    }
    console.log(`[test-quality-verifier] ok cases=${artifact.cases.length} digest=${artifact.contentDigest}`);
}
catch (error)
{
    console.error(`[test-quality-verifier] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
