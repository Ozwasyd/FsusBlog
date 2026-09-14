#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const matrixPath = process.env.FSUSBLOG_MATRIX_FILE
    ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
    : path.join(root, 'tests/matrix.yml');

const requiredActorDimensionPrefixes = ['anonymous-account-', 'admin-principal-'];
const requiredIdentityKindDimensions = ['identity-kind-anonymous-account', 'identity-kind-admin-principal'];

function parseInlineList(value)
{
    const trimmed = String(value ?? '').trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']'))
    {
        return [];
    }
    const inner = trimmed.slice(1, -1).trim();
    if (!inner)
    {
        return [];
    }
    return inner.split(',').map((item) => item.trim()).filter(Boolean);
}

function readCoverageIds(text)
{
    const coverageIds = new Set();
    for (const match of text.matchAll(/^\s+coverage:\s*(.*?)\s*$/gm))
    {
        for (const id of parseInlineList(match[1]))
        {
            coverageIds.add(id);
        }
    }
    return coverageIds;
}

function validateCoverageIds(coverageIds)
{
    const errors = [];

    for (const prefix of requiredActorDimensionPrefixes)
    {
        if (![...coverageIds].some((id) => id.startsWith(prefix)))
        {
            errors.push(`matrix coverage dimensions missing required actor prefix: ${prefix}*`);
        }
    }

    for (const dimension of requiredIdentityKindDimensions)
    {
        if (!coverageIds.has(dimension))
        {
            errors.push(`matrix coverage dimensions missing required identity kind: ${dimension}`);
        }
    }

    for (const id of coverageIds)
    {
        if (id.startsWith('endpoint-role-protocol-') && !id.includes('deprecated'))
        {
            errors.push(`matrix coverage dimension ${id} uses legacy endpoint-role-protocol naming without deprecated marker`);
        }
    }

    return errors;
}

const coverageIds = readCoverageIds(fs.readFileSync(matrixPath, 'utf8'));
const errors = validateCoverageIds(coverageIds);

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[matrix-identity-kinds] ${error}`);
    }
    process.exit(1);
}

console.log('[matrix-identity-kinds] ok');
