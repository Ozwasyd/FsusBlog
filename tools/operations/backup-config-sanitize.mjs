#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output)
{
    throw new Error('usage: backup-config-sanitize.mjs <input> <output>');
}

function stripJsonComments(source)
{
    let result = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < source.length; index += 1)
    {
        const current = source[index];
        const next = source[index + 1];
        if (lineComment)
        {
            if (current === '\n')
            {
                lineComment = false;
                result += current;
            }
            continue;
        }
        if (blockComment)
        {
            if (current === '*' && next === '/')
            {
                blockComment = false;
                index += 1;
            }
            else if (current === '\n')
            {
                result += current;
            }
            continue;
        }
        if (inString)
        {
            result += current;
            if (escaped)
            {
                escaped = false;
            }
            else if (current === '\\')
            {
                escaped = true;
            }
            else if (current === '"')
            {
                inString = false;
            }
            continue;
        }
        if (current === '"')
        {
            inString = true;
            result += current;
        }
        else if (current === '/' && next === '/')
        {
            lineComment = true;
            index += 1;
        }
        else if (current === '/' && next === '*')
        {
            blockComment = true;
            index += 1;
        }
        else
        {
            result += current;
        }
    }

    if (inString || blockComment)
    {
        throw new Error('invalid JSONC input');
    }
    return result;
}

function sanitize(value)
{
    if (Array.isArray(value))
    {
        return value.map(sanitize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
        /(secret|password|token|connection|string|key)/i.test(key)
            ? '<redacted>'
            : sanitize(child)
            ])
        );
    }
    return value;
}

const parsed = JSON.parse(stripJsonComments(await readFile(input, 'utf8')));
await writeFile(output, `${JSON.stringify(sanitize(parsed), null, 2)}\n`, {
    mode: 0o600
});
