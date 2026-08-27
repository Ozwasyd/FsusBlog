#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sealContentDigest } from './attempt-provenance.mjs';
import {
    hiddenRetryScannerVersion,
    scanHiddenRetries,
    sourceDigest
} from './hidden-retry-scanner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(root, 'config/testing/retry-disposition-registry.json');
const current = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
const priorByFindingId = new Map(current.entries.map((entry) => [entry.findingId, entry]));
const semanticKey = (entry) => [
    entry.producerId,
    entry.location.path,
    entry.ruleId,
    entry.syntaxDigest
].join('\0');
const priorBySemanticKey = new Map();
for (const entry of current.entries)
{
    const key = semanticKey(entry);
    priorBySemanticKey.set(key, priorBySemanticKey.has(key) ? null : entry);
}
const scan = scanHiddenRetries(root);
const priorFor = (finding) => priorByFindingId.get(finding.findingId)
    ?? priorBySemanticKey.get(semanticKey(finding));
const missing = scan.findings.filter((finding) => !priorFor(finding));
if (missing.length > 0)
{
    throw new Error(missing.map((finding) => (
        `new retry finding requires an explicit disposition: ${finding.ruleId} at `
        + `${finding.location.path}:${finding.location.start.line}:${finding.location.start.column}`
    )).join('\n'));
}
const entries = scan.findings.map((finding) => ({
    ...priorFor(finding),
    findingId: finding.findingId,
    location: finding.location,
    sourceDigest: sourceDigest(path.join(root, finding.location.path)),
    syntaxDigest: finding.syntaxDigest
}));
const generated = `${JSON.stringify(sealContentDigest({
    schema: 'fsusblog.retry-disposition-registry.v1',
    scannerVersion: hiddenRetryScannerVersion,
    sourceDigestAlgorithm: 'sha256',
    entries
}), null, 4)}\n`;

if (process.argv.includes('--write'))
{
    fs.writeFileSync(registryFile, generated);
}
else if (process.argv.includes('--check'))
{
    if (fs.readFileSync(registryFile, 'utf8') !== generated)
    {
        process.stderr.write('config/testing/retry-disposition-registry.json is stale\n');
        process.exitCode = 1;
    }
}
else
{
    process.stdout.write(generated);
}
