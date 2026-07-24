#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexedExtensions = new Set(['.css', '.scss', '.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const excludedDirectories = new Set(['coverage', 'dist', 'node_modules', 'test-results']);

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function posix(value)
{
    return value.replaceAll(path.sep, '/');
}

function compareOrdinal(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function parserToolchain(repoRoot)
{
    const require = createRequire(path.join(repoRoot, 'src/frontend/package.json'));
    let typescript;
    let vueCompiler;
    try
    {
        typescript = require('typescript');
        vueCompiler = require('@vue/compiler-sfc');
    }
    catch (error)
    {
        throw new Error(`frontend source index parser toolchain is unavailable: ${error.message}`, { cause: error });
    }
    return {
        typescript,
        vueCompiler,
        versions: {
            node: process.version,
            typescript: require('typescript/package.json').version,
            vueCompilerSfc: require('@vue/compiler-sfc/package.json').version,
            css: 'fsusblog-css-declaration-parser-v1',
            templateMetadata: 'fsusblog-template-metadata-v1'
        }
    };
}

function walk(directory, files)
{
    if (!fs.existsSync(directory))
    {
        return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compareOrdinal(left.name, right.name)))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory() && !excludedDirectories.has(entry.name))
        {
            walk(absolute, files);
        }
        else if (entry.isFile() && indexedExtensions.has(path.extname(entry.name)))
        {
            files.push(absolute);
        }
    }
}

function inventory(repoRoot)
{
    const files = [];
    for (const root of [
        'src/frontend/src',
        'src/frontend/wasm/web',
        'src/frontend/scripts',
        'src/frontend/public'
    ])
    {
        walk(path.join(repoRoot, root), files);
    }
    for (const extra of [
        'docs/design/reading-typography.md'
    ])
    {
        const absolute = path.join(repoRoot, extra);
        if (fs.existsSync(absolute))
        {
            files.push(absolute);
        }
    }
    return [...new Set(files)].sort(compareOrdinal);
}

function lineStarts(source)
{
    const starts = [0];
    for (let index = 0; index < source.length; index += 1)
    {
        if (source.charCodeAt(index) === 10)
        {
            starts.push(index + 1);
        }
    }
    return starts;
}

function spanAt(source, starts, start, end = start + 1)
{
    let low = 0;
    let high = starts.length;
    while (low + 1 < high)
    {
        const middle = Math.floor((low + high) / 2);
        if (starts[middle] <= start)
        {
            low = middle;
        }
        else
        {
            high = middle;
        }
    }
    return {
        start,
        end,
        line: low + 1,
        column: start - starts[low] + 1
    };
}

function regexMetadata(source, pattern, select = (match) => match[1])
{
    const starts = lineStarts(source);
    pattern.lastIndex = 0;
    return [...source.matchAll(pattern)].map((match) =>
    {
        const value = select(match);
        const relative = match[0].indexOf(value);
        const start = match.index + Math.max(0, relative);
        return { value, span: spanAt(source, starts, start, start + value.length) };
    });
}

function parseCss(source)
{
    const starts = lineStarts(source);
    const declarations = [];
    const declarationPattern = /(?<property>(?:--)?[\w-]+)\s*:\s*(?<value>[^;{}]+)\s*;/gu;
    for (const match of source.matchAll(declarationPattern))
    {
        const property = match.groups.property;
        const value = match.groups.value.trim();
        declarations.push({
            property,
            value,
            span: spanAt(source, starts, match.index, match.index + match[0].length)
        });
    }
    return {
        declarations,
        tokens: regexMetadata(source, /var\(\s*(--[\w-]+)/gu)
    };
}

function parseTemplateMetadata(source)
{
    const classes = [];
    for (const match of source.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gu))
    {
        const base = match.index + match[0].indexOf(match[1]);
        const starts = lineStarts(source);
        for (const value of match[1].split(/\s+/u).filter(Boolean))
        {
            const offset = match[1].indexOf(value);
            classes.push({ value, span: spanAt(source, starts, base + offset, base + offset + value.length) });
        }
    }
    const aria = [...source.matchAll(/\b(aria-[\w-]+)\s*=\s*["']([^"']*)["']/gu)].map((match) => ({
        name: match[1],
        value: match[2],
        span: spanAt(source, lineStarts(source), match.index, match.index + match[0].length)
    }));
    const text = regexMetadata(source, />\s*([^<>{}\n][^<>{}]*)\s*</gu, (match) => match[1].trim())
        .filter(({ value }) => value.length > 0);
    const routes = regexMetadata(source, /["'](\/[A-Za-z0-9_?&=./:@~-]+)["']/gu);
    return { classes, aria, text, routes, components: [] };
}

function parseTypeScript(source, file, typescript, { offset = 0, fullSource = source } = {})
{
    const kind = file.endsWith('.tsx')
        ? typescript.ScriptKind.TSX
        : file.endsWith('.jsx')
      ? typescript.ScriptKind.JSX
      : /\.(?:c|m)?js$/u.test(file)
        ? typescript.ScriptKind.JS
        : typescript.ScriptKind.TS;
    const ast = typescript.createSourceFile(file, source, typescript.ScriptTarget.Latest, true, kind);
    const starts = lineStarts(fullSource);
    const imports = [];
    const components = new Map();
    const visit = (node) =>
    {
        if (typescript.isImportDeclaration(node) && typescript.isStringLiteral(node.moduleSpecifier))
        {
            imports.push({
                specifier: node.moduleSpecifier.text,
                span: spanAt(
                    fullSource,
                    starts,
                    offset + node.moduleSpecifier.getStart(ast),
                    offset + node.moduleSpecifier.getEnd()
                )
            });
            const clause = node.importClause;
            const recordComponent = (identifier) =>
            {
                if (!identifier || !/^[A-Z]/u.test(identifier.text) || components.has(identifier.text))
                {
                    return;
                }
                components.set(identifier.text, {
                    value: identifier.text,
                    span: spanAt(
                        fullSource,
                        starts,
                        offset + identifier.getStart(ast),
                        offset + identifier.getEnd()
                    )
                });
            };
            recordComponent(clause?.name);
            for (const element of clause?.namedBindings?.elements ?? [])
            {
                recordComponent(element.name);
            }
        }
        typescript.forEachChild(node, visit);
    };
    visit(ast);
    return {
        ast,
        imports,
        components: [...components.values()].sort((left, right) => compareOrdinal(left.value, right.value))
    };
}

function blockRecord(block)
{
    if (!block)
    {
        return null;
    }
    return {
        type: block.type,
        lang: block.lang ?? null,
        span: {
            start: block.loc.start.offset,
            end: block.loc.end.offset,
            line: block.loc.start.line,
            column: block.loc.start.column
        }
    };
}

function parseFile({ relative, content, toolchain })
{
    const extension = path.extname(relative);
    let vue = null;
    let typescript = { ast: null, imports: [], components: [] };
    let template = parseTemplateMetadata(content);
    if (extension === '.vue')
    {
        const parsed = toolchain.vueCompiler.parse(content, { filename: relative, sourceMap: false });
        if (parsed.errors.length > 0)
        {
            throw new Error(`${relative}: Vue parser failed: ${parsed.errors.map(String).join('; ')}`);
        }
        const descriptor = parsed.descriptor;
        const blocks = [
            blockRecord(descriptor.script),
            blockRecord(descriptor.scriptSetup),
            blockRecord(descriptor.template),
            ...descriptor.styles.map(blockRecord)
        ].filter(Boolean);
        vue = { blocks };
        const scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
        if (scripts.length > 0)
        {
            const parsedScripts = scripts.map((block) => parseTypeScript(
                block.content,
                `${relative}.${block.type}.ts`,
                toolchain.typescript,
                {
                    offset: block.loc.start.offset,
                    fullSource: content
                }
            ));
            typescript = {
                ast: parsedScripts.map(({ ast }) => ast),
                imports: parsedScripts.flatMap(({ imports }) => imports),
                components: parsedScripts.flatMap(({ components }) => components)
            };
        }
        template.components = typescript.components;
    }
    else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension))
    {
        typescript = parseTypeScript(content, relative, toolchain.typescript);
        template.components = typescript.components;
    }
    return {
        path: relative,
        bytes: Buffer.byteLength(content),
        contentDigest: sha256(content),
        content,
        vue,
        typescript,
        template,
        css: parseCss(content)
    };
}

function resolveGitIdentity(repoRoot)
{
    const run = (args) => spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    const commitResult = run(['rev-parse', 'HEAD']);
    if (commitResult.status !== 0)
    {
        throw new Error('frontend source index cannot resolve git commit');
    }
    const diffResult = run(['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
    const untrackedResult = run(['ls-files', '--others', '--exclude-standard', '-z']);
    if (diffResult.status !== 0 || untrackedResult.status !== 0)
    {
        throw new Error('frontend source index cannot resolve worktree state');
    }
    const untracked = untrackedResult.stdout.split('\0').filter(Boolean).sort(compareOrdinal);
    const untrackedIdentity = untracked.map((file) =>
    {
        const absolute = path.join(repoRoot, file);
        const digest = fs.statSync(absolute).isFile()
            ? sha256(fs.readFileSync(absolute))
            : 'non-file';
        return `${file}\0${digest}`;
    }).join('\n');
    return {
        commit: commitResult.stdout.trim(),
        worktreeFingerprint: sha256(
            `${commitResult.stdout.trim()}\0${diffResult.stdout}\0${untrackedIdentity}`
        )
    };
}

export function buildFrontendSourceIndex({
    repoRoot = moduleRoot,
    parserRoot = repoRoot,
    runId = process.env.FSUSBLOG_TEST_RUN_ID ?? `local-${process.pid}-${Date.now()}`,
    commit,
    worktreeFingerprint
} = {})
{
    const git = commit && worktreeFingerprint ? { commit, worktreeFingerprint } : resolveGitIdentity(repoRoot);
    const toolchain = parserToolchain(parserRoot);
    const paths = inventory(repoRoot);
    const files = paths.map((absolute) =>
    {
        const content = fs.readFileSync(absolute, 'utf8');
        return parseFile({
            relative: posix(path.relative(repoRoot, absolute)),
            content,
            toolchain
        });
    });
    const inputTreeDigest = sha256(files.map(({ path: file, contentDigest }) => `${file}\0${contentDigest}`).join('\n'));
    return {
        schema: 'fsusblog.frontend-source-index.v1',
        identity: {
            commit: commit ?? git.commit,
            worktreeFingerprint: worktreeFingerprint ?? git.worktreeFingerprint,
            runId,
            inputTreeDigest,
            parsers: toolchain.versions
        },
        metrics: {
            inventoryCount: files.length,
            readCount: files.length,
            primaryParseCount: files.length,
            parserInvocations: {
                vue: files.filter(({ vue }) => vue).length,
                typescript: files.filter(({ typescript }) => typescript.ast).length,
                css: files.length,
                templateMetadata: files.length
            }
        },
        files
    };
}

export function validateFrontendSourceIndex(index, { parserRoot = moduleRoot } = {})
{
    const errors = [];
    if (index?.schema !== 'fsusblog.frontend-source-index.v1')
    {
        errors.push('source index schema is invalid');
    }
    for (const field of ['commit', 'worktreeFingerprint', 'runId', 'inputTreeDigest'])
    {
        if (typeof index?.identity?.[field] !== 'string' || !index.identity[field])
        {
            errors.push(`source index ${field} is missing`);
        }
    }
    if (!Array.isArray(index?.files) || index.files.length === 0)
    {
        errors.push('source index inventory is missing');
    }
    if (Array.isArray(index?.files))
    {
        const paths = index.files.map(({ path: file }) => file);
        if (new Set(paths).size !== paths.length)
        {
            errors.push('source index inventory contains duplicate files');
        }
        if (JSON.stringify(paths) !== JSON.stringify([...paths].sort(compareOrdinal)))
        {
            errors.push('source index inventory is not ordinally sorted');
        }
        for (const file of index.files)
        {
            if (sha256(file.content ?? '') !== file.contentDigest)
            {
                errors.push(`${file.path}: content digest mismatch`);
            }
            const metadata = [
                ...(file.vue?.blocks ?? []),
                ...(file.typescript?.imports ?? []),
                ...(file.template?.classes ?? []),
                ...(file.template?.aria ?? []),
                ...(file.template?.text ?? []),
                ...(file.template?.routes ?? []),
                ...(file.template?.components ?? []),
                ...(file.css?.declarations ?? []),
                ...(file.css?.tokens ?? [])
            ];
            for (const [position, entry] of metadata.entries())
            {
                const metadataSpan = entry.span;
                if (!metadataSpan
                    || !Number.isInteger(metadataSpan.start)
                    || !Number.isInteger(metadataSpan.end)
                    || metadataSpan.start < 0
                    || metadataSpan.end < metadataSpan.start
                    || metadataSpan.end > file.content.length)
                {
                    errors.push(`${file.path}: metadata source span ${position} is invalid`);
                    continue;
                }
                const expected = spanAt(
                    file.content,
                    lineStarts(file.content),
                    metadataSpan.start,
                    metadataSpan.end
                );
                if (metadataSpan.line !== expected.line || metadataSpan.column !== expected.column)
                {
                    errors.push(`${file.path}: metadata source span ${position} line/column mismatch`);
                }
            }
        }
        const digest = sha256(index.files.map(({ path: file, contentDigest }) => `${file}\0${contentDigest}`).join('\n'));
        if (digest !== index?.identity?.inputTreeDigest)
        {
            errors.push('source index input tree digest mismatch');
        }
    }
    const metrics = index?.metrics;
    if (metrics?.inventoryCount !== index?.files?.length
    || metrics?.readCount !== metrics?.inventoryCount
    || metrics?.primaryParseCount !== metrics?.inventoryCount)
    {
        errors.push('source index inventory/read/primary-parse counts must be equal');
    }
    try
    {
        const expected = parserToolchain(parserRoot).versions;
        for (const [parser, version] of Object.entries(expected))
        {
            if (index?.identity?.parsers?.[parser] !== version)
            {
                errors.push(`source index parser version mismatch: ${parser}`);
            }
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    return errors;
}

export function sourceIndexEvidence(index)
{
    return {
        ...index,
        files: index.files.map((source) =>
        {
            const file = { ...source, typescript: { ...source.typescript } };
            delete file.content;
            delete file.typescript.ast;
            return file;
        })
    };
}
