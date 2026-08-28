import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

export function stableJson(value)
{
    return JSON.stringify(stableValue(value));
}

export function digest(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function normalizeDeclaration(value)
{
    return String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
}

function wildcardPattern(value)
{
    const normalized = normalizeDeclaration(value);
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
        }
    }
    return new RegExp(`^${source}$`, 'u');
}

function repositoryFiles(root)
{
    const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'buffer'
    });
    if (result.status !== 0)
    {
        throw new Error(`cannot enumerate repository inputs: ${result.stderr.toString('utf8').trim()}`);
    }
    return result.stdout.toString('utf8').split('\0').filter(Boolean)
        .map(normalizeDeclaration).sort();
}

function validateSafeDeclaration(declaration)
{
    if (!declaration || path.isAbsolute(declaration) || declaration === '..' || declaration.startsWith('../'))
    {
        throw new Error(`unsafe governance input declaration: ${declaration || '<empty>'}`);
    }
}

export function resolveInputFiles(rootValue, declarations)
{
    const root = path.resolve(rootValue);
    const candidates = repositoryFiles(root);
    const resolved = new Set();
    for (const rawDeclaration of declarations ?? [])
    {
        const declaration = normalizeDeclaration(rawDeclaration);
        validateSafeDeclaration(declaration);
        const absolute = path.join(root, declaration);
        const hasWildcard = /[?*]/u.test(declaration);
        const matches = hasWildcard
            ? candidates.filter((candidate) => wildcardPattern(declaration).test(candidate))
            : fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
        ? candidates.filter((candidate) => candidate.startsWith(`${declaration}/`))
        : candidates.filter((candidate) => candidate === declaration);
        if (matches.length === 0)
        {
            throw new Error(`governance input declaration matched no files: ${declaration}`);
        }
        for (const match of matches)
        {
            resolved.add(match);
        }
    }
    return [...resolved].sort();
}

function fileIdentity(root, relativePath)
{
    const absolute = path.join(root, relativePath);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink())
    {
        return { path: relativePath, mode: stat.mode, kind: 'symlink', digest: digest(fs.readlinkSync(absolute)) };
    }
    if (!stat.isFile())
    {
        throw new Error(`governance input is not a regular file: ${relativePath}`);
    }
    return { path: relativePath, mode: stat.mode, kind: 'file', digest: digest(fs.readFileSync(absolute)) };
}

export function treeIdentity(root, declarations)
{
    const files = resolveInputFiles(root, declarations).map((file) => fileIdentity(root, file));
    return { files, digest: digest(stableJson(files)) };
}

export function gitHead(root)
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(result.stdout.trim()))
    {
        throw new Error('repository governance requires a full Git source commit');
    }
    return result.stdout.trim();
}

function runtimeVersion(command, args)
{
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`cannot resolve governance toolchain ${command}`);
    }
    return `${command}:${result.stdout.trim() || result.stderr.trim()}`;
}

export function toolchainIdentity(root, authority)
{
    const runtimeVersions = (authority.toolchain?.runtimes ?? []).map((runtime) =>
    {
        if (runtime === 'node')
        {
            return `node:${process.version}`;
        }
        if (runtime === 'bash')
        {
            return runtimeVersion('bash', ['--version']).split('\n')[0];
        }
        if (runtime === 'git')
        {
            return runtimeVersion('git', ['--version']);
        }
        throw new Error(`unsupported governance runtime identity: ${runtime}`);
    }).sort();
    const parserVersions = [...(authority.toolchain?.parsers ?? [])].sort();
    const sourceTree = treeIdentity(root, authority.toolchain?.identityFiles ?? []);
    const value = { runtimeVersions, parserVersions, sourceTree };
    return { ...value, digest: digest(stableJson(value)) };
}
