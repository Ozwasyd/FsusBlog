#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } from './current-run-evidence-locator.mjs';
import {
    createEvidenceParentReceipt,
    releaseFinalDirectConsumerIds
} from './current-run-evidence-publication.mjs';
import { validateEvidenceLocatorRegistry } from './evidence-location-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function option(name)
{
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
    return process.argv[index + 1];
}

const context = JSON.parse(fs.readFileSync(path.resolve(option('--context')), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
    'config/testing/evidence-locator-registry.json'), 'utf8'));
validateEvidenceLocatorRegistry(registry);
const bindingsOption = process.argv.indexOf('--bindings');
const bindings = bindingsOption >= 0
    ? JSON.parse(fs.readFileSync(path.resolve(option('--bindings')), 'utf8'))
    : {
        schema: 'fsusblog.release-final-explicit-bindings.v1',
        bindings: Object.fromEntries(releaseFinalDirectConsumerIds.map((consumerId) =>
        {
            const entry = registry.entries.find((candidate) => candidate.consumerId === consumerId);
            const inputPath = String(process.env[entry?.outputBindingKey] ?? '').trim();
            if (!inputPath) throw new Error(`missing explicit binding ${entry?.outputBindingKey ?? consumerId}`);
            return [consumerId, inputPath];
        }))
    };
if (bindings?.schema !== 'fsusblog.release-final-explicit-bindings.v1'
    || Object.keys(bindings.bindings ?? {}).sort().join(',') !== [...releaseFinalDirectConsumerIds].sort().join(','))
{
    throw new Error('release-final bindings must contain the exact direct consumer set');
}
const children = releaseFinalDirectConsumerIds.map((consumerId) =>
{
    const registryEntry = registry.entries.find((entry) => entry.consumerId === consumerId);
    const inputPath = bindings.bindings[consumerId];
    const located = locateCurrentRunEvidence({ context, registry, registryEntry, repositoryRoot,
        explicitInputs: [inputPath] });
    verifyCurrentRunEvidenceBinding(located.bindingReceipt,
        { context, registry, registryEntry, repositoryRoot });
    return { ...located.receipt, path: inputPath, inputDigest: located.bindingReceipt.inputDigest };
});
const parentEntry = registry.entries.find((entry) =>
    entry.consumerId === 'evidence-consumer.release.release-final-domain-evidence');
if (!parentEntry) throw new Error('release-final parent registry entry is missing');
const receipt = createEvidenceParentReceipt({ context, parentAuthorityId: parentEntry.authorityId,
    producerId: parentEntry.producerId, childReferences: children });
const output = path.resolve(option('--output'));
if (fs.existsSync(output)) throw new Error('release-final parent already exists for this run attempt');
const parent = path.dirname(output);
if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
{
    throw new Error('release-final parent output directory must already exist');
}
const realParent = fs.realpathSync(parent);
const owned = context.ownedRoots.map((root) => fs.realpathSync(path.resolve(repositoryRoot, root)));
if (!owned.some((root) => realParent === root || realParent.startsWith(`${root}${path.sep}`)))
{
    throw new Error('release-final parent output escapes current-run owned roots');
}
const temporary = `${output}.prepared-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
fs.renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({ outputBindingKey: parentEntry.outputBindingKey,
    producerReceiptDigest: receipt.producerReceiptDigest })}\n`);
