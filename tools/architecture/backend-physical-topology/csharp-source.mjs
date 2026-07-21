import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export { maskCSharp } from './csharp-mask.mjs';
import { maskCSharp } from './csharp-mask.mjs';

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function walkCSharp(root)
{
    if (!existsSync(root))
    {
        return [];
    }
    const output = [];
    for (const entry of readdirSync(root, { withFileTypes: true }))
    {
        const absolute = resolve(root, entry.name);
        if (entry.isDirectory())
        {
            output.push(...walkCSharp(absolute));
        }
        else if (entry.isFile() && entry.name.endsWith('.cs'))
        {
            output.push(absolute);
        }
    }
    return output.sort();
}

export function containsIdentifier(source, identifier)
{
    return new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'u').test(source);
}

export function declaresMethod(source, member)
{
    const modifiers = '(?:public|private|protected|internal)\\s+(?:(?:static|async|virtual|override|new|sealed|partial)\\s+)*';
    const returnType = '(?:[A-Za-z_][A-Za-z0-9_.<>?,\\[\\]]*\\s+)+';
    return new RegExp(`\\b${modifiers}${returnType}${escapeRegExp(member)}\\s*(?:<[^>{};]+>\\s*)?\\(`, 'u').test(source);
}

export function countLines(source)
{
    if (source.length === 0)
    {
        return 0;
    }
    const newlineCount = source.match(/\n/gu)?.length ?? 0;
    return source.endsWith('\n') ? newlineCount : newlineCount + 1;
}

export function policyFile(root, path, errors)
{
    const absolute = resolve(root, path);
    if (!existsSync(absolute))
    {
        errors.push(`${path}: required source file is missing`);
        return null;
    }
    const source = readFileSync(absolute, 'utf8');
    return { absolute, path, source, code: maskCSharp(source) };
}

export function requireTokens(file, tokens, errors)
{
    if (!file)
    {
        return;
    }
    for (const token of tokens ?? [])
    {
        if (!file.code.includes(token))
        {
            errors.push(`${file.path}: required code token is missing: ${token}`);
        }
    }
}

export function requireIdentifiers(file, identifiers, errors)
{
    if (!file)
    {
        return;
    }
    for (const identifier of identifiers ?? [])
    {
        if (!containsIdentifier(file.code, identifier))
        {
            errors.push(`${file.path}: required code identifier is missing: ${identifier}`);
        }
    }
}

export function forbidTokens(file, tokens, errors)
{
    if (!file)
    {
        return;
    }
    for (const token of tokens ?? [])
    {
        if (file.code.includes(token))
        {
            errors.push(`${file.path}: forbidden code token is present: ${token}`);
        }
    }
}
