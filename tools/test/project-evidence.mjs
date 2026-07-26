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
const {
    releaseBuildIdentity,
    releasePolicyIdentity,
    validateDomainReceiptAgainstReport
} = await import(pathToFileURL(
    path.resolve(import.meta.dirname, '../test-matrix/release-domain-evidence.mjs')
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

function findProducerReceipt(directory, producerId, tierId, { commit, worktreeFingerprint, runId, namespace })
{
    const matches = [];
    const visit = (current) =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }))
        {
            const candidate = path.join(current, entry.name);
            if (entry.isDirectory()) visit(candidate);
            else if (entry.isFile() && entry.name.endsWith('.json'))
            {
                try
                {
                    const document = readEvidenceDocument(candidate);
                    if (document?.schema === 'fsusblog.evidence-producer-receipt.v1'
                        && document.producerId === producerId && document.logicalTierId === tierId && document.runId === runId
                        && document.namespace === namespace && document.sourceState?.commit === commit
                        && document.sourceState?.worktreeFingerprint === worktreeFingerprint.replace(/^sha256:/u, '')) matches.push(candidate);
                }
                catch { /* Non-receipt JSON is not evidence. */ }
            }
        }
    };
    visit(directory);
    if (matches.length !== 1)
    {
        throw new Error(`expected exactly one canonical producer receipt for ${producerId}, found ${matches.length}`);
    }
    return matches[0];
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
    const catalog = readJson(catalogPath);
    const directProducer = process.argv.includes('--producer');
    const producerDirectory = process.argv.includes('--producer-directory');
    if (directProducer === producerDirectory)
    {
        throw new Error('exactly one of --producer or --producer-directory is required');
    }
    const producerPath = directProducer
        ? path.resolve(option('producer'))
        : findProducerReceipt(path.resolve(option('producer-directory')), catalog.projectFrom, catalog.tierId, {
            commit: option('commit'), worktreeFingerprint: option('worktree-fingerprint'),
            runId: option('run-id'), namespace: option('namespace')
        });
    const repositoryRoot = path.resolve(option('root'));
    const outputPath = path.resolve(option('output'));
    const producerReceipt = readEvidenceDocument(producerPath);
    const sourceState = {
        commit: option('commit'),
        worktreeFingerprint: option('worktree-fingerprint')
    };
    const runId = option('run-id');
    const namespace = option('namespace');
    const buildIdentity = catalog.dispositionLedger ? releaseBuildIdentity(repositoryRoot, catalog) : undefined;
    const ledgerPath = catalog.dispositionLedger
        ? path.resolve(repositoryRoot, catalog.dispositionLedger)
        : null;
    const policyIdentity = ledgerPath ? releasePolicyIdentity(ledgerPath) : undefined;
    const receipt = projectEvidence({
        catalog,
        producerReceipt,
        producerReceiptPath: path.relative(repositoryRoot, producerPath),
        sourceState,
        runId,
        namespace,
        buildIdentity,
        policyIdentity,
        repositoryRoot
    });
    if (ledgerPath)
    {
        validateDomainReceiptAgainstReport({
            catalog,
            ledger: readJson(ledgerPath),
            producerReceipt,
            assertionReport: readJson(path.resolve(repositoryRoot, producerReceipt.assertionReport.path)),
            sourceState,
            runId,
            namespace,
            buildIdentity,
            policyIdentity,
            repositoryRoot
        });
    }
    writeJsonAtomic(outputPath, receipt);
    process.stdout.write(`[evidence-projection] tier=${receipt.tierId} tests=${receipt.testIds.length} coverage=${receipt.coverageIds.length}\n`);
}
catch (error)
{
    process.stderr.write(`[evidence-projection] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
