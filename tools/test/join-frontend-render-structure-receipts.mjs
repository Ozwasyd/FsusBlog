#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    currentFrontendStructureIdentity,
    joinFrontendRenderStructureReceipts
} from './frontend-render-structure-receipts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const receiptFiles = [
    path.join(root, '.tmp/frontend/receipts/dom-depth-static.json'),
    path.join(root, '.tmp/frontend/receipts/markdown-render-budget.json')
];
const receipts = receiptFiles.map((file) =>
{
    if (!fs.existsSync(file))
    {
        throw new Error(`frontend structure producer receipt is missing: ${path.relative(root, file)}`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
});
const summary = joinFrontendRenderStructureReceipts({
    ...currentFrontendStructureIdentity(root),
    receipts,
    root
});
const output = path.join(root, '.tmp/release-evidence/frontend-render-structure-summary.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.next-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
fs.renameSync(temporary, output);
console.log(`[frontend-render-structure] joined checks=${summary.checks.length}`);
