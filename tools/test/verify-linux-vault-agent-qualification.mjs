#!/usr/bin/env node

// Issue #2675: independently verifies one sealed Linux filesystem-agent
// qualification receipt and its append-only evidence against the fixed
// manifest in artifacts/article-vault/linux-agent-qualification.json.
// Usage: verify-linux-vault-agent-qualification.mjs --receipt <path>
//        [--evidence <path>] [--manifest <path>]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function fail(pointer, message)
{
    throw new Error(`${pointer}: ${message}`);
}

function readJson(file, pointer)
{
    try
    {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        fail(pointer, `unreadable json: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function owned(file, pointer)
{
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        fail(pointer, 'path escapes repository');
    }
    return absolute;
}

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
        {
            throw new Error('usage: verify-linux-vault-agent-qualification.mjs --receipt <path> [--evidence <path>] [--manifest <path>]');
        }
        options[key.slice(2)] = value;
    }
    return options;
}

function verifyManifest(manifest)
{
    if (manifest?.schema !== 'fsusblog.vault-agent-platform-qualification.v1')
    {
        fail('$.manifest.schema', 'unknown qualification manifest schema');
    }
    if (manifest.issue !== 2675)
    {
        fail('$.manifest.issue', 'manifest is not issue #2675');
    }
    if (manifest.platform !== 'linux')
    {
        fail('$.manifest.platform', 'manifest platform is not linux');
    }
    if (manifest.environment?.kernelInterface !== 'inotify')
    {
        fail('$.manifest.environment.kernelInterface', 'kernel interface must be inotify');
    }
    if (!Array.isArray(manifest.environment?.fileSystem?.acceptedTypes) || manifest.environment.fileSystem.acceptedTypes.length === 0)
    {
        fail('$.manifest.environment.fileSystem.acceptedTypes', 'accepted filesystem list missing');
    }
    if (typeof manifest.identities?.agent !== 'string' || manifest.identities.agent.length === 0)
    {
        fail('$.manifest.identities.agent', 'agent identity missing');
    }
    if (manifest.command !== 'dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore --filter Category=LinuxArticleVaultAgentQualification')
    {
        fail('$.manifest.command', 'sealed command drift');
    }
    if (manifest.evidence?.verifier !== 'node tools/test/verify-linux-vault-agent-qualification.mjs')
    {
        fail('$.manifest.evidence.verifier', 'verifier binding drift');
    }
    if (!Array.isArray(manifest.cases) || manifest.cases.length === 0)
    {
        fail('$.manifest.cases', 'case inventory missing');
    }
    const caseIds = manifest.cases.map((entry) => entry.id);
    if (caseIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)))
    {
        fail('$.manifest.cases[].id', 'case id shape invalid');
    }
    if (new Set(caseIds).size !== caseIds.length)
    {
        fail('$.manifest.cases', 'duplicate case ids');
    }
    for (const [index, entry] of manifest.cases.entries())
    {
        if (typeof entry.testMethod !== 'string' || entry.testMethod.length === 0)
        {
            fail(`$.manifest.cases[${index}].testMethod`, 'test method missing');
        }
        if (!Array.isArray(entry.covers) || entry.covers.length === 0)
        {
            fail(`$.manifest.cases[${index}].covers`, 'coverage list missing');
        }
    }
    for (const layer of manifest.simulatedLayers ?? [])
    {
        if (!Number.isInteger(layer.issue) || layer.issue <= 0 || typeof layer.simulation !== 'string' || layer.simulation.length === 0)
        {
            fail('$.manifest.simulatedLayers[]', 'simulated layer must name its issue and simulation');
        }
    }
    if (!Array.isArray(manifest.warnings) || manifest.warnings.length !== 0)
    {
        fail('$.manifest.warnings', 'sealed manifest must carry zero warnings');
    }
    return new Set(caseIds);
}

function verifyReceiptSeal(raw, receipt)
{
    if (!isSha256(receipt.contentSha256))
    {
        fail('$.receipt.contentSha256', 'content digest missing or malformed');
    }
    // The seal is SHA-256 over the System.Text.Json bytes of the receipt with
    // contentSha256 set to the empty string; it is the trailing property, so the
    // unsealed payload is reconstructed byte-exactly.
    const marker = `"contentSha256":"${receipt.contentSha256}"`;
    const tail = raw.lastIndexOf(marker);
    if (tail === -1 || raw.slice(tail + marker.length).trim() !== '}' || raw.indexOf('"contentSha256"') !== tail)
    {
        fail('$.receipt.contentSha256', 'seal field must appear exactly once as the trailing property');
    }
    const unsealed = `${raw.slice(0, tail)}"contentSha256":""${raw.slice(tail + marker.length)}`;
    if (sha256(Buffer.from(unsealed, 'utf8')) !== receipt.contentSha256)
    {
        fail('$.receipt.contentSha256', 'receipt seal mismatch');
    }
}

function verifyReceipt(receipt, manifest, caseIds)
{
    if (receipt.schema !== 'fsusblog.vault-agent-platform-qualification-receipt.v1')
    {
        fail('$.receipt.schema', 'unknown receipt schema');
    }
    if (receipt.platform !== 'linux')
    {
        fail('$.receipt.platform', 'receipt platform is not linux');
    }
    if (receipt.issue !== manifest.issue)
    {
        fail('$.receipt.issue', 'receipt issue drift');
    }
    if (typeof receipt.run?.runId !== 'string' || !/^run-\d+-\d+$/.test(receipt.run.runId))
    {
        fail('$.receipt.run.runId', 'run identity shape invalid');
    }
    if (!Number.isInteger(receipt.run?.completedAtUnixMs) || receipt.run.completedAtUnixMs <= 0)
    {
        fail('$.receipt.run.completedAtUnixMs', 'completion timestamp invalid');
    }

    const environment = receipt.environment;
    const declared = manifest.environment.fileSystem;
    if (typeof environment?.kernelRelease !== 'string' || environment.kernelRelease.length === 0)
    {
        fail('$.receipt.environment.kernelRelease', 'kernel release missing');
    }
    if (!declared.acceptedTypes.includes(environment?.fileSystemType))
    {
        fail('$.receipt.environment.fileSystemType', 'filesystem type is not in the accepted set');
    }
    if (environment.fileSystemType !== declared.type)
    {
        fail('$.receipt.environment.fileSystemType', 'filesystem type drift from manifest');
    }
    if (!Number.isInteger(environment?.mountIdentity) || environment.mountIdentity <= 0)
    {
        fail('$.receipt.environment.mountIdentity', 'mount identity invalid');
    }
    if (environment.caseSensitive !== declared.caseSensitive)
    {
        fail('$.receipt.environment.caseSensitive', 'case sensitivity drift');
    }
    if (environment.unicodeNormalization !== declared.unicodeNormalization)
    {
        fail('$.receipt.environment.unicodeNormalization', 'unicode semantics drift');
    }
    if (!Number.isInteger(environment?.inotifyMaxQueuedEvents) || environment.inotifyMaxQueuedEvents <= 0)
    {
        fail('$.receipt.environment.inotifyMaxQueuedEvents', 'inotify queue bound missing');
    }

    if (receipt.identities?.agent !== manifest.identities.agent)
    {
        fail('$.receipt.identities.agent', 'agent identity drift');
    }
    const expectedProtocols = manifest.identities.protocols;
    const actualProtocols = receipt.identities?.protocols ?? {};
    const expectedKeys = Object.keys(expectedProtocols);
    const actualKeys = Object.keys(actualProtocols);
    if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => actualProtocols[key] !== expectedProtocols[key]))
    {
        fail('$.receipt.identities.protocols', 'protocol identities drift from the manifest');
    }

    if (!Array.isArray(receipt.cases))
    {
        fail('$.receipt.cases', 'case results missing');
    }
    const receiptIds = receipt.cases.map((entry) => entry.id);
    if (receiptIds.length !== caseIds.size || receiptIds.some((id) => !caseIds.has(id)) || new Set(receiptIds).size !== receiptIds.length)
    {
        fail('$.receipt.cases', 'receipt case set differs from the manifest inventory');
    }
    for (const entry of receipt.cases)
    {
        if (entry.result !== 'pass')
        {
            fail(`$.receipt.cases[${entry.id}].result`, 'case did not pass');
        }
        if (!Number.isInteger(entry.checks) || entry.checks <= 0)
        {
            fail(`$.receipt.cases[${entry.id}].checks`, 'check count invalid');
        }
    }
    const checkTotal = receipt.cases.reduce((sum, entry) => sum + entry.checks, 0);
    if (receipt.totals?.cases !== receipt.cases.length || receipt.totals?.checks !== checkTotal || receipt.totals?.failures !== 0)
    {
        fail('$.receipt.totals', 'receipt totals do not recompute');
    }
    if (receipt.firstFailure !== null)
    {
        fail('$.receipt.firstFailure', 'first failure must be empty for a passing qualification');
    }
    if (!Array.isArray(receipt.warnings) || receipt.warnings.length !== 0)
    {
        fail('$.receipt.warnings', 'receipt must carry zero warnings');
    }
    if (!isSha256(receipt.evidenceSha256))
    {
        fail('$.receipt.evidenceSha256', 'evidence digest missing or malformed');
    }
}

function verifyEvidence(raw, receipt, caseIds)
{
    if (sha256(raw) !== receipt.evidenceSha256)
    {
        fail('$.receipt.evidenceSha256', 'evidence bytes do not match the sealed digest');
    }
    const lines = raw.toString('utf8').split('\n').filter((line) => line.length > 0);
    if (lines.length === 0)
    {
        fail('$.evidence', 'evidence is empty');
    }
    const allowedKeys = new Set(['sequence', 'caseId', 'checkId', 'result', 'detail']);
    const perCase = new Map();
    lines.forEach((line, index) =>
    {
        let record;
        try
        {
            record = JSON.parse(line);
        }
        catch
        {
            fail(`$.evidence[${index}]`, 'line is not json; evidence must stay append-only jsonl');
        }
        const keys = Object.keys(record);
        if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key)))
        {
            fail(`$.evidence[${index}]`, 'record carries fields outside the privacy-safe shape');
        }
        if (record.sequence !== index + 1)
        {
            fail(`$.evidence[${index}].sequence`, 'sequence gap or reorder; append-only violated');
        }
        if (!caseIds.has(record.caseId))
        {
            fail(`$.evidence[${index}].caseId`, 'undeclared case id');
        }
        if (typeof record.checkId !== 'string' || record.checkId.length === 0 || record.checkId.length > 256 || record.checkId.includes('\x00'))
        {
            fail(`$.evidence[${index}].checkId`, 'check id must be a bounded identifier');
        }
        if (record.result !== 'pass')
        {
            fail(`$.evidence[${index}].result`, 'a passing qualification cannot contain failed checks');
        }
        if (typeof record.detail !== 'string' || record.detail.length === 0 || record.detail.length > 4096 || record.detail.includes('\x00'))
        {
            fail(`$.evidence[${index}].detail`, 'detail must be a bounded privacy-safe string');
        }
        perCase.set(record.caseId, (perCase.get(record.caseId) ?? 0) + 1);
    });
    for (const entry of receipt.cases)
    {
        if (perCase.get(entry.id) !== entry.checks)
        {
            fail(`$.receipt.cases[${entry.id}].checks`, 'check count differs from evidence');
        }
    }
    return lines.length;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href)
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        if (typeof options.receipt !== 'string')
        {
            fail('$.arguments', '--receipt <path> is required');
        }
        const manifestFile = owned(options.manifest ?? 'artifacts/article-vault/linux-agent-qualification.json', '$.arguments.manifest');
        const receiptFile = owned(options.receipt, '$.arguments.receipt');
        const evidenceFile = owned(options.evidence ?? path.join(path.dirname(options.receipt), 'evidence.jsonl'), '$.arguments.evidence');

        const manifest = readJson(manifestFile, '$.manifest');
        const caseIds = verifyManifest(manifest);
        const receiptRaw = readFileSync(receiptFile, 'utf8');
        const receipt = JSON.parse(receiptRaw);
        verifyReceipt(receipt, manifest, caseIds);
        verifyReceiptSeal(receiptRaw, receipt);
        const recordCount = verifyEvidence(readFileSync(evidenceFile), receipt, caseIds);
        if (path.basename(path.dirname(receiptFile)) !== receipt.run.runId)
        {
            fail('$.receipt.run.runId', 'run identity does not match the evidence directory');
        }

        process.stdout.write(`${JSON.stringify({
            verifier: 'verify-linux-vault-agent-qualification',
            receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/'),
            platform: receipt.platform,
            runId: receipt.run.runId,
            fileSystemType: receipt.environment.fileSystemType,
            kernelRelease: receipt.environment.kernelRelease,
            cases: receipt.totals.cases,
            checks: receipt.totals.checks,
            evidenceRecords: recordCount,
            warnings: 0,
            verified: true
        }, null, 2)}\n`);
    }
    catch (error)
    {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
