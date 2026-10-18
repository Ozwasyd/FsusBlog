#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serviceRoot = 'src/backend/Services/Authoring';
const resolverFile = `${serviceRoot}/AuthoringCanvasReferenceResolver.cs`;
const factSourceFile = `${serviceRoot}/AuthoringCanvasReferenceFactSource.cs`;
const verifierFile = `${serviceRoot}/AuthoringCanvasReferenceVerifier.cs`;
const authorities = new Map([
    ['AuthoringCanvasReferenceResolver', resolverFile],
    ['AuthoringCanvasReferenceFactSource', factSourceFile],
    ['PostgresAuthoringCanvasArticleReferenceReader', factSourceFile],
    ['AuthoringCanvasReferenceProjectionCache', resolverFile],
    ['AuthoringCanvasReferenceVerifier', verifierFile]
]);

function walk(directory, extensions)
{
    if (!existsSync(directory))
    {
        return [];
    }
    const files = [];
    const pending = [directory];
    while (pending.length > 0)
    {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                pending.push(absolute);
            }
            else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

function codeOnly(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '');
}

function count(source, pattern)
{
    return (source.match(pattern) ?? []).length;
}

function hasDomReferenceAuthority(source, isCSharp = false)
{
    // A finite lexical guard, not a language/type checker: follow forward local aliases
    // from explicit DOM reads into named identity writes or selection predicates.
    // Keep literals/comments opaque and analyze each expression separately so a DOM
    // measurement beside a canonical target does not turn that target into DOM identity.
    const tokens = [...source.matchAll(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|@?"(?:""|\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|===|!==|==|!=|=>|&&|\|\||\?\?|\?\.|[^\s]/gu
    )].filter(([token]) => !token.startsWith('//') && !token.startsWith('/*'))
        .map(([token]) => /^(?:@?"|'|`)/u.test(token) ? '<literal>' : token);
    const identity = /^(?:Target)?(?:ArticleId|HeadingIdentity|BlockIdentity|AnchorId)$/iu;
    const domRead = /^(?:querySelector(?:All)?|getElementById|getElementsBy(?:Name|ClassName|TagName)|elements?FromPoint|getSelection|getRangeAt|createRange|getAttribute(?:NS)?|SelectSingleNode|SelectNodes|GetElementById|QuerySelector(?:All)?|GetAttribute(?:Value|Node)?)$/u;
    const selection = /^(?:find|filter|some|every|First|Single|FirstOrDefault|SingleOrDefault|Find|FindAll|Where|Any|All)$/u;
    const scalarType = /^(?:string|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|char|object|dynamic)$/u;
    const opening = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
    const matching = new Map();
    const conditionalColons = new Set();
    const groups = [{ questions: [] }];
    // Call boundaries and conditional colons belong to their enclosing delimiter
    // group; a following boolean guard is not an argument, and ?: is one expression.
    for (let index = 0; index < tokens.length; index++)
    {
        const token = tokens[index];
        if (opening.has(token))
        {
            groups.push({ start: index, closing: opening.get(token), questions: [] });
        }
        else if (token === groups.at(-1).closing)
        {
            const group = groups.pop();
            matching.set(group.start, index);
            matching.set(index, group.start);
        }
        else if (token === '?' && tokens[index + 1] !== ':')
        {
            groups.at(-1).questions.push(index);
        }
        else if (token === ':' && groups.at(-1).questions.length > 0)
        {
            groups.at(-1).questions.pop();
            conditionalColons.add(index);
        }
        else if ([',', ';'].includes(token))
        {
            groups.at(-1).questions.length = 0;
        }
    }
    const callArguments = (index) => matching.has(index)
        ? tokens.slice(index + 1, matching.get(index)) : [];
    const scopes = [new Map()];
    const functionScopes = new Set(scopes);
    const flowSnapshots = new Map();
    const conditionalBlocks = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
    const bindingScope = (name) =>
    {
        for (let index = scopes.length - 1; index >= 0; index--)
        {
            if (scopes[index].has(name))
            {
                return scopes[index];
            }
        }
        return undefined;
    };
    const alias = (name) => bindingScope(name)?.get(name) ?? false;
    const domDerived = (expression) => expression.some((token, index) =>
        (domRead.test(token) && expression[index + 1] === '(')
        || (alias(token) && !['.', '?.'].includes(expression[index - 1])));
    const hasIdentity = (expression) => expression.some((token) => identity.test(token));
    const expressionAt = (start, direction = 1, comparison = false) =>
    {
        let depth = 0;
        const expression = [];
        const opening = direction === 1 ? ['(', '[', '{'] : [')', ']', '}'];
        const closing = direction === 1 ? [')', ']', '}'] : ['(', '[', '{'];
        for (let index = start; index >= 0 && index < tokens.length; index += direction)
        {
            const token = tokens[index];
            if (depth === 0 && (closing.includes(token) || [',', ';', '=', '=>'].includes(token)
                || (token === ':' && !conditionalColons.has(index))
                || (comparison && ['&&', '||', '==', '===', '!=', '!=='].includes(token))))
            {
                break;
            }
            if (opening.includes(token))
            {
                depth++;
            }
            if (closing.includes(token))
            {
                depth--;
            }
            expression.push(token);
        }
        return direction === 1 ? expression : expression.reverse();
    };
    const selections = tokens.flatMap((token, index) => selection.test(token) && tokens[index + 1] === '('
        && matching.has(index + 1) ? [[index, matching.get(index + 1)]] : []);

    for (let index = 0; index < tokens.length; index++)
    {
        const token = tokens[index];
        if (token === '{')
        {
            const scope = new Map();
            scopes.push(scope);
            const previous = tokens[index - 1];
            const parameters = matching.get(index - 1);
            const isFunction = previous === '=>' || (previous === ')' && parameters !== undefined
                && !conditionalBlocks.has(tokens[parameters - 1]));
            const maySkip = ['else', 'try', 'finally', 'do'].includes(previous)
                || (previous === ')' && conditionalBlocks.has(tokens[parameters - 1]));
            if (isFunction)
            {
                functionScopes.add(scope);
            }
            if (isFunction || maySkip)
            {
                flowSnapshots.set(scope, { isFunction,
                    bindings: scopes.slice(0, -1).map((owner) => [owner, new Map(owner)]) });
            }
        }
        else if (token === '}' && scopes.length > 1)
        {
            const snapshot = flowSnapshots.get(scopes.pop());
            // Ordinary blocks execute in sequence. A conditional block may not run;
            // a function body is analyzed locally without assuming an invocation.
            for (const [owner, prior] of snapshot?.bindings ?? [])
            {
                if (snapshot.isFunction)
                {
                    owner.clear();
                }
                for (const [name, derived] of prior)
                {
                    owner.set(name, snapshot.isFunction ? derived : derived || owner.get(name));
                }
            }
        }
        else if (token === 'AuthoringCanvasReferenceTarget' && tokens[index - 1] === 'new'
            && tokens[index + 1] === '(')
        {
            // This existing record's positional identity slots are article/heading/block;
            // display projection data is not an identity slot.
            const argumentsList = [[]];
            let depth = 0;
            for (const argumentToken of callArguments(index + 1))
            {
                if (argumentToken === ',' && depth === 0)
                {
                    argumentsList.push([]);
                    continue;
                }
                if (['(', '[', '{'].includes(argumentToken))
                {
                    depth++;
                }
                if ([')', ']', '}'].includes(argumentToken))
                {
                    depth--;
                }
                argumentsList.at(-1).push(argumentToken);
            }
            if ([2, 3, 4].some((slot) => domDerived(argumentsList[slot] ?? [])))
            {
                return true;
            }
        }
        else if (token === '=' || (token === ':' && !conditionalColons.has(index))
            || (token === '=>' && (tokens[index - 2] === 'string'
                || (tokens[index - 2] === '?' && tokens[index - 3] === 'string'))))
        {
            // Include simple TS scalar annotations, e.g. const targetArticleId: number = ... .
            const typed = token === '=' && tokens[index - 2] === ':';
            const nameIndex = typed ? index - 3 : index - 1;
            const name = tokens[nameIndex];
            const expression = expressionAt(index + 1);
            const derived = domDerived(expression);
            if (identity.test(name) && derived)
            {
                return true;
            }
            if (token === '=' && /^[A-Za-z_$][\w$]*$/u.test(name)
                && !['.', '?.'].includes(tokens[nameIndex - 1]))
            {
                // Object fields are checked individually; do not taint the whole
                // container because one unrelated display/geometry field reads DOM.
                const prefix = tokens[nameIndex - 1];
                const declaration = ['const', 'let', 'var'].includes(prefix)
                    || (isCSharp && (scalarType.test(prefix)
                        || (prefix === '?' && scalarType.test(tokens[nameIndex - 2]))));
                // Declarations create bindings; ordinary assignments update the
                // existing owner. Frontend var is function-scoped, unlike C# var.
                const owner = declaration
                    ? prefix === 'var' && !isCSharp
                        ? scopes.findLast((scope) => functionScopes.has(scope)) : scopes.at(-1)
                    : bindingScope(name) ?? scopes.at(-1);
                owner.set(name, !expression.includes('{') && !expression.includes('=>') && derived);
            }
        }
        else if (['==', '===', '!=', '!=='].includes(token)
            && selections.some(([start, end]) => index > start && index <= end))
        {
            const left = expressionAt(index - 1, -1, true);
            const right = expressionAt(index + 1, 1, true);
            if ((hasIdentity(left) && domDerived(right)) || (hasIdentity(right) && domDerived(left)))
            {
                return true;
            }
        }
        else if (token === 'Equals' && tokens[index + 1] === '('
            && selections.some(([start, end]) => index > start && index <= end))
        {
            const receiver = expressionAt(index - 2, -1, true);
            const argumentsList = callArguments(index + 1);
            if ((hasIdentity(receiver) && domDerived(argumentsList))
                || (domDerived(receiver) && hasIdentity(argumentsList))
                || (hasIdentity(argumentsList) && domDerived(argumentsList)))
            {
                return true;
            }
        }
    }
    return false;
}

export function checkAuthoringCanvasReferenceAuthority(repositoryRoot = root)
{
    const violations = [];
    const backendFiles = walk(path.join(repositoryRoot, serviceRoot), ['.cs']);
    const sources = new Map(backendFiles.map((absolute) => [
        path.relative(repositoryRoot, absolute),
        readFileSync(absolute, 'utf8')
    ]));

    for (const [className, expectedFile] of authorities)
    {
        const declaration = new RegExp(`\\bclass\\s+${className}\\b`, 'u');
        const owners = [...sources]
            .filter(([, source]) => declaration.test(codeOnly(source)))
            .map(([relative]) => relative);
        if (owners.length !== 1 || owners[0] !== expectedFile)
        {
            violations.push(
                `expected exact-one ${className} in ${expectedFile}, found ${owners.join(', ') || '<none>'}`);
        }
    }

    if (![resolverFile, factSourceFile, verifierFile].every((relative) => sources.has(relative)))
    {
        return violations;
    }
    const resolver = codeOnly(sources.get(resolverFile));
    codeOnly(sources.get(factSourceFile));
    const verifier = codeOnly(sources.get(verifierFile));
    const referenceSources = [...sources]
        .filter(([relative, source]) => relative.includes('AuthoringCanvasReference')
            || /\bPinnedTargetRevision\b/u.test(source))
        .map(([, source]) => codeOnly(source))
        .join('\n');

    if (count(resolver, /factSource\.ReadBatchAsync\s*\(/gu) !== 1)
    {
        violations.push(`${resolverFile}: resolver must issue exact-one bounded fact-source batch read path`);
    }
    if (count(verifier, /factSource\.ReadBatchAsync\s*\(/gu) !== 1
        || count(verifier, /factSource\.ReadAuthorityCoordinateAsync\s*\(/gu) !== 1)
    {
        violations.push(`${verifierFile}: verifier must independently read exact-one authority and fact batch`);
    }
    if (/\b(?:ResolveCoreAsync|ResolveAsync)\s*\(/u.test(verifier)
        || /\b(?:cache|projectionCache)\s*\.(?:TryGet|Set)\s*\(/iu.test(verifier))
    {
        violations.push(`${verifierFile}: verifier must not call the resolver or projection cache`);
    }
    if (/\.Select\s*\([^)]*(?:async\s*)?[^)]*=>[\s\S]{0,500}?\bReadBatchAsync\s*\(/u
        .test(referenceSources))
    {
        violations.push('canvas reference authority must not issue N+1 batch reads');
    }
    if (/\b(?:string|byte\[\]|ReadOnlyMemory<byte>|JsonElement)\s+(?:Article)?(?:Body|Html|Dom|RenderedHtml)\b/u
        .test(referenceSources))
    {
        violations.push('canvas reference authority must not admit article body, HTML, or DOM payloads');
    }
    if (/(?:First|Single)(?:OrDefault)?\s*\([^)]*(?:Title|Hash)|(?:Title|Hash)\s*(?:==|!=)|(?:Title|Hash)\.Equals\s*\(/u
        .test(referenceSources))
    {
        violations.push('canvas reference identity must not fall back to title or hash matching');
    }
    if (/PinnedTargetRevision\s*=\s*(?:[A-Za-z0-9_]+\.)?CurrentRevision\b/u.test(referenceSources))
    {
        violations.push('pinned references must not be silently replaced with the latest revision');
    }

    for (const [relative, source] of sources)
    {
        if ((relative.includes('AuthoringCanvasReference') || /\bPinnedTargetRevision\b/u.test(source)
            || /\bAuthoringCanvasReference\w*/u.test(source))
            && hasDomReferenceAuthority(source, true))
        {
            violations.push(`${relative}: DOM-derived canvas reference identity or selection authority is forbidden`);
        }
    }

    const clientFiles = walk(path.join(repositoryRoot, 'src/frontend'), ['.ts', '.tsx', '.js', '.vue']);
    for (const absolute of clientFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const rawSource = readFileSync(absolute, 'utf8');
        const source = codeOnly(rawSource);
        if (/(?:AuthoringCanvasReference|canvasReference|canvas[-_ ]reference)/iu.test(source)
            && /(?:\.filter|\.find|\.some|\.every)\s*\([^)]*permission|permission[^\n]{0,120}(?:filter|allow|deny)/iu
                .test(source))
        {
            violations.push(`${relative}: client-side canvas reference permission filtering is forbidden`);
        }
        if (/(?:AuthoringCanvasReference|canvasReference|canvas[-_ ]reference)/iu.test(`${relative}\n${source}`)
            && hasDomReferenceAuthority(rawSource))
        {
            violations.push(`${relative}: DOM-derived canvas reference identity or selection authority is forbidden`);
        }
    }

    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthoringCanvasReferenceAuthority();
    if (violations.length > 0)
    {
        console.error('[authoring-canvas-reference-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[authoring-canvas-reference-authority] passed: exact-one resolver/source/reader/cache/verifier, independent bounded verification, stable identity and permission boundaries');
    }
}
