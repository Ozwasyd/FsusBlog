#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    BuildDocumentInventory,
    ReadDocumentLifecyclePolicy,
    RenderDocumentIndex,
    ValidateDocumentLifecycle,
    WriteDocumentLifecycle
} from './document-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policy = ReadDocumentLifecyclePolicy(root);
const argumentsList = process.argv.slice(2);
const write = argumentsList.includes('--write');
if (argumentsList.some((argument) => !['--check', '--write'].includes(argument)))
{
    throw new Error('usage: generate-document-lifecycle.mjs [--check|--write]');
}

if (write)
{
    const inventory = WriteDocumentLifecycle(root, policy);
    console.log(`[document-lifecycle] wrote ${inventory.documents.length} entries`);
}
else
{
    const inventory = BuildDocumentInventory(root, policy);
    const errors = ValidateDocumentLifecycle(root, policy, inventory, RenderDocumentIndex(inventory));
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[document-lifecycle] ${error}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log(`[document-lifecycle] ok documents=${inventory.documents.length}`);
    }
}
