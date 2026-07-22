#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {
    createCrossStackOwnerReceipt,
    joinCrossStackReceipts,
    validateCrossStackOwnershipRegistry
} = await import(pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../test-matrix/cross-stack-receipts.mjs'
)).href);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(repositoryRoot, 'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json');

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function identity()
{
    return {
        sourceState: {
            commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
            worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        },
        runId: process.env.FSUSBLOG_TEST_RUN_ID,
        namespace: process.env.FSUSBLOG_TEST_NAMESPACE
    };
}

function ownerDirectory(runId)
{
    return path.join(repositoryRoot, '.tmp/test-results/cross-stack', runId, 'owners');
}

export function writeCurrentRunOwnerReceipt(owner)
{
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const current = identity();
    const receipt = createCrossStackOwnerReceipt({
        registry,
        owner,
        repositoryRoot,
        ...current
    });
    const output = path.join(ownerDirectory(current.runId), `${owner}.json`);
    writeJsonAtomic(output, receipt);
    return { output, receipt };
}

function sleep(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOwnerReceipts(registry, runId)
{
    const owners = [...new Set(validateCrossStackOwnershipRegistry(registry).assertions.map((entry) => entry.canonicalOwner))].sort();
    const directory = ownerDirectory(runId);
    const deadlineAt = Number(process.env.FSUSBLOG_EXECUTION_DEADLINE_AT_MS ?? Date.now() + 20 * 60_000);
    while (Date.now() < deadlineAt)
    {
        const missing = owners.filter((owner) => !fs.existsSync(path.join(directory, `${owner}.json`)));
        if (missing.length === 0)
        {
            return owners.map((owner) => JSON.parse(fs.readFileSync(path.join(directory, `${owner}.json`), 'utf8')));
        }
        await sleep(250);
    }
    const missing = owners.filter((owner) => !fs.existsSync(path.join(directory, `${owner}.json`)));
    throw new Error(`timed out waiting for current-run cross-stack owner receipts: ${missing.join(', ')}`);
}

async function main(argv)
{
    const mode = argv[0];
    if (mode === 'owner')
    {
        const owner = argv[1];
        const result = writeCurrentRunOwnerReceipt(owner);
        process.stdout.write(`[cross-stack-owner] owner=${owner} assertions=${result.receipt.assertions.length} receipt=${path.relative(repositoryRoot, result.output)}\n`);
        return;
    }
    if (mode === 'join')
    {
        const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        const current = identity();
        const receipts = await readOwnerReceipts(registry, current.runId);
        const receipt = joinCrossStackReceipts({
            registry,
            ownerReceipts: receipts,
            repositoryRoot,
            ...current
        });
        const output = path.join(repositoryRoot, '.tmp/release-evidence/cross-stack-contract.json');
        writeJsonAtomic(output, receipt);
        process.stdout.write(`[cross-stack-join] assertions=${receipt.assertions.length} owners=${receipt.ownerReceipts.length} receipt=${path.relative(repositoryRoot, output)}\n`);
        return;
    }
    throw new Error('usage: cross-stack-receipts.mjs owner <owner-id> | join');
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    main(process.argv.slice(2)).catch((error) =>
    {
        process.stderr.write(`[cross-stack-receipts] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
