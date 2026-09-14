#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {loadCanonicalInventory} = await import(new URL('../test-inventory/api.mjs', import.meta.url));
const {buildQualityArtifact, renderQualitySummary, validateQualityArtifact} = await import(new URL('../test-quality/artifact.mjs', import.meta.url));
const {runConformanceCorpus} = await import(new URL('../test-quality/conformance.mjs', import.meta.url));
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const summaryPath = path.join(root, '.tmp/release-evidence/test-quality-summary.json');
const generatedSummaryPath = path.join(root, '.tmp/release-evidence/test-quality-summary.generated.md');
const oracleFactsPath = path.join(root, '.tmp/release-evidence/test-oracle-facts.json');
const conformancePath = path.join(root, '.tmp/release-evidence/test-quality-conformance.json');

try
{
    if (process.argv.includes('--self-test'))
    {
        const conformance = runConformanceCorpus(root);
        console.log(`[test-quality] self-test ok cases=${conformance.cases.length} mutations=${conformance.killedMutations.length} digest=${conformance.contentDigest}`);
        process.exit(0);
    }
    if (!existsSync(conformancePath))
    {
        throw new Error('canonical conformance artifact is missing; conformance must run before repository facts');
    }
    const conformance = JSON.parse(readFileSync(conformancePath, 'utf8'));
    const inventory = loadCanonicalInventory(root, { requireArtifact: true, runAdapters: false });
    if (!existsSync(oracleFactsPath))
    {
        throw new Error('canonical oracle facts artifact is missing');
    }
    const oracleFacts = JSON.parse(readFileSync(oracleFactsPath, 'utf8'));
    const { artifact } = buildQualityArtifact({ root, inventory, conformance, oracleFacts });
    validateQualityArtifact(artifact, { inventory });
    mkdirSync(path.dirname(summaryPath), { recursive: true });
    if (existsSync(summaryPath))
    {
        const prior = JSON.parse(readFileSync(summaryPath, 'utf8'));
        validateQualityArtifact(prior);
        if (prior.status === 'failed')
        {
            throw new Error(`first failed quality artifact is preserved and cannot be overwritten: ${prior.contentDigest}`);
        }
        throw new Error(`quality attempt artifact already exists and cannot be retry-overwritten: ${prior.contentDigest}`);
    }
    if (existsSync(generatedSummaryPath))
    {
        throw new Error('generated quality summary already exists without its sealed artifact');
    }
    let generatedWritten = false;
    let artifactWritten = false;
    try
    {
        writeFileSync(generatedSummaryPath, renderQualitySummary(artifact), { flag: 'wx' });
        generatedWritten = true;
        writeFileSync(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
        artifactWritten = true;
    }
    catch (error)
    {
        if (artifactWritten)
        {
            rmSync(summaryPath, { force: true });
        }
        if (generatedWritten)
        {
            rmSync(generatedSummaryPath, { force: true });
        }
        throw error;
    }
    console.log(`[test-quality] ${artifact.status} cases=${artifact.cases.length} violations=${artifact.violations.length} digest=${artifact.contentDigest}`);
    if (artifact.status !== 'passed')
    {
        process.exit(1);
    }
}
catch (error)
{
    console.error(`[test-quality] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
