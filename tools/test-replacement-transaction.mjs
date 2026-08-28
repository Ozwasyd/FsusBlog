#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    applyReplacementTransaction,
    createReplacementTransaction,
    validateReplacementTransaction,
    verifyDiffHasTransaction
} from './test-replacement/transaction.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const [command, inputPath, outputPath, authorityPath] = process.argv.slice(2);

function json(file)
{
    return JSON.parse(readFileSync(path.resolve(root, file), 'utf8'));
}

function writeJsonExclusive(file, value)
{
    const absolute = path.resolve(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function authorities(descriptorPath)
{
    if (!descriptorPath)
    {
        throw new Error('an authority descriptor path is required');
    }
    const descriptor = json(descriptorPath);
    return {
        beforeInventory: json(descriptor.beforeInventory),
        afterInventory: json(descriptor.afterInventory),
        beforeRetention: json(descriptor.beforeRetention),
        afterRetention: json(descriptor.afterRetention),
        afterQuality: json(descriptor.afterQuality)
    };
}

try
{
    if (command === 'plan')
    {
        const input = json(inputPath);
        const transaction = createReplacementTransaction({
            request: input.request,
            beforeInventory: json(input.authorities.beforeInventory),
            afterInventory: json(input.authorities.afterInventory),
            beforeRetention: json(input.authorities.beforeRetention),
            afterRetention: json(input.authorities.afterRetention),
            afterQuality: json(input.authorities.afterQuality)
        });
        writeJsonExclusive(outputPath, transaction);
        console.log(`[test-replacement] planned ${transaction.transactionId} digest=${transaction.contentDigest}`);
    }
    else if (command === 'verify')
    {
        const transaction = json(inputPath);
        validateReplacementTransaction(transaction, authorities(outputPath));
        console.log(`[test-replacement] verified ${transaction.transactionId} digest=${transaction.contentDigest}`);
    }
    else if (command === 'apply')
    {
        const transaction = json(inputPath);
        const verificationAuthorities = authorities(authorityPath);
        validateReplacementTransaction(transaction, verificationAuthorities);
        const receipt = applyReplacementTransaction({
            root,
            transaction,
            receiptPath: outputPath,
            verifyAfter: () => validateReplacementTransaction(transaction, verificationAuthorities)
        });
        console.log(`[test-replacement] applied ${transaction.transactionId} receipt=${receipt.contentDigest}`);
    }
    else if (command === 'check-diff')
    {
        const base = inputPath || 'origin/master';
        const transaction = outputPath ? json(outputPath) : null;
        const changes = verifyDiffHasTransaction({ root, base, transaction });
        console.log(`[test-replacement] diff ok governedChanges=${changes.length}`);
    }
    else
    {
        throw new Error('usage: test-replacement-transaction.mjs plan <request> <transaction> | verify <transaction> <authorities> | apply <transaction> <receipt> <authorities> | check-diff <base> [transaction]');
    }
}
catch (error)
{
    console.error(`[test-replacement] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
