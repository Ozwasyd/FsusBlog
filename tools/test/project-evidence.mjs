#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const { projectEvidence } = await import(pathToFileURL(
    path.resolve(import.meta.dirname, '../test-matrix/evidence-projection.mjs')
).href);
const { readEvidenceDocument } = await import(pathToFileURL(
    path.resolve(import.meta.dirname, '../test-matrix/content-addressed-evidence-store.mjs')
).href);

function option(name)
{
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1])
    {
        throw new Error(`--${name} is required`);
    }
    return process.argv[index + 1];
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

try
{
    const catalogPath = path.resolve(option('catalog'));
    const producerPath = path.resolve(option('producer'));
    const outputPath = path.resolve(option('output'));
    const repositoryRoot = path.resolve(option('root'));
    const receipt = projectEvidence({
        catalog: readJson(catalogPath),
        producerReceipt: readEvidenceDocument(producerPath),
        producerReceiptPath: path.relative(repositoryRoot, producerPath),
        sourceState: {
            commit: option('commit'),
            worktreeFingerprint: option('worktree-fingerprint')
        },
        runId: option('run-id'),
        namespace: option('namespace'),
        repositoryRoot
    });
    writeJsonAtomic(outputPath, receipt);
    process.stdout.write(`[evidence-projection] tier=${receipt.tierId} tests=${receipt.testIds.length} coverage=${receipt.coverageIds.length}\n`);
}
catch (error)
{
    process.stderr.write(`[evidence-projection] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
