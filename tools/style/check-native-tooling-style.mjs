#!/usr/bin/env node

import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const defaultPolicy = 'config/development/native-tooling-style-policy.json';
const policySchema = 'fsusblog.native-tooling-style-policy.v1';
const exceptionSchema = 'fsusblog.native-tooling-style-exceptions.v1';
const baselineSchema = 'fsusblog.native-tooling-style-baseline.v1';
const validModes = new Set(['changed', 'full']);
const validDomains = new Set(['all', 'native', 'scripts', 'docs']);
const validOperations = new Set(['format', 'lint']);

let root = repositoryRoot;
let policy = null;
let policyPath = null;
let exceptionRegistry = null;
let baseline = new Map();
let jsonWithCommentsPatterns = [];
const markdownAnchorBindings = new Map();
const markdownSpanPrefix = 'FSUSBLOG-MARKDOWNLINT-SPANS ';

// The original CLI formatter supplies parser ranges; this module owns no linter.
export default function MarkdownSpanFormatter(options)
{
    options.logMessage(`${markdownSpanPrefix}${JSON.stringify(options.results)}`);
}

async function RunMarkdownSpanAdapter()
{
    const [, , , executable, ...argv] = process.argv;
    const actual = fs.realpathSync(executable);
    const directory = path.dirname(actual);
    const packageFile = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const declaredBin = manifest.bin?.['markdownlint-cli2'];
    const normalizedBin = typeof declaredBin === 'string' ? declaredBin.replace(/^\.\//u, '') : null;
    if (manifest.name !== 'markdownlint-cli2' || manifest.version !== '0.23.1'
        || manifest.exports?.['.'] !== './markdownlint-cli2.mjs'
        || normalizedBin !== path.basename(actual)
        || fs.realpathSync(packageFile) !== packageFile)
    {
        throw new Error('original markdownlint-cli2 structured formatter API is unavailable');
    }
    const modulePath = fs.realpathSync(path.join(directory, 'markdownlint-cli2.mjs'));
    if (path.dirname(modulePath) !== directory || path.basename(modulePath) !== 'markdownlint-cli2.mjs')
    {
        throw new Error('original markdownlint-cli2 module escaped its actual package directory');
    }
    const require = createRequire(pathToFileURL(modulePath));
    const { main } = await import(pathToFileURL(modulePath).href);
    process.exitCode = await main({
        argv,
        directory: process.cwd(),
        logMessage: (value) => process.stdout.write(`${value}\n`),
        logError: (value) => process.stderr.write(`${value}\n`),
        optionsOverride: {
            outputFormatters: [
                [require.resolve('markdownlint-cli2-formatter-default')],
                [scriptPath]
            ]
        }
    });
}
const diagnostics = [];
let compileCommandDatabases = null;
const compilerDriverFlags = new Map();

function ParseArguments(argv)
{
    const result = {
        files: [],
        domain: 'all',
        mode: 'changed',
        operation: 'lint',
        write: false,
        requireTools: false,
        updateBaseline: false
    };

    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--write')
        {
            result.write = true;
            continue;
        }
        if (argument === '--require-tools')
        {
            result.requireTools = true;
            continue;
        }
        if (argument === '--update-baseline')
        {
            result.updateBaseline = true;
            continue;
        }
        if (!['--root', '--policy', '--mode', '--domain', '--operation', '--base', '--file', '--baseline-ref'].includes(argument))
        {
            throw new Error(`unknown argument ${argument}`);
        }

        const value = argv[index + 1];
        if (!value)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--file')
        {
            result.files.push(value);
        }
        else
        {
            result[argument.slice(2).replace('-r', 'R')] = value;
        }
        index += 1;
    }

    if (!validModes.has(result.mode))
    {
        throw new Error(`--mode must be one of ${[...validModes].join(', ')}`);
    }
    if (!validDomains.has(result.domain))
    {
        throw new Error(`--domain must be one of ${[...validDomains].join(', ')}`);
    }
    if (!validOperations.has(result.operation))
    {
        throw new Error(`--operation must be one of ${[...validOperations].join(', ')}`);
    }
    if (result.write && result.operation !== 'format')
    {
        throw new Error('--write is valid only with --operation format');
    }
    return result;
}

function AddDiagnostic(file, line, rule, message)
{
    diagnostics.push({ file, line, rule, message });
}

function ReadJson(file, label, allowJsonc = false)
{
    if (!fs.existsSync(file))
    {
        AddDiagnostic(path.relative(root, file), 1, 'configuration', `missing ${label}`);
        return null;
    }

    try
    {
        const source = fs.readFileSync(file, 'utf8');
        return JSON.parse(allowJsonc ? NormalizeJsonc(source) : source);
    }
    catch (error)
    {
        AddDiagnostic(path.relative(root, file), 1, 'configuration', `invalid ${label}: ${error.message}`);
        return null;
    }
}

function ToPosix(value)
{
    return value.split(path.sep).join('/');
}

function NormalizeFile(value)
{
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const relative = ToPosix(path.relative(root, absolute));
    if (relative === '..' || relative.startsWith('../'))
    {
        throw new Error(`file is outside repository root: ${value}`);
    }
    return relative;
}

function GlobToRegExp(pattern)
{
    let source = '';
    for (let index = 0; index < pattern.length; index += 1)
    {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*')
        {
            if (pattern[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
            continue;
        }
        if (character === '*')
        {
            source += '[^/]*';
            continue;
        }
        if (character === '?')
        {
            source += '[^/]';
            continue;
        }
        source += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    }
    return new RegExp(`^${source}$`, 'u');
}

function CompilePatterns(patterns)
{
    return patterns.map((pattern) => ({ pattern, expression: GlobToRegExp(pattern) }));
}

function MatchesAny(file, patterns)
{
    return patterns.some(({ expression }) => expression.test(file));
}

function FileDomain(file)
{
    const extension = path.posix.extname(file).toLowerCase();
    const special = path.posix.basename(file);
    for (const [domain, definition] of Object.entries(policy.domains))
    {
        if (definition.extensions.includes(extension) || definition.specialFiles.includes(special))
        {
            return domain;
        }
    }
    return null;
}

function IsEligible(file, domain, exclusions)
{
    const owner = FileDomain(file);
    return owner !== null && (domain === 'all' || domain === owner) && !MatchesAny(file, exclusions);
}

function Run(command, argumentsList, options = {})
{
    return spawnSync(command, argumentsList, {
        cwd: options.cwd ?? root,
        encoding: options.encoding ?? 'utf8',
        env: { ...process.env, ...(options.env ?? {}) },
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeout ?? 120_000
    });
}

function GitLines(argumentsList)
{
    const result = Run('git', argumentsList);
    if (result.status !== 0)
    {
        throw new Error((result.stderr || result.stdout || `git ${argumentsList.join(' ')} failed`).trim());
    }
    return result.stdout.split(/\r?\n/u).filter(Boolean).map(ToPosix);
}

function SelectFiles(argumentsValue, exclusions)
{
    if (argumentsValue.files.length > 0)
    {
        return [...new Set(argumentsValue.files.map(NormalizeFile))]
            .filter((file) => IsEligible(file, argumentsValue.domain, exclusions))
            .sort();
    }

    let candidates = [];
    if (argumentsValue.mode === 'full')
    {
        candidates = GitLines(['ls-files', '--cached', '--others', '--exclude-standard']);
    }
    else
    {
        const base = argumentsValue.base ?? policy.changedDefaultBase;
        const changed = Run('git', ['diff', '--name-only', '--diff-filter=ACMR', base, '--']);
        if (changed.status !== 0)
        {
            throw new Error(`cannot resolve changed-file base ${base}: ${(changed.stderr || changed.stdout).trim()}`);
        }
        candidates = changed.stdout.split(/\r?\n/u).filter(Boolean).map(ToPosix);
        candidates.push(...GitLines(['ls-files', '--others', '--exclude-standard']));
    }

    return [...new Set(candidates)]
        .filter((file) => IsEligible(file, argumentsValue.domain, exclusions))
        .sort();
}

function Sha256(content)
{
    return crypto.createHash('sha256').update(content).digest('hex');
}

function ValidatePolicy()
{
    if (!policy || policy.schema !== policySchema)
    {
        AddDiagnostic(ToPosix(path.relative(root, policyPath)), 1, 'policy-schema', `expected ${policySchema}`);
        return false;
    }

    for (const requiredDomain of ['native', 'scripts', 'docs'])
    {
        if (!policy.domains?.[requiredDomain])
        {
            AddDiagnostic(ToPosix(path.relative(root, policyPath)), 1, 'policy-domain', `missing ${requiredDomain}`);
        }
    }
    const records = policy.markdownCompatibilityAnchors;
    if (!Array.isArray(records) || records.length !== 1)
    {
        AddDiagnostic(policyPath, 1, 'markdown-anchor-policy', 'expected the finite maintained API fragment registry');
        return false;
    }
    const record = records[0];
    const closedKeys = (value, keys) => value !== null && typeof value === 'object'
        && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
    if (!closedKeys(record, ['documentPath', 'sourceRevision', 'anchors'])
        || record.documentPath !== 'docs/api/schemas-and-errors.md'
        || !/^[0-9a-f]{40}$/u.test(record.sourceRevision)
        || !Array.isArray(record.anchors) || record.anchors.length !== 9
        || record.anchors.some((entry) => !closedKeys(entry, ['id', 'heading'])
            || typeof entry.id !== 'string' || !/^[^\s"'<>\x00-\x1f]+$/u.test(entry.id)
            || typeof entry.heading !== 'string' || !/^#{2,3} [^\r\n]+$/u.test(entry.heading))
        || new Set(record.anchors.map((entry) => entry.id)).size !== record.anchors.length
        || new Set(record.anchors.map((entry) => entry.heading)).size !== record.anchors.length)
    {
        AddDiagnostic(policyPath, 1, 'markdown-anchor-policy', 'fragment registration requires exact path, unique IDs/headings and source provenance');
        return false;
    }
    return true;
}

function LoadExceptionRegistry()
{
    const file = path.resolve(root, policy.exceptions);
    const authorityFile = path.resolve(root, policy.authorityRegistry);
    const authorityRegistry = ReadJson(authorityFile, 'authoritative development registry');
    const authorityExceptionIds = new Set(
        authorityRegistry?.externalContractExceptions?.map((item) => item.id) ?? []
    );
    const authorityClassificationIds = new Set(
        authorityRegistry?.pathClassifications?.map((item) => item.id) ?? []
    );
    exceptionRegistry = ReadJson(file, 'native/tooling exception registry');
    if (!exceptionRegistry)
    {
        return;
    }
    if (exceptionRegistry.schema !== exceptionSchema)
    {
        AddDiagnostic(policy.exceptions, 1, 'exception-schema', `expected ${exceptionSchema}`);
        return;
    }

    const ids = new Set();
    for (const item of exceptionRegistry.exceptions ?? [])
    {
        if (!item.id || ids.has(item.id))
        {
            AddDiagnostic(policy.exceptions, 1, 'exception-id', `missing or duplicate id ${item.id ?? '(missing)'}`);
        }
        ids.add(item.id);
        const authorityBacked = item.authorityExceptionId
            ? authorityExceptionIds.has(item.authorityExceptionId)
            : (item.authorityClassificationId
                ? authorityClassificationIds.has(item.authorityClassificationId)
                : item.precedenceClass === 'language-syntax');
        if (!authorityBacked)
        {
            AddDiagnostic(
                policy.exceptions,
                1,
                'exception-authority',
                `${item.id} must map to the #1157 authority registry or the language-syntax precedence class`
            );
        }
        if (!Array.isArray(item.paths) || item.paths.length === 0 || item.paths.some((entry) => entry === '**' || entry === '*'))
        {
            AddDiagnostic(policy.exceptions, 1, 'exception-scope', `${item.id} must use narrow path patterns`);
        }
        for (const property of ['externalPattern', 'internalPattern', 'positive', 'negative', 'reason'])
        {
            if (!item[property])
            {
                AddDiagnostic(policy.exceptions, 1, 'exception-contract', `${item.id} is missing ${property}`);
            }
        }
        try
        {
            const external = new RegExp(item.externalPattern, 'u');
            const internal = new RegExp(item.internalPattern, 'u');
            if (!external.test(item.positive?.external ?? '') || !internal.test(item.positive?.internal ?? ''))
            {
                AddDiagnostic(policy.exceptions, 1, 'exception-positive', `${item.id} positive mapping does not match its patterns`);
            }
            if (internal.test(item.negative?.internal ?? ''))
            {
                AddDiagnostic(policy.exceptions, 1, 'exception-negative', `${item.id} negative internal example must be rejected`);
            }
        }
        catch (error)
        {
            AddDiagnostic(policy.exceptions, 1, 'exception-pattern', `${item.id}: ${error.message}`);
        }
    }

    for (const requiredId of exceptionRegistry.requiredIds ?? [])
    {
        if (!ids.has(requiredId))
        {
            AddDiagnostic(policy.exceptions, 1, 'exception-required', `missing ${requiredId}`);
        }
    }
}

function LoadBaseline()
{
    const file = path.resolve(root, policy.baseline);
    if (!fs.existsSync(file))
    {
        return;
    }
    const value = ReadJson(file, 'native/tooling style baseline');
    if (!value)
    {
        return;
    }
    if (value.schema !== baselineSchema)
    {
        AddDiagnostic(policy.baseline, 1, 'baseline-schema', `expected ${baselineSchema}`);
        return;
    }
    let previous = '';
    for (const item of value.files ?? [])
    {
        if (!item.path || !/^[a-f0-9]{64}$/u.test(item.sha256 ?? ''))
        {
            AddDiagnostic(policy.baseline, 1, 'baseline-entry', 'every entry requires a path and sha256 digest');
            continue;
        }
        if (item.path <= previous)
        {
            AddDiagnostic(policy.baseline, 1, 'baseline-order', 'entries must be unique and sorted by path');
        }
        previous = item.path;
        baseline.set(item.path, item.sha256);
    }
}

function UpdateBaseline(argumentsValue, exclusions)
{
    const reference = argumentsValue.baselineRef ?? 'HEAD';
    const commitResult = Run('git', ['rev-parse', reference]);
    if (commitResult.status !== 0)
    {
        throw new Error(`cannot resolve baseline ref ${reference}: ${(commitResult.stderr || commitResult.stdout).trim()}`);
    }
    const commit = commitResult.stdout.trim();
    const files = GitLines(['ls-tree', '-r', '--name-only', reference])
        .filter((file) => IsEligible(file, 'all', exclusions))
        .sort();
    const entries = [];
    for (const file of files)
    {
        const blob = Run('git', ['show', `${reference}:${file}`], { encoding: 'buffer' });
        if (blob.status !== 0)
        {
            throw new Error(`cannot read ${file} at ${reference}`);
        }
        entries.push({ path: file, sha256: Sha256(blob.stdout) });
    }
    const output = {
        schema: baselineSchema,
        sourceCommit: commit,
        semantics: 'An entry exempts only the exact pre-rule content digest; editing the file removes the exemption.',
        files: entries
    };
    const target = path.resolve(root, policy.baseline);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(output, null, 4)}\n`);
    process.stdout.write(`[native-tooling-style] baseline updated files=${entries.length} ref=${commit}\n`);
}

function NormalizeText(content)
{
    return content
        .replace(/^\uFEFF/u, '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/u, ''))
        .join('\n')
        .replace(/\n*$/u, '\n');
}

function CheckPhysical(file, buffer, content)
{
    if (!isUtf8(buffer))
    {
        AddDiagnostic(file, 1, 'utf8', 'file is not valid UTF-8');
        return;
    }
    if (content.startsWith('\uFEFF'))
    {
        AddDiagnostic(file, 1, 'bom', 'UTF-8 BOM is not allowed');
    }
    if (content.includes('\r'))
    {
        AddDiagnostic(file, 1, 'line-ending', 'use LF line endings');
    }
    if (!content.endsWith('\n'))
    {
        AddDiagnostic(file, Math.max(1, content.split(/\r?\n/u).length), 'final-newline', 'file must end with one newline');
    }
    else if (content.endsWith('\n\n'))
    {
        AddDiagnostic(file, content.split('\n').length - 1, 'final-newline', 'file must not end with a blank line');
    }

    const lines = content.split(/\r?\n/u);
    const shellIgnoredLines = path.posix.extname(file).toLowerCase() === '.sh'
        ? ShellIgnoredLineIndexes(content)
        : new Set();
    for (let index = 0; index < lines.length; index += 1)
    {
        if (/\s+$/u.test(lines[index]))
        {
            AddDiagnostic(file, index + 1, 'trailing-whitespace', 'remove trailing whitespace');
        }
        if (lines[index].includes('\t') && !shellIgnoredLines.has(index))
        {
            AddDiagnostic(file, index + 1, 'tab', 'use 4 spaces instead of Tab');
        }
    }
}

function IsCommandAvailable(command)
{
    if (process.env.FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS === '1')
    {
        return false;
    }
    const paths = (process.env.PATH ?? '').split(path.delimiter);
    return paths.some((directory) =>
    {
        try
        {
            fs.accessSync(path.join(directory, command), fs.constants.X_OK);
            return true;
        }
        catch
        {
            return false;
        }
    });
}

function ToolFailure(file, rule, result)
{
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(' | ');
    AddDiagnostic(file, 1, rule, output || 'tool exited non-zero');
}

function LoadCompileCommandDatabases()
{
    if (compileCommandDatabases !== null)
    {
        return compileCommandDatabases;
    }
    compileCommandDatabases = [];
    for (const relativeDirectory of policy.standardTools.cppLint.compileDatabaseCandidates ?? [])
    {
        const directory = path.resolve(root, relativeDirectory);
        const file = path.join(directory, 'compile_commands.json');
        if (!fs.existsSync(file))
        {
            continue;
        }
        try
        {
            const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
            const files = new Set(entries.map((entry) => path.isAbsolute(entry.file)
                ? path.resolve(entry.file)
                : path.resolve(entry.directory ?? directory, entry.file)));
            compileCommandDatabases.push({ directory, files, entries });
        }
        catch (error)
        {
            AddDiagnostic(ToPosix(path.relative(root, file)), 1, 'compile-database', error.message);
        }
    }
    return compileCommandDatabases;
}

function FindCompileCommandDatabase(file)
{
    const absolute = path.resolve(root, file);
    const database = LoadCompileCommandDatabases().find((candidate) => candidate.files.has(absolute)) ?? null;
    if (!database)
    {
        return null;
    }
    const entry = database.entries.find((candidate) =>
    {
        const candidateFile = path.isAbsolute(candidate.file)
            ? path.resolve(candidate.file)
            : path.resolve(candidate.directory ?? database.directory, candidate.file);
        return candidateFile === absolute;
    });
    return { ...database, entry };
}

function IsCppTranslationUnit(file)
{
    return new Set(['.c', '.cc', '.cpp', '.cxx']).has(path.posix.extname(file).toLowerCase());
}

function CompileCommandExecutable(entry)
{
    if (Array.isArray(entry?.arguments) && entry.arguments.length > 0)
    {
        return entry.arguments[0];
    }
    const match = entry?.command?.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/u);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function ClangTidyDriverArguments(compileDatabase)
{
    const compiler = CompileCommandExecutable(compileDatabase.entry);
    if (!compiler || !/^(?:em\+\+|emcc)(?:\.bat)?$/iu.test(path.basename(compiler)))
    {
        return [];
    }
    if (!compilerDriverFlags.has(compiler))
    {
        const result = Run(compiler, ['--cflags']);
        const output = result.status === 0 ? result.stdout.trim() : '';
        const target = output.match(/(?:^|\s)-target\s+([^\s]+)/u)?.[1]
            ?? output.match(/(?:^|\s)--target=([^\s]+)/u)?.[1];
        const sysroot = output.match(/(?:^|\s)--sysroot=([^\s]+)/u)?.[1];
        const argumentsList = [];
        if (target)
        {
            argumentsList.push(`--extra-arg-before=--target=${target}`);
        }
        if (sysroot)
        {
            argumentsList.push(`--extra-arg-before=--sysroot=${sysroot}`);
            argumentsList.push(`--extra-arg-before=-isystem${sysroot}/include/fakesdl`);
            argumentsList.push(`--extra-arg-before=-isystem${sysroot}/include/compat`);
        }
        compilerDriverFlags.set(compiler, argumentsList);
    }
    return compilerDriverFlags.get(compiler);
}

function RequireTool(name, file)
{
    if (!IsCommandAvailable(name))
    {
        AddDiagnostic(file, 1, 'missing-tool', `${name} is required by --require-tools`);
        return false;
    }
    return true;
}

function LeadingSpaces(line)
{
    return line.match(/^ */u)?.[0].length ?? 0;
}

function ShellIgnoredLineIndexes(content)
{
    const lines = content.split(/\r?\n/u);
    const ignored = new Set();
    const pendingHeredocs = [];
    let heredoc = null;
    let continuedQuote = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1)
    {
        const line = lines[lineIndex];
        if (heredoc)
        {
            ignored.add(lineIndex);
            const candidate = heredoc.stripTabs ? line.replace(/^\t+/u, '') : line;
            if (candidate === heredoc.delimiter)
            {
                heredoc = pendingHeredocs.shift() ?? null;
            }
            continue;
        }

        let quote = continuedQuote;
        if (quote !== null)
        {
            ignored.add(lineIndex);
        }
        let escaped = false;
        for (let index = 0; index < line.length; index += 1)
        {
            const character = line[index];
            if (quote === "'")
            {
                if (character === "'")
                {
                    quote = null;
                }
                continue;
            }
            if (quote === '"' || quote === '`')
            {
                if (escaped)
                {
                    escaped = false;
                    continue;
                }
                if (character === '\\')
                {
                    escaped = true;
                    continue;
                }
                if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (character === '\\')
            {
                escaped = true;
                continue;
            }
            if (character === '#'
                && (index === 0 || /\s/u.test(line[index - 1])))
            {
                break;
            }
            if (character === '<' && line[index + 1] === '<' && line[index + 2] !== '<')
            {
                let cursor = index + 2;
                let stripTabs = false;
                if (line[cursor] === '-')
                {
                    stripTabs = true;
                    cursor += 1;
                }
                while (/\s/u.test(line[cursor] ?? ''))
                {
                    cursor += 1;
                }
                const delimiterQuote = line[cursor] === "'" || line[cursor] === '"'
                    ? line[cursor]
                    : null;
                if (delimiterQuote)
                {
                    cursor += 1;
                }
                else if (line[cursor] === '\\')
                {
                    cursor += 1;
                }
                const start = cursor;
                if (delimiterQuote)
                {
                    while (cursor < line.length && line[cursor] !== delimiterQuote)
                    {
                        cursor += 1;
                    }
                }
                else
                {
                    while (/[A-Za-z0-9_]/u.test(line[cursor] ?? ''))
                    {
                        cursor += 1;
                    }
                }
                const delimiter = line.slice(start, cursor);
                if (delimiter)
                {
                    pendingHeredocs.push({ delimiter, stripTabs });
                    index = cursor;
                }
                continue;
            }
            if (character === "'" || character === '"' || character === '`')
            {
                quote = character;
            }
        }
        continuedQuote = quote;
        if (continuedQuote === null && pendingHeredocs.length > 0 && !/\\\s*$/u.test(line))
        {
            heredoc = pendingHeredocs.shift();
        }
    }
    return ignored;
}

function CheckFourSpaceIndent(file, content, ignoredLines = new Set())
{
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index];
        if (!ignoredLines.has(index) && line.trim() && LeadingSpaces(line) % 4 !== 0)
        {
            AddDiagnostic(file, index + 1, 'indent', 'indentation must be a multiple of 4 spaces');
        }
    }
}

function CheckCppFallbackIndent(file, content)
{
    const lines = content.split(/\r?\n/u);
    const state = {
        blockComment: false,
        parenDepth: 0,
        bracketDepth: 0,
        initializerDepth: 0
    };
    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index];
        const trimmed = line.trim();
        const continuation = state.blockComment
            || state.parenDepth > 0
            || state.bracketDepth > 0
            || state.initializerDepth > 0
            || /^\*/u.test(trimmed)
            || /^\/\*/u.test(trimmed)
            || /^(?:\|\||&&|[|?:+*/%.,-])/u.test(trimmed);
        if (trimmed && !continuation && LeadingSpaces(line) % 4 !== 0)
        {
            AddDiagnostic(file, index + 1, 'indent', 'C++ base indentation must be a multiple of 4 spaces');
        }

        let quote = null;
        let escaped = false;
        for (let cursor = 0; cursor < line.length; cursor += 1)
        {
            const character = line[cursor];
            const next = line[cursor + 1];
            if (state.blockComment)
            {
                if (character === '*' && next === '/')
                {
                    state.blockComment = false;
                    cursor += 1;
                }
                continue;
            }
            if (quote)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (character === '\\')
                {
                    escaped = true;
                }
                else if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (character === '/' && next === '*')
            {
                state.blockComment = true;
                cursor += 1;
                continue;
            }
            if (character === '/' && next === '/')
            {
                break;
            }
            if (character === '"' || character === "'")
            {
                quote = character;
                continue;
            }
            if (character === '(')
            {
                state.parenDepth += 1;
            }
            else if (character === ')')
            {
                state.parenDepth = Math.max(0, state.parenDepth - 1);
            }
            else if (character === '[')
            {
                state.bracketDepth += 1;
            }
            else if (character === ']')
            {
                state.bracketDepth = Math.max(0, state.bracketDepth - 1);
            }
            else if (character === '{' && trimmed !== '{')
            {
                state.initializerDepth += 1;
            }
            else if (character === '}' && state.initializerDepth > 0)
            {
                state.initializerDepth -= 1;
            }
        }
    }
}

function CheckCMakeIndent(file, content)
{
    const commandLine = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\(|else\s*\(|elseif\s*\(|endif\s*\(|endfunction\s*\(|endmacro\s*\(|endforeach\s*\(|endwhile\s*\()/iu;
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1)
    {
        if (commandLine.test(lines[index]) && LeadingSpaces(lines[index]) % 4 !== 0)
        {
            AddDiagnostic(file, index + 1, 'indent', 'CMake command indentation must be a multiple of 4 spaces');
        }
    }
}

function CppDeclarationLines(content)
{
    // Recognize comments after line splicing, retaining physical diagnostic offsets.
    const logical = [];
    const offsets = [];
    let cursor = 0;
    for (const splice of content.matchAll(/\\[^\S\r\n]*\r?\n/gu))
    {
        while (cursor < splice.index)
        {
            offsets.push(cursor);
            logical.push(content[cursor++]);
        }
        cursor += splice[0].length;
    }
    while (cursor < content.length)
    {
        offsets.push(cursor);
        logical.push(content[cursor++]);
    }
    const source = logical.join('');
    const tokens = /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(?:u8|u|U|L)?"(?:\\.|[^"\\])*"(?:_[A-Za-z0-9_]+)?|(?:u8|u|U|L)?'(?:\\.|[^'\\])*'(?:_[A-Za-z0-9_]+)?/gu;
    const declarations = content.split('');
    const valueTokens = [...declarations];
    const codeTokens = [...declarations];
    let token;
    while ((token = tokens.exec(source)) !== null)
    {
        const start = offsets[token.index];
        let end = offsets[tokens.lastIndex - 1] + 1;
        const literal = !token[0].startsWith('/');
        if (token[1] !== undefined)
        {
            // Raw literal contents retain original bytes, including escaped newlines.
            const closing = `)${token[1]}"`;
            const closingOffset = content.indexOf(closing, end);
            end = closingOffset < 0 ? content.length : closingOffset + closing.length;
            end += content.slice(end).match(/^_[A-Za-z0-9_]+/u)?.[0].length ?? 0;
            while (tokens.lastIndex < offsets.length && offsets[tokens.lastIndex] < end)
            {
                tokens.lastIndex += 1;
            }
        }
        for (let index = start; index < end; index += 1)
        {
            if (content[index] !== '\r' && content[index] !== '\n')
            {
                declarations[index] = ' ';
                valueTokens[index] = ' ';
                if (!literal)
                {
                    codeTokens[index] = ' ';
                }
            }
        }
        if (literal)
        {
            valueTokens[start] = '@';
        }
    }
    const blank = value => value.replace(/[^\r\n]/g, ' ');
    const lines = declarations.join('').split(/\r?\n/u);
    const values = valueTokens.join('').split(/\r?\n/u);
    const code = codeTokens.join('').split(/\r?\n/u);
    let directive = false;
    return lines.map((line, index) =>
    {
        const boundary = /^\s*#/u.test(line);
        const ignored = directive || boundary;
        directive = ignored && /\\\s*$/u.test(line);
        return { boundary,
            declaration: ignored ? blank(line) : line,
            values: ignored ? blank(values[index]) : values[index],
            code: code[index] };
    });
}

const cppTypeKeywords = new Set([
    'void', 'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t', 'short', 'int',
    'long', 'signed', 'unsigned', 'float', 'double', 'auto', '__int128',
    'const', 'volatile', 'class', 'struct', 'enum', 'typename'
]);

function CppNamedParameter(parameter)
{
    const declaration = parameter.split('=')[0].trim();
    const named = declaration.match(/^(.+[\s*&])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)*$/u);
    if (!named || cppTypeKeywords.has(named[2]))
    {
        return null;
    }
    const modifiers = new Set(['const', 'volatile', 'class', 'struct', 'enum', 'typename', 'register']);
    const types = named[1].replace(/[*&]/gu, ' ').trim().split(/\s+/u)
        .filter(token => !modifiers.has(token));
    return types.length > 0 && types.every(token => /^[A-Za-z_][A-Za-z0-9_:]*(?:<[^<>]*>)?$/u.test(token))
        ? named[2] : null;
}

function CppTypeShadow(line)
{
    return line.match(/^\s*using\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1]
        ?? line.match(/^\s*using\s+(?:typename\s+)?(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z_][A-Za-z0-9_]*)\s*;/u)?.[1]
        ?? line.match(/^\s*typedef\b.*\(\s*[*&]\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/u)?.[1]
        ?? line.match(/^\s*typedef\b.*\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^;]*\)|(?:\[[^\]]*\]\s*)*)\s*;/u)?.[1]
        ?? line.match(/^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)/u)?.[1];
}

function RevokeCppValues(scopes)
{
    for (const scope of scopes)
    {
        scope.bindings.clear();
    }
}

function CppCompleteClassScopes(lines)
{
    const classes = new Map();
    const scopes = [];
    let declaration = '';
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1)
    {
        const line = lines[lineIndex].declaration;
        for (let cursor = 0; cursor < line.length; cursor += 1)
        {
            const character = line[cursor];
            if (!['{', '}', ';'].includes(character))
            {
                declaration += character;
                continue;
            }
            const statement = declaration.replace(/^\s*(?:public|protected|private)\s*:\s*/u, '');
            const owner = scopes.at(-1);
            if (owner && character !== '}')
            {
                const alias = CppTypeShadow(`${statement};`);
                if (alias)
                {
                    owner.types.add(alias);
                }
                if (/^\s*(?:using|typedef)\b/u.test(statement)
                    && (!alias || statement.includes(',') || /^\s*typedef\b/u.test(statement) && character === '{'))
                {
                    owner.uncertain = true;
                }
            }
            if (character === '{')
            {
                const classDeclaration = /^\s*(?:template\s*<[\s\S]*>\s*)?(?:using\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*|typedef\s+)?(?:class|struct|union)\b\s*(?:[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?:<[^{};]*>)?)?(?:\s+final)?\s*(?::[^;]*)?$/u.test(
                    statement.replace(/\[\[[\s\S]*?\]\]/gu, '')
                );
                // Base lookup cannot prove an outer value without resolving inherited names.
                const scope = classDeclaration
                    ? { types: new Set(), uncertain: /(?<!:):(?!:)/u.test(statement) }
                    : null;
                scopes.push(scope);
                if (scope)
                {
                    classes.set(`${lineIndex}:${cursor}`, scope);
                }
            }
            else if (character === '}')
            {
                scopes.pop();
            }
            declaration = '';
        }
        declaration += '\n';
    }
    return classes;
}

function IsCppValueArgument(argument, scopes)
{
    const value = argument.trim();
    if (/^(?:@\s*)+$/u.test(value)
        || /^(?:true|false|nullptr|\d+(?:\.\d+)?(?:[uUlLfF])*)$/u.test(value))
    {
        return true;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || cppTypeKeywords.has(value))
    {
        return false;
    }
    for (let index = scopes.length - 1; index >= 0; index -= 1)
    {
        const scope = scopes[index];
        if (scope.bindings.has(value))
        {
            return scope.bindings.get(value);
        }
        if (scope.uncertainClass)
        {
            return false;
        }
    }
    return false;
}

function IsCppObjectInitialization(line, functionMatch, scopes)
{
    if (!functionMatch || !/\)\s*;$/u.test(line))
    {
        return false;
    }
    const argumentsText = line.slice(functionMatch[0].length).replace(/\)\s*;$/u, '');
    // Empty, type-only and unknown arguments retain function declaration enforcement.
    return argumentsText.split(',').every(argument => IsCppValueArgument(argument, scopes));
}

function CheckCpp(file, content, argumentsValue)
{
    const clangFormat = policy.standardTools.cppFormat.command;
    if (IsCommandAvailable(clangFormat))
    {
        const argumentsList = argumentsValue.write
            ? ['-i', '--style=file', file]
            : ['--dry-run', '--Werror', '--style=file', '--fallback-style=none', file];
        const result = Run(clangFormat, argumentsList);
        if (result.status !== 0)
        {
            ToolFailure(file, 'clang-format', result);
        }
    }
    else
    {
        if (argumentsValue.requireTools)
        {
            RequireTool(clangFormat, file);
        }
        CheckCppFallbackIndent(file, content);
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1)
        {
            if (/\b(?:if|for|while|switch|catch)\s*\([^)]*\)\s*\{/u.test(lines[index])
                || /^\s*[A-Za-z_][^;{}]*\([^;{}]*\)\s*\{/u.test(lines[index]))
            {
                AddDiagnostic(file, index + 1, 'allman-brace', 'opening brace must start on the next line');
            }
        }
    }

    const generated = ExceptionApplies('generated-native', file);
    const abiAdapter = ExceptionApplies('c-abi-wasm-export', file);
    const compilerIntrinsic = ExceptionApplies('compiler-intrinsic', file);
    const lines = content.split(/\r?\n/u);
    const declarationLines = CppDeclarationLines(content);
    const classScopes = CppCompleteClassScopes(declarationLines);
    const valueScopes = [{ bindings: new Map(), uncertainClass: false }];
    let pendingParameters = [];
    let pendingTypes = [];
    let braceDepth = 0;
    let pendingExternalBlock = false;
    let externalBlockDepth = null;
    for (let index = 0; index < lines.length; index += 1)
    {
        const parsedLine = declarationLines[index];
        const line = parsedLine.code;
        const declarationLine = parsedLine.declaration;
        if (parsedLine.boundary || /^\s*template\s*</u.test(declarationLine))
        {
            // Preprocessing and template declarations can invalidate visible value evidence.
            RevokeCppValues(valueScopes);
            pendingParameters = [];
            pendingTypes = [];
        }
        const trimmed = line.trim();
        const externalDeclaration = /\bextern\s+"C"/u.test(line)
            || (externalBlockDepth !== null && braceDepth >= externalBlockDepth);
        if (/^extern\s+"C"\s*$/u.test(trimmed))
        {
            pendingExternalBlock = true;
        }
        const type = declarationLine.match(/^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)/u);
        if (!generated && type && !/^[A-Z][A-Za-z0-9]*$/u.test(type[1]))
        {
            AddDiagnostic(file, index + 1, 'cpp-type-name', `${type[1]} must use PascalCase`);
        }

        const statement = /^(?:return|co_return|throw|co_yield|case|delete|new|if|else|for|while|switch|catch|do)\b/u.test(declarationLine.trim());
        const functionMatch = statement
            ? null
            : declarationLine.match(/^\s*(?:(?:extern\s+"C"|static|inline|constexpr|consteval|constinit|const|unsigned|signed|void|bool|int|char|auto|std::[A-Za-z0-9_:<>]+|[A-Za-z_][A-Za-z0-9_:<>]*)\s+)+[*&\s]*([A-Za-z_][A-Za-z0-9_]*)\s*\(/u);
        const objectInitialization = IsCppObjectInitialization(parsedLine.values, functionMatch, [
            ...valueScopes,
            { bindings: new Map(pendingTypes.map(name => [name, false])), uncertainClass: false }
        ]);
        if (!generated
            && functionMatch
            && !objectInitialization
            && functionMatch[1] !== 'main'
            && !/^[A-Z][A-Za-z0-9]*$/u.test(functionMatch[1]))
        {
            const externalAllowed = abiAdapter
                && externalDeclaration
                && /^[a-z][a-z0-9_]*$/u.test(functionMatch[1]);
            const intrinsicAllowed = compilerIntrinsic && /^__(?:builtin|attribute|asm)_[A-Za-z0-9_]+$/u.test(functionMatch[1]);
            if (!externalAllowed && !intrinsicAllowed)
            {
                AddDiagnostic(file, index + 1, 'cpp-function-name', `${functionMatch[1]} must use PascalCase or a registered ABI exception`);
            }
        }

        const alias = CppTypeShadow(declarationLine);
        if (/^\s*(?:using|typedef)\b/u.test(declarationLine) && (!alias || declarationLine.includes(',')))
        {
            RevokeCppValues(valueScopes);
        }
        const valueDeclaration = declarationLine.match(
            /^\s*(?!(?:using|typedef|return|class|struct|enum)\b)(?:[A-Za-z_][A-Za-z0-9_:<>]*[*&]?\s+)+[*&\s]*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[={;])/u
        );
        if (alias)
        {
            valueScopes.at(-1).bindings.set(alias, false);
        }
        else if (valueDeclaration || objectInitialization)
        {
            valueScopes.at(-1).bindings.set(valueDeclaration?.[1] ?? functionMatch[1], true);
        }
        if (/^\s*template\s*</u.test(declarationLine))
        {
            pendingTypes = [...declarationLine.matchAll(/\b(?:class|typename)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)]
                .map(match => match[1]);
        }
        if (functionMatch && !/;\s*$/u.test(declarationLine))
        {
            const parameters = declarationLine.slice(functionMatch[0].length).match(/^([^()]*)\)/u);
            pendingParameters = parameters?.[1].split(',').flatMap(parameter =>
            {
                const named = CppNamedParameter(parameter);
                return named ? [named] : [];
            }) ?? [];
        }
        else if (functionMatch)
        {
            pendingTypes = [];
        }
        for (let cursor = 0; cursor < declarationLine.length; cursor += 1)
        {
            const character = declarationLine[cursor];
            if (character === '{')
            {
                const classScope = classScopes.get(`${index}:${cursor}`);
                // Inline methods see the complete class, including later type declarations.
                valueScopes.push({
                    bindings: new Map([
                        ...[...classScope?.types ?? []].map(name => [name, false]),
                        ...pendingTypes.map(name => [name, false]),
                        ...pendingParameters.map(name => [name, true])
                    ]),
                    uncertainClass: classScope?.uncertain ?? false
                });
                pendingParameters = [];
                pendingTypes = [];
            }
            else if (character === '}' && valueScopes.length > 1)
            {
                valueScopes.pop();
            }
        }

        for (const character of declarationLine)
        {
            if (character === '{')
            {
                braceDepth += 1;
                if (pendingExternalBlock)
                {
                    externalBlockDepth = braceDepth;
                    pendingExternalBlock = false;
                }
            }
            else if (character === '}')
            {
                braceDepth = Math.max(0, braceDepth - 1);
                if (externalBlockDepth !== null && braceDepth < externalBlockDepth)
                {
                    externalBlockDepth = null;
                }
            }
        }
    }

    if (argumentsValue.operation !== 'lint')
    {
        return;
    }
    if (!IsCppTranslationUnit(file))
    {
        return;
    }
    const clangTidy = policy.standardTools.cppLint.command;
    if (!IsCommandAvailable(clangTidy))
    {
        if (argumentsValue.requireTools)
        {
            RequireTool(clangTidy, file);
        }
        return;
    }
    const compileDatabase = FindCompileCommandDatabase(file);
    if (!compileDatabase)
    {
        if (argumentsValue.requireTools)
        {
            AddDiagnostic(file, 1, 'missing-compile-command', 'clang-tidy requires a matching compile_commands.json entry');
        }
        return;
    }
    const tidyResult = Run(clangTidy, [
        '--quiet',
        '-p',
        compileDatabase.directory,
        file,
        ...ClangTidyDriverArguments(compileDatabase)
    ]);
    if (tidyResult.status !== 0 || /(?:warning|error):/u.test(`${tidyResult.stdout}\n${tidyResult.stderr}`))
    {
        ToolFailure(file, 'clang-tidy', tidyResult);
    }
}

function ExceptionApplies(id, file)
{
    const item = exceptionRegistry?.exceptions?.find((entry) => entry.id === id);
    return item ? MatchesAny(file, CompilePatterns(item.paths)) : false;
}

function CheckCMake(file, content, argumentsValue)
{
    const formatter = policy.standardTools.cmakeFormat.command;
    if (IsCommandAvailable(formatter))
    {
        const args = argumentsValue.write ? ['-i', file] : ['--check', file];
        const result = Run(formatter, args);
        if (result.status !== 0)
        {
            ToolFailure(file, 'cmake-format', result);
        }
    }
    else
    {
        if (argumentsValue.requireTools)
        {
            RequireTool(formatter, file);
        }
        CheckCMakeIndent(file, content);
    }

    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1)
    {
        const functionMatch = lines[index].match(/^\s*(?:function|macro)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/iu);
        if (functionMatch && !/^[A-Z][A-Za-z0-9]*$/u.test(functionMatch[1]))
        {
            AddDiagnostic(file, index + 1, 'cmake-function-name', `${functionMatch[1]} must use PascalCase`);
        }
        const variableMatch = lines[index].match(/^\s*set\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/iu);
        if (variableMatch
            && !/^[a-z][A-Za-z0-9]*$/u.test(variableMatch[1])
            && !/^(?:CMAKE|CTEST|CPACK|FSUSBLOG)_[A-Z0-9_]+$/u.test(variableMatch[1]))
        {
            AddDiagnostic(file, index + 1, 'cmake-variable-name', `${variableMatch[1]} must use camelCase or a registered cache/environment name`);
        }
    }
}

function HasUnsafeShellExpansion(line)
{
    const trimmed = line.trim();
    if (!trimmed
        || trimmed.startsWith('#')
        || line.includes('[[')
        || line.includes(']]')
        || line.includes('((')
        || line.includes('))')
        || /\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\+"\$\{/u.test(line)
        || /\$\{[A-Za-z_][A-Za-z0-9_]*#"\$[A-Za-z_][A-Za-z0-9_]*"\//u.test(line)
        || /^for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/u.test(trimmed)
        || /^(?:export|readonly|local|declare|typeset)\b/u.test(trimmed)
        || /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?\+?=/u.test(trimmed)
        || /^\[\[.*\]\](?:\s*(?:&&|\|\|).*)?$/u.test(trimmed)
        || /^\(\(.*\)\)(?:\s*(?:&&|\|\|).*)?$/u.test(trimmed)
        || /^case\s+/u.test(trimmed))
    {
        return false;
    }

    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1)
    {
        const character = line[index];
        if (quote === "'")
        {
            if (character === "'")
            {
                quote = null;
            }
            continue;
        }
        if (quote === '"' || quote === '`')
        {
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (character === '\\')
            {
                escaped = true;
                continue;
            }
            if (quote === '"' && character === '$' && line[index + 1] === '(')
            {
                let depth = 1;
                let nestedQuote = null;
                let nestedEscaped = false;
                for (let nestedIndex = index + 2; nestedIndex < line.length; nestedIndex += 1)
                {
                    const nestedCharacter = line[nestedIndex];
                    if (nestedQuote)
                    {
                        if (nestedEscaped)
                        {
                            nestedEscaped = false;
                        }
                        else if (nestedCharacter === '\\' && nestedQuote === '"')
                        {
                            nestedEscaped = true;
                        }
                        else if (nestedCharacter === nestedQuote)
                        {
                            nestedQuote = null;
                        }
                        continue;
                    }
                    if (nestedCharacter === "'" || nestedCharacter === '"')
                    {
                        nestedQuote = nestedCharacter;
                    }
                    else if (nestedCharacter === '$' && line[nestedIndex + 1] === '(')
                    {
                        depth += 1;
                        nestedIndex += 1;
                    }
                    else if (nestedCharacter === ')')
                    {
                        depth -= 1;
                        if (depth === 0)
                        {
                            index = nestedIndex;
                            break;
                        }
                    }
                }
                continue;
            }
            if (character === quote)
            {
                quote = null;
            }
            continue;
        }
        if (escaped)
        {
            escaped = false;
            continue;
        }
        if (character === '\\')
        {
            escaped = true;
            continue;
        }
        if (character === '#'
            && (index === 0 || /\s/u.test(line[index - 1])))
        {
            break;
        }
        if (character === "'" || character === '"' || character === '`')
        {
            quote = character;
            continue;
        }
        if (character === '$'
            && (/[A-Za-z_{]/u.test(line[index + 1] ?? '')))
        {
            return true;
        }
    }
    return false;
}

function CheckShell(file, content, argumentsValue)
{
    const lines = content.split(/\r?\n/u);
    const ignoredLines = ShellIgnoredLineIndexes(content);
    const shellContent = lines
        .map((line, index) => ignoredLines.has(index) ? '' : line)
        .join('\n');
    const dotnetConfigurationEnvironment = ExceptionApplies('dotnet-configuration-environment', file);
    const shellEnvironmentVariable = ExceptionApplies('shell-environment-variable', file);
    CheckFourSpaceIndent(file, content, ignoredLines);
    if (!lines[0]?.startsWith('#!'))
    {
        AddDiagnostic(file, 1, 'shell-shebang', 'shell scripts require an explicit interpreter');
    }
    const strictLine = lines.findIndex((line) =>
        /^set -(?=[A-Za-z]*e)(?=[A-Za-z]*u)(?=[A-Za-z]*o)[A-Za-z]+ pipefail(?:\s|$)/u.test(line.trim()));
    if (strictLine < 0)
    {
        AddDiagnostic(file, 1, 'shell-strict-mode', 'shell scripts require set -euo pipefail');
    }
    const shellLines = shellContent.split('\n');
    const createsTemporaryResource = shellLines.some((line) =>
        /\$\(\s*mktemp\b/u.test(line) || /^\s*(?:command\s+)?(?:mktemp|coproc)\b/u.test(line));
    const launchesUnmanagedBackgroundJob = shellLines.some((line) =>
        /(?:^|\s)&\s*(?:#.*)?$/u.test(line) && !/\bnohup\s+setsid\b/u.test(line));
    if ((createsTemporaryResource || launchesUnmanagedBackgroundJob)
        && !/^\s*trap\s+.+\b(?:EXIT|RETURN)\b/mu.test(shellContent))
    {
        AddDiagnostic(file, 1, 'shell-cleanup-trap', 'temporary or background resources require an EXIT/RETURN cleanup trap');
    }
    for (let index = 0; index < lines.length; index += 1)
    {
        if (ignoredLines.has(index))
        {
            continue;
        }
        const functionMatch = lines[index].match(/^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\))\s*\{/u);
        const functionName = functionMatch?.[1] ?? functionMatch?.[2];
        if (functionName && !/^[A-Z][A-Za-z0-9]*$/u.test(functionName))
        {
            AddDiagnostic(file, index + 1, 'shell-function-name', `${functionName} must use PascalCase`);
        }
        const localMatch = lines[index].match(/^\s*local\s+(-[A-Za-z]+\s+)?([A-Za-z_][A-Za-z0-9_]*)/u);
        const localName = localMatch?.[2];
        const exportedLocal = localMatch?.[1]?.includes('x') ?? false;
        const registeredExternalLocal = exportedLocal
            && ((shellEnvironmentVariable && /^[A-Z][A-Z0-9_]*$/u.test(localName ?? ''))
                || (dotnetConfigurationEnvironment
                    && /^[A-Za-z][A-Za-z0-9]*(?:__[A-Za-z0-9]+)+$/u.test(localName ?? '')));
        if (localName && !registeredExternalLocal && !/^[a-z][A-Za-z0-9]*$/u.test(localName))
        {
            AddDiagnostic(file, index + 1, 'shell-local-name', `${localName} must use camelCase`);
        }
        const exportMatch = lines[index].match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)/u);
        const registeredDotnetKey = dotnetConfigurationEnvironment
            && /^[A-Za-z][A-Za-z0-9]*(?:__[A-Za-z0-9]+)+$/u.test(exportMatch?.[1] ?? '');
        if (exportMatch
            && !/^[A-Z][A-Z0-9_]*$/u.test(exportMatch[1])
            && !registeredDotnetKey)
        {
            AddDiagnostic(file, index + 1, 'shell-export-name', `${exportMatch[1]} must use UPPER_SNAKE_CASE`);
        }
        const intentionalWordSplitting = /shellcheck\s+disable=SC2086|intentional\s+word\s+splitting/iu.test(lines[index - 1] ?? '');
        if (!intentionalWordSplitting && HasUnsafeShellExpansion(lines[index]))
        {
            AddDiagnostic(file, index + 1, 'shell-quote', 'quote variable expansions unless intentional word splitting is documented');
        }
    }

    const shellcheck = policy.standardTools.shellLint.command;
    if (IsCommandAvailable(shellcheck))
    {
        const result = Run(shellcheck, [file]);
        if (result.status !== 0)
        {
            ToolFailure(file, 'shellcheck', result);
        }
    }
    else if (argumentsValue.requireTools)
    {
        RequireTool(shellcheck, file);
    }

    const shfmt = policy.standardTools.shellFormat.command;
    if (IsCommandAvailable(shfmt))
    {
        const result = Run(shfmt, argumentsValue.write ? ['-w', '-i', '4', '-ci', file] : ['-d', '-i', '4', '-ci', file]);
        if (result.status !== 0)
        {
            ToolFailure(file, 'shfmt', result);
        }
    }
    else if (argumentsValue.requireTools)
    {
        RequireTool(shfmt, file);
    }
}

function CheckYaml(file, content, argumentsValue)
{
    const levels = new Map();
    const lines = content.split(/\r?\n/u);
    const activeSequenceIndents = new Set();
    let blockScalarIndent = null;
    for (let index = 0; index < lines.length; index += 1)
    {
        const raw = lines[index];
        const indentation = LeadingSpaces(raw);
        const text = raw.trim();
        if (!text)
        {
            continue;
        }

        if (blockScalarIndent !== null)
        {
            if (indentation > blockScalarIndent)
            {
                continue;
            }
            blockScalarIndent = null;
        }

        if (text.startsWith('#') || text === '---' || text === '...')
        {
            continue;
        }

        const sequenceItem = /^-(?:\s|$)/u.test(text);
        for (const sequenceIndent of [...activeSequenceIndents])
        {
            if (sequenceIndent > indentation || (sequenceIndent === indentation && !sequenceItem))
            {
                activeSequenceIndents.delete(sequenceIndent);
            }
        }
        const insideSequenceMapping = [...activeSequenceIndents]
            .some((sequenceIndent) => sequenceIndent < indentation);
        const alignedSequenceMapping = indentation % 4 === 2 && insideSequenceMapping;
        if (indentation % 4 !== 0 && !alignedSequenceMapping)
        {
            AddDiagnostic(file, index + 1, 'indent', 'YAML mapping levels use 4 spaces; sequence mapping continuations retain the syntax-required 2-space offset');
        }
        for (const level of [...levels.keys()])
        {
            if (level > indentation)
            {
                levels.delete(level);
            }
        }
        if (sequenceItem)
        {
            levels.delete(indentation);
            activeSequenceIndents.add(indentation);
        }
        const keyMatch = text.match(/^(?:-\s+)?([^#'"{}[\],][^:]*):(?:\s|$)/u);
        if (!keyMatch)
        {
            continue;
        }
        const key = keyMatch[1].trim();
        const keys = levels.get(indentation) ?? new Set();
        if (keys.has(key))
        {
            AddDiagnostic(file, index + 1, 'yaml-duplicate-key', `duplicate mapping key ${key}`);
        }
        keys.add(key);
        levels.set(indentation, keys);

        if (/(?:^-(?:\s+)|:\s*)[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/u.test(text))
        {
            blockScalarIndent = indentation;
        }
    }

    const yamllint = policy.standardTools.yamlLint.command;
    if (IsCommandAvailable(yamllint))
    {
        const result = Run(yamllint, ['-c', policy.standardTools.yamlLint.configuration, file]);
        if (result.status !== 0)
        {
            ToolFailure(file, 'yamllint', result);
        }
    }
    else if (argumentsValue.requireTools)
    {
        RequireTool(yamllint, file);
    }

    if (/^\.github\/workflows\//u.test(file))
    {
        const actionlint = policy.standardTools.githubActionsLint.command;
        if (IsCommandAvailable(actionlint))
        {
            const result = Run(actionlint, ['-config-file', policy.standardTools.githubActionsLint.configuration, file]);
            if (result.status !== 0)
            {
                ToolFailure(file, 'actionlint', result);
            }
        }
        else if (argumentsValue.requireTools)
        {
            RequireTool(actionlint, file);
        }
    }
}

function StripJsonComments(content)
{
    let output = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < content.length; index += 1)
    {
        const character = content[index];
        const next = content[index + 1];
        if (lineComment)
        {
            if (character === '\n')
            {
                lineComment = false;
                output += '\n';
            }
            else
            {
                output += ' ';
            }
            continue;
        }
        if (blockComment)
        {
            if (character === '*' && next === '/')
            {
                blockComment = false;
                output += '  ';
                index += 1;
            }
            else
            {
                output += character === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (inString)
        {
            output += character;
            if (escaped)
            {
                escaped = false;
            }
            else if (character === '\\')
            {
                escaped = true;
            }
            else if (character === '"')
            {
                inString = false;
            }
            continue;
        }
        if (character === '"')
        {
            inString = true;
            output += character;
        }
        else if (character === '/' && next === '/')
        {
            lineComment = true;
            output += '  ';
            index += 1;
        }
        else if (character === '/' && next === '*')
        {
            blockComment = true;
            output += '  ';
            index += 1;
        }
        else
        {
            output += character;
        }
    }
    return output;
}

function RemoveJsonTrailingCommas(content)
{
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < content.length; index += 1)
    {
        const character = content[index];
        if (inString)
        {
            output += character;
            if (escaped)
            {
                escaped = false;
            }
            else if (character === '\\')
            {
                escaped = true;
            }
            else if (character === '"')
            {
                inString = false;
            }
            continue;
        }
        if (character === '"')
        {
            inString = true;
            output += character;
            continue;
        }
        if (character === ',')
        {
            let next = index + 1;
            while (/\s/u.test(content[next] ?? ''))
            {
                next += 1;
            }
            if (content[next] === '}' || content[next] === ']')
            {
                output += ' ';
                continue;
            }
        }
        output += character;
    }
    return output;
}

function NormalizeJsonc(content)
{
    return RemoveJsonTrailingCommas(StripJsonComments(content));
}

function TokenizeJson(content)
{
    const tokens = [];
    let index = 0;
    let line = 1;
    while (index < content.length)
    {
        const character = content[index];
        if (/\s/u.test(character))
        {
            if (character === '\n')
            {
                line += 1;
            }
            index += 1;
            continue;
        }
        if ('{}[]:,'.includes(character))
        {
            tokens.push({ type: character, value: character, raw: character, line });
            index += 1;
            continue;
        }
        if (character === '"')
        {
            const start = index;
            index += 1;
            let escaped = false;
            while (index < content.length)
            {
                const current = content[index];
                if (current === '\n')
                {
                    line += 1;
                }
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
                    index += 1;
                    break;
                }
                index += 1;
            }
            const source = content.slice(start, index);
            tokens.push({ type: 'string', value: JSON.parse(source), raw: source, line });
            continue;
        }
        const match = content.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u);
        if (!match)
        {
            throw new Error(`unexpected token at line ${line}`);
        }
        tokens.push({ type: 'literal', value: match[0], raw: match[0], line });
        index += match[0].length;
    }
    return tokens;
}

function FormatJsonTokens(tokens)
{
    let output = '';
    let indentation = 0;
    for (let index = 0; index < tokens.length; index += 1)
    {
        const token = tokens[index];
        const previous = tokens[index - 1];
        const next = tokens[index + 1];
        if (token.type === '{' || token.type === '[')
        {
            output += token.raw;
            if (!((token.type === '{' && next?.type === '}') || (token.type === '[' && next?.type === ']')))
            {
                indentation += 1;
                output += `\n${' '.repeat(indentation * 4)}`;
            }
        }
        else if (token.type === '}' || token.type === ']')
        {
            const matchingOpen = token.type === '}' ? '{' : '[';
            if (previous?.type !== matchingOpen)
            {
                indentation -= 1;
                output += `\n${' '.repeat(indentation * 4)}`;
            }
            output += token.raw;
        }
        else if (token.type === ',')
        {
            output += `,\n${' '.repeat(indentation * 4)}`;
        }
        else if (token.type === ':')
        {
            output += ': ';
        }
        else
        {
            output += token.raw;
        }
    }
    return `${output}\n`;
}

function FindDuplicateJsonKeys(content)
{
    const tokens = TokenizeJson(content);
    const duplicates = [];
    let cursor = 0;

    function ParseValue()
    {
        const token = tokens[cursor];
        if (!token)
        {
            return;
        }
        if (token.type === '{')
        {
            ParseObject();
        }
        else if (token.type === '[')
        {
            cursor += 1;
            while (tokens[cursor] && tokens[cursor].type !== ']')
            {
                ParseValue();
                if (tokens[cursor]?.type === ',')
                {
                    cursor += 1;
                }
            }
            cursor += tokens[cursor]?.type === ']' ? 1 : 0;
        }
        else
        {
            cursor += 1;
        }
    }

    function ParseObject()
    {
        cursor += 1;
        const keys = new Set();
        while (tokens[cursor] && tokens[cursor].type !== '}')
        {
            const key = tokens[cursor];
            if (key.type !== 'string')
            {
                cursor += 1;
                continue;
            }
            if (keys.has(key.value))
            {
                duplicates.push({ key: key.value, line: key.line });
            }
            keys.add(key.value);
            cursor += 1;
            if (tokens[cursor]?.type === ':')
            {
                cursor += 1;
            }
            ParseValue();
            if (tokens[cursor]?.type === ',')
            {
                cursor += 1;
            }
        }
        cursor += tokens[cursor]?.type === '}' ? 1 : 0;
    }

    ParseValue();
    return duplicates;
}

function FormatJsonWithComments(content)
{
    let depth = 0;
    let inBlockComment = false;
    const output = [];
    for (const rawLine of NormalizeText(content).split('\n'))
    {
        const text = rawLine.trimStart();
        if (!text)
        {
            output.push('');
            continue;
        }

        const closesContainer = !inBlockComment && /^[}\]]/u.test(text);
        output.push(`${' '.repeat(Math.max(0, depth - (closesContainer ? 1 : 0)) * 4)}${text}`);

        let inString = false;
        let escaped = false;
        for (let index = 0; index < text.length; index += 1)
        {
            const character = text[index];
            const next = text[index + 1];
            if (inBlockComment)
            {
                if (character === '*' && next === '/')
                {
                    inBlockComment = false;
                    index += 1;
                }
                continue;
            }
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (character === '\\')
                {
                    escaped = true;
                }
                else if (character === '"')
                {
                    inString = false;
                }
                continue;
            }
            if (character === '"')
            {
                inString = true;
            }
            else if (character === '/' && next === '/')
            {
                break;
            }
            else if (character === '/' && next === '*')
            {
                inBlockComment = true;
                index += 1;
            }
            else if (character === '{' || character === '[')
            {
                depth += 1;
            }
            else if (character === '}' || character === ']')
            {
                depth = Math.max(0, depth - 1);
            }
        }
    }
    return `${output.join('\n').replace(/\n+$/u, '')}\n`;
}

function CheckJson(file, content, argumentsValue)
{
    const jsonc = file.endsWith('.jsonc') || MatchesAny(file, jsonWithCommentsPatterns);
    const normalizedSource = jsonc ? NormalizeJsonc(content) : content;
    try
    {
        JSON.parse(normalizedSource);
    }
    catch (error)
    {
        AddDiagnostic(file, 1, 'json-syntax', error.message);
        return;
    }

    try
    {
        const tokens = TokenizeJson(normalizedSource);
        for (const token of tokens)
        {
            if (token.type === 'literal'
                && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token.raw)
                && !Number.isFinite(Number(token.raw)))
            {
                AddDiagnostic(file, token.line, 'json-non-finite', `number is outside the finite JSON consumer range: ${token.raw}`);
            }
        }
        for (const duplicate of FindDuplicateJsonKeys(normalizedSource))
        {
            AddDiagnostic(file, duplicate.line, 'json-duplicate-key', `duplicate object key ${duplicate.key}`);
        }
    }
    catch (error)
    {
        AddDiagnostic(file, 1, 'json-token', error.message);
    }

    if (!jsonc)
    {
        const expected = FormatJsonTokens(TokenizeJson(content));
        if (argumentsValue.write)
        {
            fs.writeFileSync(path.join(root, file), expected);
        }
        else if (content !== expected)
        {
            AddDiagnostic(file, 1, 'json-format', 'JSON must use stable existing key order and 4-space indentation');
        }
    }
    else
    {
        const formatted = FormatJsonWithComments(content);
        if (argumentsValue.write && formatted !== content)
        {
            fs.writeFileSync(path.join(root, file), formatted);
        }
        CheckFourSpaceIndent(file, argumentsValue.write ? formatted : content);
    }
}

function MarkdownFrontMatterEnd(file, lines)
{
    if (lines[0] !== '---')
    {
        return 0;
    }

    const closing = lines.findIndex((line, index) => index > 0 && line === '---');
    if (closing < 0)
    {
        AddDiagnostic(file, 1, 'markdown-front-matter', 'front matter is not closed');
        return lines.length;
    }

    const keys = new Set();
    for (let index = 1; index < closing; index += 1)
    {
        const match = lines[index].match(/^([a-z][a-zA-Z0-9-]*):[ \t]+(.\S|\S.*)$/u);
        if (!match)
        {
            AddDiagnostic(file, index + 1, 'markdown-front-matter', 'front matter uses non-empty scalar key/value fields');
            continue;
        }
        const [, key, value] = match;
        if (keys.has(key))
        {
            AddDiagnostic(file, index + 1, 'markdown-front-matter', `duplicate front matter key ${key}`);
        }
        keys.add(key);
        if (index === 1 && key !== 'schema')
        {
            AddDiagnostic(file, index + 1, 'markdown-front-matter', 'schema must be the first front matter field');
        }
        if (key === 'schema' && value.trim() !== 'fsusblog.markdown-document.v1')
        {
            AddDiagnostic(file, index + 1, 'markdown-front-matter', 'unsupported Markdown document schema');
        }
    }
    if (!keys.has('schema'))
    {
        AddDiagnostic(file, 1, 'markdown-front-matter', 'front matter requires schema fsusblog.markdown-document.v1');
    }
    return closing + 1;
}

function MarkdownLinkDestinations(line)
{
    const destinations = [];
    const inline = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\[()]|[^()\s]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;
    for (const match of line.matchAll(inline))
    {
        destinations.push(match[1]);
    }
    const reference = line.match(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/u);
    if (reference)
    {
        destinations.push(reference[1]);
    }
    return destinations;
}

function CheckMarkdownLink(file, line, destinationValue)
{
    let destination = destinationValue.trim().replace(/^<|>$/gu, '');
    destination = destination.replace(/\\([()])/gu, '$1');
    if (!destination || /^(?:[a-z][a-z0-9+.-]*:|#|\/|\/\/)/iu.test(destination))
    {
        return;
    }
    const encodedPath = destination.split(/[?#]/u)[0];
    if (!encodedPath)
    {
        return;
    }

    let relative;
    try
    {
        relative = decodeURIComponent(encodedPath);
    }
    catch
    {
        AddDiagnostic(file, line, 'markdown-link', `relative link has invalid percent encoding: ${encodedPath}`);
        return;
    }
    if (relative.includes('\\') || relative.includes('\0'))
    {
        AddDiagnostic(file, line, 'markdown-link', `relative link uses an invalid path: ${relative}`);
        return;
    }

    const resolved = path.resolve(root, path.dirname(file), relative);
    const rootRelative = path.relative(root, resolved);
    if (rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative))
    {
        AddDiagnostic(file, line, 'markdown-link', `relative link escapes the repository: ${relative}`);
        return;
    }
    if (!fs.existsSync(resolved))
    {
        AddDiagnostic(file, line, 'markdown-link', `relative link does not exist: ${relative}`);
    }
}

function BindMarkdownAnchors(file, content)
{
    const record = policy.markdownCompatibilityAnchors.find((entry) => entry.documentPath === file);
    if (!record)
    {
        return;
    }
    const lines = content.split(/\r?\n/u);
    const firstGenerated = lines.findIndex((line) => line.startsWith('<!-- FSUSBLOG-GENERATED:BEGIN '));
    const active = new Set();
    let fence = null;
    let comment = false;
    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index];
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
        if (!comment && marker)
        {
            if (!fence)
            {
                fence = marker[1];
            }
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
            {
                fence = null;
            }
            continue;
        }
        if (fence)
        {
            continue;
        }
        if (!comment && !line.includes('<!--'))
        {
            active.add(index);
        }
        for (const markerValue of line.matchAll(/<!--|-->/gu))
        {
            comment = markerValue[0] === '<!--';
        }
    }
    const bindings = [];
    for (const entry of record.anchors)
    {
        const whole = `<a id="${entry.id}"></a>`;
        const indexes = lines.flatMap((line, index) => line === whole ? [index] : []);
        const index = indexes[0];
        if (indexes.length !== 1 || !active.has(index) || lines[index - 1] !== ''
            || lines[index + 1] !== '' || lines[index + 2] !== entry.heading
            || lines.filter((line) => line === entry.heading).length !== 1
            || !active.has(index + 2) || (firstGenerated >= 0 && index >= firstGenerated))
        {
            AddDiagnostic(file, (index ?? 0) + 1, 'markdown-anchor-source', `missing, duplicate, hidden or misplaced exact alias ${entry.id}`);
            continue;
        }
        bindings.push({ line: index + 1, range: [1, whole.length - '</a>'.length], whole });
    }
    markdownAnchorBindings.set(file, { content, bindings, complete: bindings.length === record.anchors.length });
}

function CheckMarkdown(file, content)
{
    BindMarkdownAnchors(file, content);
    const lines = content.split(/\r?\n/u);
    let inFence = false;
    let fenceMarker = '';
    let fenceLength = 0;
    let previousHeading = 0;
    const contentStart = MarkdownFrontMatterEnd(file, lines);
    for (let index = contentStart; index < lines.length; index += 1)
    {
        const line = lines[index];
        const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
        if (fence)
        {
            if (!inFence)
            {
                inFence = true;
                fenceMarker = fence[1][0];
                fenceLength = fence[1].length;
                if (!fence[2].trim())
                {
                    AddDiagnostic(file, index + 1, 'markdown-fence-language', 'opening code fence requires a language');
                }
            }
            else if (fence[1][0] === fenceMarker && fence[1].length >= fenceLength && !fence[2].trim())
            {
                inFence = false;
                fenceMarker = '';
                fenceLength = 0;
            }
            continue;
        }
        if (inFence)
        {
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+\S/u);
        if (heading)
        {
            const level = heading[1].length;
            if (previousHeading > 0 && level > previousHeading + 1)
            {
                AddDiagnostic(file, index + 1, 'markdown-heading-level', `heading jumps from h${previousHeading} to h${level}`);
            }
            previousHeading = level;
        }
        const list = line.match(/^( +)(?:[-+*]|\d+[.)])\s/u);
        if (list && list[1].length % 4 !== 0)
        {
            AddDiagnostic(file, index + 1, 'markdown-list-indent', 'nested lists use 4-space indentation');
        }
        for (const destination of MarkdownLinkDestinations(line))
        {
            CheckMarkdownLink(file, index + 1, destination);
        }
    }
    if (inFence)
    {
        AddDiagnostic(file, lines.length, 'markdown-fence-balance', 'code fence is not closed');
    }

}

function CheckMarkdownTool(files, argumentsValue)
{
    if (files.length === 0)
    {
        return;
    }
    const markdownlint = policy.standardTools.markdownLint.command;
    const registered = files.filter((file) => markdownAnchorBindings.has(file));
    if (!IsCommandAvailable(markdownlint))
    {
        for (const file of registered)
        {
            AddDiagnostic(file, 1, 'markdown-anchor-span', 'actual Markdownlint parser spans are unavailable; portable source checks are not admission');
        }
        if (argumentsValue.requireTools)
        {
            RequireTool(markdownlint, policy.standardTools.markdownLint.configuration);
        }
        return;
    }

    const toolArguments = [
        '--config',
        policy.standardTools.markdownLint.configuration,
        '--no-globs',
        ...files.map((file) => `:${file}`)
    ];
    let result;
    if (registered.length > 0)
    {
        const executable = (process.env.PATH ?? '').split(path.delimiter)
            .map((directory) => path.resolve(directory, markdownlint))
            .find((file) =>
            {
                try { fs.accessSync(file, fs.constants.X_OK); return true; }
                catch { return false; }
            });
        result = Run(process.execPath, [scriptPath, '--markdownlint-spans', executable, ...toolArguments]);
        CheckMarkdownSpans(files, registered, result);
        return;
    }
    result = Run(markdownlint, toolArguments);
    if (result.status === 0)
    {
        return;
    }

    let parsed = 0;
    for (const outputLine of `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split(/\r?\n/u))
    {
        const match = outputLine.match(/^(.+\.md):(\d+)(?::\d+)? error (MD\d{3})\S*\s+(.+)$/u);
        if (!match)
        {
            continue;
        }
        parsed += 1;
        AddDiagnostic(ToPosix(match[1]), Number.parseInt(match[2], 10), `markdownlint-${match[3].toLowerCase()}`, match[4]);
    }
    if (parsed === 0)
    {
        ToolFailure(policy.standardTools.markdownLint.configuration, 'markdownlint', result);
    }
}

function CheckMarkdownSpans(files, registered, result)
{
    const payloads = (result.stdout ?? '').split(/\r?\n/u)
        .filter((line) => line.startsWith(markdownSpanPrefix));
    const rawLines = (result.stderr ?? '').split(/\r?\n/u).filter(Boolean);
    let findings;
    try
    {
        if (payloads.length !== 1 || ![0, 1].includes(result.status) || result.error || result.signal)
        {
            throw new Error('missing/duplicate structured output or abnormal original CLI terminal');
        }
        findings = JSON.parse(payloads[0].slice(markdownSpanPrefix.length));
        if (!Array.isArray(findings))
        {
            throw new Error('invalid original formatter result');
        }
        const expectedRaw = findings.map((entry) => `${entry.fileName}:${entry.lineNumber}${entry.errorRange?.[0] ? `:${entry.errorRange[0]}` : ''}${entry.severity ? ` ${entry.severity}` : ''} ${entry.ruleNames.join('/')} ${entry.ruleDescription}${entry.errorDetail ? ` [${entry.errorDetail}]` : ''}${entry.errorContext ? ` [Context: "${entry.errorContext}"]` : ''}`);
        if (JSON.stringify(rawLines) !== JSON.stringify(expectedRaw)
            || result.status !== (findings.some((entry) => entry.severity !== 'warning') ? 1 : 0))
        {
            throw new Error('raw original diagnostics or exit status do not match parser results');
        }
    }
    catch (error)
    {
        AddDiagnostic(policy.standardTools.markdownLint.configuration, 1, 'markdown-anchor-span', error.message);
        ToolFailure(policy.standardTools.markdownLint.configuration, 'markdownlint', result);
        return;
    }
    const consumed = new Set();
    for (const file of registered)
    {
        const state = markdownAnchorBindings.get(file);
        if (!state.complete || fs.readFileSync(path.join(root, file), 'utf8') !== state.content)
        {
            AddDiagnostic(file, 1, 'markdown-anchor-span', 'registered source closure is incomplete or changed during lint');
            continue;
        }
        for (const binding of state.bindings)
        {
            const matches = findings.flatMap((entry, index) => entry.fileName === file
                && entry.lineNumber === binding.line && entry.ruleNames?.[0] === 'MD033'
                && entry.ruleDescription === 'Inline HTML' && entry.errorDetail === 'Element: a'
                && JSON.stringify(entry.errorRange) === JSON.stringify(binding.range)
                && state.content.split(/\r?\n/u)[entry.lineNumber - 1] === binding.whole ? [index] : []);
            if (matches.length !== 1 || consumed.has(matches[0]))
            {
                AddDiagnostic(file, binding.line, 'markdown-anchor-span', 'exact original parser finding/source span is not uniquely bound');
            }
            else
            {
                consumed.add(matches[0]);
            }
        }
    }
    for (let index = 0; index < findings.length; index += 1)
    {
        const entry = findings[index];
        if (!files.includes(entry.fileName) || !Number.isSafeInteger(entry.lineNumber) || entry.lineNumber <= 0
            || !Array.isArray(entry.ruleNames) || !/^MD\d{3}$/u.test(entry.ruleNames[0]))
        {
            AddDiagnostic(policy.standardTools.markdownLint.configuration, 1, 'markdown-anchor-span', 'unbound parser diagnostic');
        }
        else if (!consumed.has(index))
        {
            AddDiagnostic(entry.fileName, entry.lineNumber, `markdownlint-${entry.ruleNames[0].toLowerCase()}`, `${entry.ruleDescription}${entry.errorDetail ? ` [${entry.errorDetail}]` : ''}${entry.errorContext ? ` [Context: "${entry.errorContext}"]` : ''}`);
        }
    }
    process.stdout.write(`[native-tooling-style] compatibility-aliases=${consumed.size} raw-markdownlint-exit=${result.status}\n`);
}

function ApplyGenericFormat(file, content)
{
    const normalized = NormalizeText(content);
    if (normalized !== content)
    {
        fs.writeFileSync(path.join(root, file), normalized);
    }
}

function CheckFile(file, argumentsValue)
{
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    {
        AddDiagnostic(file, 1, 'missing-file', 'selected file does not exist');
        return;
    }

    let buffer = fs.readFileSync(absolute);
    let content = buffer.toString('utf8');
    if (argumentsValue.write)
    {
        ApplyGenericFormat(file, content);
        buffer = fs.readFileSync(absolute);
        content = buffer.toString('utf8');
    }
    CheckPhysical(file, buffer, content);

    const extension = path.posix.extname(file).toLowerCase();
    const basename = path.posix.basename(file);
    if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(extension))
    {
        CheckCpp(file, content, argumentsValue);
    }
    else if (extension === '.cmake' || basename === 'CMakeLists.txt')
    {
        CheckCMake(file, content, argumentsValue);
    }
    else if (extension === '.sh')
    {
        CheckShell(file, content, argumentsValue);
    }
    else if (extension === '.yaml' || extension === '.yml')
    {
        CheckYaml(file, content, argumentsValue);
    }
    else if (extension === '.json' || extension === '.jsonc')
    {
        CheckJson(file, content, argumentsValue);
    }
    else if (extension === '.md')
    {
        CheckMarkdown(file, content);
    }
}

function PrintDiagnostics()
{
    diagnostics.sort((left, right) => left.file.localeCompare(right.file)
        || left.line - right.line
        || left.rule.localeCompare(right.rule)
        || left.message.localeCompare(right.message));
    for (const diagnostic of diagnostics)
    {
        process.stderr.write(`${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}: ${diagnostic.message}\n`);
    }
}

function Main()
{
    const argumentsValue = ParseArguments(process.argv.slice(2));
    root = path.resolve(argumentsValue.root ?? repositoryRoot);
    policyPath = path.resolve(root, argumentsValue.policy ?? defaultPolicy);
    policy = ReadJson(policyPath, 'native/tooling style policy');
    if (!ValidatePolicy())
    {
        PrintDiagnostics();
        process.exitCode = 1;
        return;
    }

    const exclusions = CompilePatterns(policy.excludedPaths);
    jsonWithCommentsPatterns = CompilePatterns(policy.jsonWithCommentsPaths ?? []);
    LoadExceptionRegistry();
    if (argumentsValue.updateBaseline)
    {
        if (diagnostics.length > 0)
        {
            PrintDiagnostics();
            process.exitCode = 1;
            return;
        }
        UpdateBaseline(argumentsValue, exclusions);
        return;
    }
    LoadBaseline();

    const selected = SelectFiles(argumentsValue, exclusions);
    let checked = 0;
    let baselineExempt = 0;
    const checkedMarkdown = [];
    for (const file of selected)
    {
        const absolute = path.resolve(root, file);
        if (argumentsValue.mode === 'full' && fs.existsSync(absolute))
        {
            const expectedDigest = baseline.get(file);
            if (expectedDigest && expectedDigest === Sha256(fs.readFileSync(absolute)))
            {
                baselineExempt += 1;
                continue;
            }
        }
        checked += 1;
        CheckFile(file, argumentsValue);
        if (path.posix.extname(file).toLowerCase() === '.md')
        {
            checkedMarkdown.push(file);
        }
    }
    CheckMarkdownTool(checkedMarkdown, argumentsValue);

    if (diagnostics.length > 0)
    {
        PrintDiagnostics();
        process.stderr.write(`[native-tooling-style] failed selected=${selected.length} checked=${checked} baseline=${baselineExempt} violations=${diagnostics.length}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write(`[native-tooling-style] ok operation=${argumentsValue.operation} domain=${argumentsValue.domain} mode=${argumentsValue.mode} selected=${selected.length} checked=${checked} baseline=${baselineExempt} violations=0\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(scriptPath)
    && process.argv[2] === '--markdownlint-spans')
{
    RunMarkdownSpanAdapter().catch((error) =>
    {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 2;
    });
}
else if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(scriptPath))
{
    try
    {
        Main();
    }
    catch (error)
    {
        process.stderr.write(`[native-tooling-style] fatal: ${error.stack ?? error.message}\n`);
        process.exitCode = 1;
    }
}
