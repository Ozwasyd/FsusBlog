#!/usr/bin/env node
/**
 * SSR runtime payload closure (#2725).
 *
 * The final image must not copy the frontend build root /app into
 * FsusBlog.ClientRuntime. This tool defines and enforces the exact SSR
 * production closure carried by the runtime payload:
 *
 *   materialize --client-root PATH --dist PATH --output PATH
 *       verify the closure, stage <dist>/server -> <output>/server and
 *       <client-root> package metadata -> <output>/package, then emit a
 *       payload manifest receipt.
 *   check --dist PATH
 *       verify the closure only; fail closed on any violation.
 *   print --dist PATH
 *       print the computed closure manifest without staging.
 *
 * The inventory (config/build/ssr-runtime-inputs.json) is bidirectionally
 * exact: every file under the payload root must be covered by a declared
 * entry/tree/file rule, and every declared rule must match at least one
 * file. A missing or unregistered dependency fails closed; there is no
 * fallback to the full frontend build tree.
 */

import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBuiltinSpecifiers = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const inventoryRelativePath = 'config/build/ssr-runtime-inputs.json';
const dockerfileRelativePath = 'ops/docker/FsusBlog.Server.Dockerfile';
const manifestName = 'manifest.json';

function fail(message)
{
    throw new Error(`[ssr-runtime-closure] ${message}`);
}

function parseArguments(argv)
{
    const command = argv[0];
    if (!['check', 'materialize', 'print'].includes(command))
    {
        fail('usage: ssr-runtime-closure.mjs <check|materialize|print> [--root PATH] [--dist PATH] [--client-root PATH] [--inventory PATH] [--output PATH] [--manifest PATH]');
    }
    const options = { root: scriptRoot, output: '', manifest: '' };
    for (let index = 1; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!['--root', '--dist', '--client-root', '--inventory', '--output', '--manifest'].includes(argument))
        {
            fail(`unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value)
        {
            fail(`${argument} requires a value`);
        }
        options[argument.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
        index += 1;
    }
    if (command === 'materialize' && !options.output)
    {
        fail('materialize requires --output');
    }
    return { command, ...options };
}

function toPosix(value)
{
    return value.split(sep).join('/');
}

function listFiles(root)
{
    const files = [];
    const stack = [''];
    while (stack.length > 0)
    {
        const current = stack.pop();
        for (const entry of readdirSync(join(root, current), { withFileTypes: true }))
        {
            const rel = current === '' ? entry.name : `${current}/${entry.name}`;
            if (entry.isDirectory())
            {
                stack.push(rel);
                continue;
            }
            if (entry.isFile())
            {
                files.push(rel);
            }
        }
    }
    return files.sort();
}

function loadInventory(root, override)
{
    const inventoryPath = override
        ? resolve(override)
        : join(root, inventoryRelativePath);
    if (!existsSync(inventoryPath))
    {
        fail(`SSR runtime input inventory is missing: ${inventoryPath}`);
    }
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    if (inventory.schema !== 'fsusblog.ssr-runtime-inputs.v1')
    {
        fail(`SSR runtime input inventory schema mismatch: ${inventory.schema ?? '<missing>'}`);
    }
    for (const name of ['entries', 'runtimeTrees', 'runtimeFiles', 'packageFiles', 'forbiddenSegments', 'forbiddenExtensions'])
    {
        if (!Array.isArray(inventory[name]) || inventory[name].some(value => typeof value !== 'string' || value.length === 0))
        {
            fail(`inventory ${name} must be a non-empty string array`);
        }
    }
    if (typeof inventory.payloadRoot !== 'string' || inventory.payloadRoot.length === 0 || inventory.payloadRoot.startsWith('/') || inventory.payloadRoot.includes('..'))
    {
        fail('inventory payloadRoot must be a non-empty relative directory');
    }
    return inventory;
}

function assertNoForbiddenEntry(rel, inventory)
{
    const segments = rel.split('/');
    for (const segment of inventory.forbiddenSegments)
    {
        if (segments.includes(segment))
        {
            fail(`SSR runtime payload contains forbidden segment ${segment}: ${rel}`);
        }
    }
    const extension = extname(rel);
    if (inventory.forbiddenExtensions.includes(extension))
    {
        fail(`SSR runtime payload contains forbidden extension ${extension}: ${rel}`);
    }
}


const identifierChar = /[A-Za-z0-9_$]/u;
const regexPreceders = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '<', '>', '~']);
const regexPrecedingWords = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'do', 'else', 'new', 'instanceof', 'yield', 'await', 'throw', 'import', 'export', 'from']);

function scanModuleSpecifiers(source)
{
    // Lexical scan over ESM specifier positions. Strings, template literal
    // bodies, comments and regex literals are skipped so specifier-shaped
    // text embedded in bundled parser sources is never captured.
    const staticSpecifiers = [];
    const computedSpecifiers = [];
    const n = source.length;
    const stateStack = [{ type: 'code' }];
    let i = 0;
    let lastChar = '';
    let lastWord = '';

    const skipWhitespace = (index) =>
    {
        while (index < n && /\s/u.test(source[index]))
        {
            index += 1;
        }
        return index;
    };
    const readStringArgument = (index) =>
    {
        const quote = source[index];
        if (quote === "'" || quote === '"')
        {
            let cursor = index + 1;
            while (cursor < n && source[cursor] !== quote)
            {
                cursor += source[cursor] === '\\' ? 2 : 1;
            }
            if (cursor >= n)
            {
                return null;
            }
            return { value: source.slice(index + 1, cursor), end: cursor + 1 };
        }
        if (quote === '`')
        {
            const end = source.indexOf('`', index + 1);
            if (end < 0)
            {
                return null;
            }
            const inner = source.slice(index + 1, end);
            return inner.includes('${')
                ? { computed: inner, end: end + 1 }
                : { value: inner, end: end + 1 };
        }
        return null;
    };

    while (i < n)
    {
        const frame = stateStack[stateStack.length - 1];
        const ch = source[i];
        if (frame.type === 'line-comment')
        {
            if (ch === '\n')
            {
                stateStack.pop();
            }
            i += 1;
            continue;
        }
        if (frame.type === 'block-comment')
        {
            if (ch === '*' && source[i + 1] === '/')
            {
                stateStack.pop();
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (frame.type === 'string')
        {
            if (ch === '\\')
            {
                i += 2;
                continue;
            }
            if (ch === frame.quote)
            {
                stateStack.pop();
            }
            i += 1;
            continue;
        }
        if (frame.type === 'template')
        {
            if (ch === '\\')
            {
                i += 2;
                continue;
            }
            if (ch === '`')
            {
                stateStack.pop();
                i += 1;
                continue;
            }
            if (ch === '$' && source[i + 1] === '{')
            {
                stateStack.push({ type: 'code', braceDepth: 1 });
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (frame.type === 'regex')
        {
            if (ch === '\\')
            {
                i += 2;
                continue;
            }
            if (ch === '[')
            {
                stateStack.push({ type: 'regex-class' });
                i += 1;
                continue;
            }
            if (ch === '/')
            {
                stateStack.pop();
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        if (frame.type === 'regex-class')
        {
            if (ch === '\\')
            {
                i += 2;
                continue;
            }
            if (ch === ']')
            {
                stateStack.pop();
            }
            i += 1;
            continue;
        }

        // code frame
        if (frame.braceDepth !== undefined)
        {
            if (ch === '{')
            {
                frame.braceDepth += 1;
                i += 1;
                lastChar = ch;
                continue;
            }
            if (ch === '}')
            {
                frame.braceDepth -= 1;
                i += 1;
                if (frame.braceDepth === 0)
                {
                    stateStack.pop();
                }
                lastChar = ch;
                continue;
            }
        }
        if (ch === '/' && source[i + 1] === '/')
        {
            stateStack.push({ type: 'line-comment' });
            i += 2;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*')
        {
            stateStack.push({ type: 'block-comment' });
            i += 2;
            continue;
        }
        if (ch === '/' && (regexPreceders.has(lastChar) || regexPrecedingWords.has(lastWord)))
        {
            stateStack.push({ type: 'regex' });
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"')
        {
            stateStack.push({ type: 'string', quote: ch });
            i += 1;
            lastChar = ch;
            lastWord = '';
            continue;
        }
        if (ch === '`')
        {
            stateStack.push({ type: 'template' });
            i += 1;
            lastChar = ch;
            lastWord = '';
            continue;
        }
        if (identifierChar.test(ch))
        {
            const start = i;
            while (i < n && identifierChar.test(source[i]))
            {
                i += 1;
            }
            const word = source.slice(start, i);
            const precededByDot = start > 0 && source[start - 1] === '.';
            lastChar = word;
            lastWord = word;
            if (precededByDot || (word !== 'import' && word !== 'from'))
            {
                continue;
            }
            let cursor = skipWhitespace(i);
            if (word === 'import' && source[cursor] === '(')
            {
                const argument = readStringArgument(skipWhitespace(cursor + 1));
                if (argument?.value !== undefined)
                {
                    staticSpecifiers.push(argument.value);
                }
                else if (argument?.computed !== undefined)
                {
                    computedSpecifiers.push(argument.computed);
                }
                else
                {
                    computedSpecifiers.push('<dynamic>');
                }
                i = argument ? argument.end : cursor + 1;
                continue;
            }
            if (word === 'import' && source[cursor] === '.')
            {
                continue;
            }
            const argument = readStringArgument(cursor);
            if (argument?.value !== undefined)
            {
                staticSpecifiers.push(argument.value);
                i = argument.end;
            }
            else if (argument?.computed !== undefined)
            {
                computedSpecifiers.push(argument.computed);
                i = argument.end;
            }
            continue;
        }
        if (!/\s/u.test(ch))
        {
            lastChar = ch;
            lastWord = '';
        }
        i += 1;
    }
    return { staticSpecifiers, computedSpecifiers };
}

export function computeClosure(distRoot, inventory)
{
    const payloadDir = join(distRoot, inventory.payloadRoot);
    if (!existsSync(payloadDir) || !statSync(payloadDir).isDirectory())
    {
        fail(`SSR runtime payload root is missing: ${payloadDir}`);
    }
    const files = listFiles(payloadDir);
    const fileSet = new Set(files);

    const coveredByRule = new Map();
    const markCovered = (rel, rule) =>
    {
        coveredByRule.set(rel, rule);
    };
    for (const entry of inventory.entries)
    {
        if (!fileSet.has(entry))
        {
            fail(`SSR runtime entry is missing from the payload: ${inventory.payloadRoot}/${entry}`);
        }
        markCovered(entry, `entry:${entry}`);
    }
    for (const tree of inventory.runtimeTrees)
    {
        const prefix = tree.endsWith('/') ? tree : `${tree}/`;
        const matches = files.filter(rel => rel.startsWith(prefix));
        if (matches.length === 0)
        {
            fail(`declared SSR runtime tree matched no payload files: ${tree}`);
        }
        for (const rel of matches)
        {
            markCovered(rel, `tree:${tree}`);
        }
    }
    for (const file of inventory.runtimeFiles)
    {
        if (!fileSet.has(file))
        {
            fail(`declared SSR runtime file is missing from the payload: ${inventory.payloadRoot}/${file}`);
        }
        markCovered(file, `file:${file}`);
    }
    const uncovered = files.filter(rel => !coveredByRule.has(rel));
    if (uncovered.length > 0)
    {
        fail(`SSR runtime payload contains files outside the declared closure: ${uncovered.join(', ')}`);
    }
    for (const rel of files)
    {
        assertNoForbiddenEntry(rel, inventory);
    }

    const visited = new Set();
    const externalSpecifiers = [];
    const computedSpecifiers = [];
    const unresolvedSpecifiers = [];
    const queue = [...inventory.entries];
    while (queue.length > 0)
    {
        const rel = queue.pop();
        if (visited.has(rel))
        {
            continue;
        }
        if (!fileSet.has(rel))
        {
            fail(`SSR runtime import target is missing from the payload: ${rel}`);
        }
        visited.add(rel);
        const source = readFileSync(join(payloadDir, rel), 'utf8');
        const scanned = scanModuleSpecifiers(source);
        for (const specifier of scanned.staticSpecifiers)
        {
            if (nodeBuiltinSpecifiers.has(specifier))
            {
                continue;
            }
            if (specifier.startsWith('.'))
            {
                const target = toPosix(relative(payloadDir, resolve(dirname(join(payloadDir, rel)), specifier)));
                if (target.startsWith('..'))
                {
                    fail(`SSR runtime import escapes the payload root: ${rel} -> ${specifier}`);
                }
                if (!fileSet.has(target))
                {
                    fail(`SSR runtime import target is missing from the payload: ${rel} -> ${specifier}`);
                }
                queue.push(target);
                continue;
            }
            externalSpecifiers.push(`${rel}:${specifier}`);
        }
        for (const specifier of scanned.computedSpecifiers)
        {
            computedSpecifiers.push(`${rel}:${specifier}`);
        }
    }
    if (externalSpecifiers.length > 0)
    {
        fail(`SSR runtime bundle requires external packages outside the sealed payload: ${externalSpecifiers.join(', ')}`);
    }

    const payload = files.filter(rel => coveredByRule.has(rel));
    const digest = createHash('sha256');
    let payloadBytes = 0;
    for (const rel of payload)
    {
        digest.update(rel);
        digest.update('\0');
        const bytes = readFileSync(join(payloadDir, rel));
        digest.update(bytes);
        digest.update('\0');
        payloadBytes += bytes.length;
    }
    return {
        schema: 'fsusblog.ssr-runtime-manifest.v1',
        payloadRoot: inventory.payloadRoot,
        entries: [...inventory.entries],
        files: payload,
        fileCount: payload.length,
        payloadBytes,
        payloadDigest: `sha256:${digest.digest('hex')}`,
        moduleClosure: [...visited].sort(),
        moduleClosureCount: visited.size,
        computedImportSpecifiers: computedSpecifiers.sort(),
        unresolvedImportSpecifiers: unresolvedSpecifiers.sort(),
        sourceFileCount: files.length
    };
}

function copyInto(root, rel, destinationRoot)
{
    const source = join(root, rel);
    const destination = join(destinationRoot, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { preserveTimestamps: false });
}

export function materialize(distRoot, clientRoot, inventory, output, manifestOverride = '')
{
    const closure = computeClosure(distRoot, inventory);
    const payloadDir = join(distRoot, inventory.payloadRoot);
    mkdirSync(output, { recursive: true });
    const payloadOutput = join(output, inventory.payloadRoot);
    for (const rel of closure.files)
    {
        copyInto(payloadDir, rel, payloadOutput);
    }
    const packageOutput = join(output, 'package');
    mkdirSync(packageOutput, { recursive: true });
    for (const file of inventory.packageFiles)
    {
        const source = join(clientRoot, file);
        if (!existsSync(source))
        {
            fail(`SSR runtime package metadata is missing: ${source}`);
        }
        cpSync(source, join(packageOutput, file), { preserveTimestamps: false });
    }
    const manifestPath = manifestOverride || join(output, manifestName);
    writeFileSync(manifestPath, `${JSON.stringify(closure, null, 2)}\n`, 'utf8');
    return closure;
}

export function assertDockerfile(root)
{
    const source = readFileSync(join(root, dockerfileRelativePath), 'utf8');
    const stageMatches = [...source.matchAll(/^\s*FROM\s+.+?\s+AS\s+([A-Za-z0-9_.-]+)\s*$/gmu)];
    const stages = new Map(stageMatches.map((match, index) => [
        match[1],
        source.slice(match.index, stageMatches[index + 1]?.index ?? source.length)
    ]));
    const finalInstructions = (stages.get('final') ?? '')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => /^(?:ADD|COPY)\s+/u.test(line));
    const forbiddenCopy = finalInstructions.filter(instruction =>
        /^COPY\s+--from=frontend-build\b.*\s\/app(?:\s|\/\s|$)/u.test(instruction)
        && !/\/app\/dist|\/ssr-runtime/u.test(instruction));
    if (forbiddenCopy.length > 0)
    {
        fail(`final stage still copies the frontend build root: ${forbiddenCopy.join(', ')}`);
    }
    const ssrCopy = finalInstructions.filter(instruction =>
        /^COPY\s+--from=frontend-build\b.*\/ssr-runtime\b/u.test(instruction));
    if (ssrCopy.length !== 1)
    {
        fail(`final stage must copy the sealed SSR runtime payload exactly once: ${ssrCopy.join(', ') || '<none>'}`);
    }
    const wwwrootCopy = finalInstructions.filter(instruction =>
        /^COPY\s+--from=frontend-build\b.*\/app\/dist\b/u.test(instruction));
    if (wwwrootCopy.length !== 1)
    {
        fail(`final stage must copy the frontend dist into wwwroot exactly once: ${wwwrootCopy.join(', ') || '<none>'}`);
    }
    const frontendInstructions = (stages.get('frontend-build') ?? '').split(/\r?\n/u);
    const materializeRuns = frontendInstructions.filter(line =>
        /ssr-runtime-closure\.mjs\s+materialize\b/u.test(line));
    if (materializeRuns.length !== 1)
    {
        fail('frontend-build stage must materialize the sealed SSR runtime payload exactly once');
    }
}

const cliPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (cliPath && cliPath === fileURLToPath(import.meta.url))
{
    const { command, root, dist, clientRoot, inventory: inventoryOverride, output, manifest } = parseArguments(process.argv.slice(2));
    const inventory = loadInventory(root, inventoryOverride);
    const distRoot = resolve(dist ?? join(root, 'src/frontend/dist'));
    if (command === 'check')
    {
        computeClosure(distRoot, inventory);
        assertDockerfile(root);
        console.log('[ssr-runtime-closure] ok');
        process.exit(0);
    }
    const closure = command === 'materialize'
        ? materialize(distRoot, resolve(clientRoot ?? dirname(distRoot)), inventory, resolve(output), manifest ? resolve(manifest) : '')
        : computeClosure(distRoot, inventory);
    process.stdout.write(`${JSON.stringify(closure, null, 2)}\n`);
}
