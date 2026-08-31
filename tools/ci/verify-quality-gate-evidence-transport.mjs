#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { qualityGateTransportContext } from './prepare-quality-gate-evidence-transport.mjs';
import {
    EVIDENCE_TRANSPORT_MANIFEST_ENV,
    locateTransportedCurrentRunEvidence
} from '../test/current-run-evidence-transport.mjs';
import { evidenceContentDigest } from '../test/current-run-evidence-locator.mjs';
import { validateEvidenceLocatorRegistry } from '../test/evidence-location-contract.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorities = [{
    id: 'evidence-consumer.ci.check-job-summaries.current-run',
    schema: 'fsusblog.ci.job-summary-collection.v1'
}, {
    id: 'evidence-consumer.ci.check-flaky-evidence.current-run',
    schema: 'fsusblog.ci.flaky-evidence-collection.v1'
}];

function assert(condition, message)
{
    if (!condition) throw new Error(message);
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function assertPhysicalFile(repositoryRoot, relative, label)
{
    const root = path.resolve(repositoryRoot);
    const absolute = path.resolve(root, relative);
    assert(absolute.startsWith(`${root}${path.sep}`), `${label} escapes repository root`);
    let cursor = root;
    for (const segment of path.relative(root, absolute).split(path.sep))
    {
        cursor = path.join(cursor, segment);
        assert(fs.existsSync(cursor), `${label} is missing`);
        const stat = fs.lstatSync(cursor);
        assert(!stat.isSymbolicLink(), `${label} must not traverse a symlink`);
        if (cursor === absolute)
        {
            assert(stat.isFile() && stat.nlink === 1, `${label} must be a single-link regular file`);
        }
        else assert(stat.isDirectory(), `${label} parent must be a directory`);
    }
    return absolute;
}

function resolvePayload({ repositoryRoot, located, expectedSchema })
{
    const object = located.transportObject;
    const referenceEntry = object.archiveEntries.find((entry) => entry.role === 'reference-receipt');
    const payloadEntry = object.archiveEntries.find((entry) => entry.role === 'payload');
    assert(referenceEntry && payloadEntry && object.archiveEntries.length === 2,
        `transport role cardinality mismatch: ${object.authorityId}`);
    const receiptFile = assertPhysicalFile(repositoryRoot, referenceEntry.extractedPath,
        `transport reference ${object.authorityId}`);
    const payloadFile = assertPhysicalFile(repositoryRoot, payloadEntry.extractedPath,
        `transport payload ${object.authorityId}`);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert(receipt.schema === object.receiptSchema, `reference receipt schema mismatch: ${object.authorityId}`);
    assert(receipt.contentDigest === evidenceContentDigest(receipt),
        `reference receipt content digest mismatch: ${object.authorityId}`);
    assert(receipt.payload?.path === payloadEntry.extractedPath,
        `reference receipt payload path mismatch: ${object.authorityId}`);
    assert(receipt.payload?.schema === expectedSchema,
        `reference receipt payload schema mismatch: ${object.authorityId}`);
    assert(receipt.payload?.digest === payloadEntry.digest && digestFile(payloadFile) === payloadEntry.digest,
        `reference receipt payload digest mismatch: ${object.authorityId}`);
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    assert(payload.schema === expectedSchema, `transport payload schema mismatch: ${object.authorityId}`);
    return { receipt: referenceEntry.extractedPath, payload: payloadEntry.extractedPath };
}

export function verifyQualityGateEvidenceTransport({
    repositoryRoot = defaultRepositoryRoot,
    environment = process.env
} = {})
{
    const manifestPath = String(environment[EVIDENCE_TRANSPORT_MANIFEST_ENV] ?? '').trim();
    const expectedDigest = String(environment.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST ?? '').trim();
    assert(manifestPath, `${EVIDENCE_TRANSPORT_MANIFEST_ENV} is required`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(expectedDigest),
        'FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST must be a sha256 digest');
    const context = qualityGateTransportContext(environment);
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    validateEvidenceLocatorRegistry(registry);
    const resolved = {};
    for (const authority of authorities)
    {
        const registryEntry = registry.entries.find((entry) => entry.authorityId === authority.id);
        assert(registryEntry, `evidence locator authority is missing: ${authority.id}`);
        const located = locateTransportedCurrentRunEvidence({ context, registry, registryEntry,
            repositoryRoot, transportManifestPath: manifestPath, expectedManifestDigest: expectedDigest });
        resolved[authority.id] = resolvePayload({ repositoryRoot, located, expectedSchema: authority.schema });
    }
    return { manifestDigest: expectedDigest, resolved };
}

function main()
{
    const result = verifyQualityGateEvidenceTransport();
    if (process.env.GITHUB_OUTPUT)
    {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest_digest=${result.manifestDigest}\n`, { flag: 'a' });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try { main(); }
    catch (error)
    {
        process.stderr.write(`[verify-quality-gate-evidence-transport] ${error.message}\n`);
        process.exitCode = 1;
    }
}
