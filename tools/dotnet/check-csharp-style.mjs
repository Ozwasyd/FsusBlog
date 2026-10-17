#!/usr/bin/env node

import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectCsharpFormat } from '../governance/csharp-format-equivalence.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..');
const defaultPolicyPath = 'config/development/csharp-style-policy.json';
const policySchema = 'fsusblog.csharp-style-policy.v1';
const baselineSchema = 'fsusblog.csharp-style-baseline.v1';
const validModes = new Set(['changed', 'full', 'strict-full']);
const importCompatibilityFile = 'config/development/csharp-import-compatibility.json';
const importCompatibilitySchema = 'fsusblog.csharp-import-compatibility.v1';
const importCompatibilityOwners = [
    'tests/backend/Unit/RedisOperationExecutorTests.cs',
    'tests/migration/OfflineMigrationFingerprintCommandTests.cs',
    'tests/migration/OfflineMigrationOwnedPlanningAuthorityReaderTests.cs',
    'tests/migration/PgLegacyCurrentSchemaPreparationTests.cs',
    'tests/migration/OfflineMigrationBackupAdmissionTests.cs',
    'tests/migration/PgLegacyNonArticlePreparationTests.cs',
    'tests/migration/PgLegacyNonArticleRecoveryTests.cs',
    'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs',
    'src/migration/OfflineMigrationCurrentSchemaArtifactReader.cs'
];

const sharedThirdPartyGroupOwners = new Set([
    'tests/migration/PgLegacyNonArticlePreparationTests.cs',
    'tests/migration/PgLegacyNonArticleRecoveryTests.cs'
]);

let root = defaultRoot;
let policy = null;
let policyFile = null;
let baseline = new Map();
let importCompatibility = new Set();
let motherStandardImports = false;
const failures = [];

function fail(message)
{
    failures.push(`[csharp-style] ${message}`);
}

function parseArgs(argv)
{
    const parsed = { files: [] };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--rebind-baseline-policy')
        {
            parsed.rebindBaselinePolicy = true;
            continue;
        }
        if (argument === '--update-baseline')
        {
            parsed.updateBaseline = true;
            continue;
        }
        if (argument === '--fix')
        {
            parsed.fix = true;
            continue;
        }
        if (!['--root', '--policy', '--mode', '--base', '--file', '--import-order'].includes(argument))
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
            parsed.files.push(value);
        }
        else
        {
            parsed[argument.slice(2)] = value;
        }
        index += 1;
    }
    return parsed;
}

function toPosix(value)
{
    return value.replaceAll(path.sep, '/');
}

function readJson(file, label)
{
    if (!fs.existsSync(file))
    {
        fail(`missing ${label}`);
        return null;
    }
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        fail(`invalid JSON ${label}: ${error.message}`);
        return null;
    }
}

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function globToRegExp(pattern)
{
    let source = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    source = source.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*');
    return new RegExp(`^${source}$`, 'u');
}

function command(args, { allowFailure = false } = {})
{
    const result = spawnSync(args[0], args.slice(1), {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DOTNET_NOLOGO: '1' },
        maxBuffer: 32 * 1024 * 1024
    });
    if (!allowFailure && result.status !== 0)
    {
        throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
}

function walkCSharpFiles(directory, base = directory, output = [])
{
    if (!fs.existsSync(directory))
    {
        return output;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            if (['.git', '.tmp', 'node_modules', 'bin', 'obj', 'dist', 'coverage'].includes(entry.name))
            {
                continue;
            }
            walkCSharpFiles(absolute, base, output);
        }
        else if (entry.isFile() && entry.name.endsWith('.cs'))
        {
            output.push(toPosix(path.relative(base, absolute)));
        }
    }
    return output;
}

function allCSharpFiles()
{
    const result = command(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '*.cs'], { allowFailure: true });
    const files = result.status === 0
        ? result.stdout.split(/\r?\n/u).filter(Boolean).map(toPosix)
        : walkCSharpFiles(root);
    return [...new Set(files)]
        .filter((file) => fs.existsSync(path.join(root, file)))
        .sort();
}

function normalizeFile(value)
{
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const relative = toPosix(path.relative(root, absolute));
    if (relative === '..' || relative.startsWith('../'))
    {
        throw new Error(`file is outside repository root: ${value}`);
    }
    return relative;
}

function changedCSharpFiles(base)
{
    const files = new Set();
    const diff = command(['git', 'diff', '--name-only', '--diff-filter=ACMR', base, '--', '*.cs'], { allowFailure: true });
    if (diff.status === 0)
    {
        for (const file of diff.stdout.split(/\r?\n/u))
        {
            if (file)
            {
                files.add(toPosix(file));
            }
        }
    }
    else
    {
        fail(`cannot resolve changed-file base ${base}: ${(diff.stderr || diff.stdout).trim()}`);
    }
    const untracked = command(['git', 'ls-files', '--others', '--exclude-standard', '--', '*.cs'], { allowFailure: true });
    if (untracked.status === 0)
    {
        for (const file of untracked.stdout.split(/\r?\n/u))
        {
            if (file)
            {
                files.add(toPosix(file));
            }
        }
    }
    return [...files].sort();
}

function selectFiles(args)
{
    if (args.files.length > 0)
    {
        return [...new Set(args.files.map(normalizeFile))].sort();
    }
    if (args.mode === 'full' || args.mode === 'strict-full' || args.updateBaseline)
    {
        return allCSharpFiles();
    }
    return changedCSharpFiles(args.base ?? policy.format.changedDefaultBase);
}

function isExcluded(file, exclusions)
{
    return exclusions.some((pattern) => pattern.test(file));
}

function makeViolation(file, line, rule, evidence, message)
{
    const normalizedEvidence = String(evidence).trim().replace(/\s+/gu, ' ');
    return {
        id: `${rule}:${file}:${line}:${sha256(normalizedEvidence).slice(0, 16)}`,
        file,
        line,
        rule,
        evidence: normalizedEvidence,
        message
    };
}

function quotedStringPrefixAt(line, index)
{
    if (line.startsWith('$@"', index) || line.startsWith('@$"', index))
    {
        return { length: 3, verbatim: true, interpolated: true };
    }
    if (line.startsWith('@"', index))
    {
        return { length: 2, verbatim: true, interpolated: false };
    }
    if (line.startsWith('$"', index))
    {
        return { length: 2, verbatim: false, interpolated: true };
    }
    if (line[index] === '"')
    {
        return { length: 1, verbatim: false, interpolated: false };
    }
    return null;
}

function findQuotedStringEnd(line, start, { verbatim, interpolated })
{
    let interpolationDepth = 0;
    for (let index = start; index < line.length;)
    {
        if (interpolationDepth === 0)
        {
            if (verbatim && line.startsWith('""', index))
            {
                index += 2;
                continue;
            }
            if (!verbatim && line[index] === '\\' && index + 1 < line.length)
            {
                index += 2;
                continue;
            }
            if (line[index] === '"')
            {
                return index;
            }
            if (interpolated && line.startsWith('{{', index))
            {
                index += 2;
                continue;
            }
            if (interpolated && line[index] === '{')
            {
                interpolationDepth = 1;
                index += 1;
                continue;
            }
            if (interpolated && line.startsWith('}}', index))
            {
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }

        const raw = line.slice(index).match(/^(?:\$+)?("{3,})/u);
        if (raw)
        {
            const close = line.indexOf(raw[1], index + raw[0].length);
            if (close < 0)
            {
                return -1;
            }
            index = close + raw[1].length;
            continue;
        }
        const nested = quotedStringPrefixAt(line, index);
        if (nested)
        {
            const close = findQuotedStringEnd(line, index + nested.length, nested);
            if (close < 0)
            {
                return -1;
            }
            index = close + 1;
            continue;
        }
        if (line[index] === "'")
        {
            index += 1;
            while (index < line.length)
            {
                if (line[index] === '\\' && index + 1 < line.length)
                {
                    index += 2;
                }
                else if (line[index] === "'")
                {
                    index += 1;
                    break;
                }
                else
                {
                    index += 1;
                }
            }
            continue;
        }
        if (line[index] === '{')
        {
            interpolationDepth += 1;
        }
        else if (line[index] === '}')
        {
            interpolationDepth -= 1;
        }
        index += 1;
    }
    return -1;
}

function stripStringsAndComments(lines)
{
    let inBlockComment = false;
    let inVerbatimString = false;
    let rawQuoteCount = 0;
    return lines.map((line) =>
    {
        let output = '';
        for (let index = 0; index < line.length;)
        {
            if (rawQuoteCount > 0)
            {
                const delimiter = '"'.repeat(rawQuoteCount);
                const close = line.indexOf(delimiter, index);
                if (close < 0)
                {
                    output += ' '.repeat(line.length - index);
                    index = line.length;
                }
                else
                {
                    output += ' '.repeat(close + rawQuoteCount - index);
                    index = close + rawQuoteCount;
                    rawQuoteCount = 0;
                }
                continue;
            }
            if (inVerbatimString)
            {
                if (line.startsWith('""', index))
                {
                    output += '  ';
                    index += 2;
                    continue;
                }
                output += ' ';
                if (line[index] === '"')
                {
                    inVerbatimString = false;
                }
                index += 1;
                continue;
            }
            if (inBlockComment)
            {
                const close = line.indexOf('*/', index);
                if (close < 0)
                {
                    output += ' '.repeat(line.length - index);
                    index = line.length;
                }
                else
                {
                    output += ' '.repeat(close + 2 - index);
                    index = close + 2;
                    inBlockComment = false;
                }
                continue;
            }
            if (line.startsWith('//', index))
            {
                output += ' '.repeat(line.length - index);
                break;
            }
            if (line.startsWith('/*', index))
            {
                output += '  ';
                index += 2;
                inBlockComment = true;
                continue;
            }
            const raw = line.slice(index).match(/^(?:\$+)?("{3,})/u);
            if (raw)
            {
                rawQuoteCount = raw[1].length;
                output += ' '.repeat(raw[0].length);
                index += raw[0].length;
                continue;
            }
            const prefixLength = line.startsWith('$@"', index) || line.startsWith('@$"', index)
                ? 3
                : (line.startsWith('@"', index) || line.startsWith('$"', index) ? 2 : (line[index] === '"' ? 1 : 0));
            if (prefixLength > 0)
            {
                const verbatim = line.slice(index, index + prefixLength).includes('@');
                const interpolated = line.slice(index, index + prefixLength).includes('$');
                output += ' '.repeat(prefixLength);
                index += prefixLength;
                if (interpolated)
                {
                    // Interpolation expressions may contain ordinary or nested
                    // interpolated string literals. The text checker does not inspect
                    // expression contents, so walk nested literals and consume through
                    // the matching outer quote instead of stopping at an inner quote.
                    const close = findQuotedStringEnd(line, index, { verbatim, interpolated });
                    if (close >= 0)
                    {
                        output += ' '.repeat(close + 1 - index);
                        index = close + 1;
                        continue;
                    }
                }
                let closed = false;
                while (index < line.length)
                {
                    if (verbatim && line.startsWith('""', index))
                    {
                        output += '  ';
                        index += 2;
                        continue;
                    }
                    if (line[index] === '"')
                    {
                        output += ' ';
                        index += 1;
                        closed = true;
                        break;
                    }
                    if (!verbatim && line[index] === '\\' && index + 1 < line.length)
                    {
                        output += '  ';
                        index += 2;
                        continue;
                    }
                    output += ' ';
                    index += 1;
                }
                if (verbatim && !closed)
                {
                    inVerbatimString = true;
                }
                continue;
            }
            if (line[index] === "'")
            {
                output += ' ';
                index += 1;
                while (index < line.length)
                {
                    if (line[index] === '\\' && index + 1 < line.length)
                    {
                        output += '  ';
                        index += 2;
                        continue;
                    }
                    output += ' ';
                    if (line[index] === "'")
                    {
                        index += 1;
                        break;
                    }
                    index += 1;
                }
                continue;
            }
            output += line[index];
            index += 1;
        }
        return output;
    });
}

function isPascalCase(value)
{
    return /^[A-Z][A-Za-z0-9]*$/u.test(value) && !value.includes('__');
}

function isCamelCase(value)
{
    return /^[a-z][A-Za-z0-9]*$/u.test(value) && !value.includes('__');
}

function isSegmentedPascalCase(value)
{
    return /^[A-Z][A-Za-z0-9]*(?:_(?:[A-Z][A-Za-z0-9]*|[0-9]+))+$/u.test(value) && !value.includes('__');
}

// Roslyn intentionally keeps automatic accessors compact even when
// csharp_new_line_before_open_brace=all and
// csharp_preserve_single_line_statements=false. Treat those declarations as a
// single property declaration, not as an inline block or multiple statements.
function isAutoPropertyAccessorLine(value)
{
    const accessor = String.raw`(?:(?:public|protected|private|internal)\s+)?(?:get|set|init)\s*;`;
    const accessors = String.raw`(?:${accessor}\s*)+`;
    return new RegExp(
        String.raw`^(?:[^{};]+\{\s*)?${accessors}(?:\}\s*(?:=\s*.+;)?\s*)?$`,
        'u'
    ).test(value);
}

function hasInlineBlockOpeningBrace(value, contextualRecordExpression = false)
{
    if (value === '{')
    {
        return false;
    }
    for (let braceIndex = value.indexOf('{'); braceIndex >= 0; braceIndex = value.indexOf('{', braceIndex + 1))
    {
        const prefix = value.slice(0, braceIndex).trimEnd();
        if (!prefix || /\bis\s+(?:not\s+)?$/u.test(`${prefix} `))
        {
            continue;
        }

        if (!contextualRecordExpression && /^(?:(?:public|protected|private|internal|file|new|static|abstract|sealed|partial|readonly|ref|unsafe)\s+)*(?:namespace|class|struct|record(?:\s+(?:class|struct))?|interface|enum)\b/u.test(prefix))
        {
            return true;
        }
        if (/^(?:if|else\s+if|for|foreach|while|switch|lock|using|fixed|catch)\b/u.test(prefix) && prefix.endsWith(')'))
        {
            return true;
        }
        if (/^(?:else|try|finally|do|unsafe|checked|unchecked)\b/u.test(prefix) || /^[}]\s*(?:else|catch|finally)\b/u.test(prefix))
        {
            return true;
        }
        if (/^(?:(?:public|protected|private|internal)\s+)?(?:get|set|init|add|remove)\b/u.test(prefix))
        {
            return true;
        }
        if (/=>\s*$/u.test(prefix) || parseMethodDeclaration(prefix))
        {
            return true;
        }

        if (/^(?:(?:public|protected|private|internal|static|virtual|abstract|sealed|override|readonly|required|unsafe|new|partial|extern)\s+)+[A-Za-z_][\w<>,.?[\]\s]*\s+(?:this\s*\[[^\]]+\]|[A-Za-z_]\w*)$/u.test(prefix))
        {
            return true;
        }
    }
    return false;
}

// Local type declarations are illegal C#. Track lexical scopes and argument
// continuations instead of exempting the contextual identifier "with" by name.
function stripLeadingScopeAttributes(value)
{
    let header = value.trim();
    while (header.startsWith('['))
    {
        let depth = 0;
        let end = -1;
        for (let index = 0; index < header.length; index += 1)
        {
            if (header[index] === '[')
            {
                depth += 1;
            }
            else if (header[index] === ']')
            {
                depth -= 1;
                if (depth === 0)
                {
                    end = index;
                    break;
                }
            }
        }
        if (end < 0)
        {
            return '';
        }
        header = header.slice(end + 1).trimStart();
    }
    return header;
}

function contextualRecordExpressionLines(codeLines)
{
    const scopes = [];
    const argumentHeaders = [];
    let header = '';
    let parentheses = 0;
    let brackets = 0;
    return codeLines.map((line) =>
    {
        if (line.trim().startsWith('#'))
        {
            return false;
        }
        const expression = /^record\s+with\b/u.test(line.trim())
            && (parentheses > 0 || scopes.includes('expression') || /(?:=|=>|\breturn)\s*$/u.test(header));
        for (const character of line)
        {
            if (character === '[')
            {
                brackets += 1;
            }
            else if (character === ']')
            {
                brackets = Math.max(0, brackets - 1);
            }
            if (character === '(')
            {
                parentheses += 1;
            }
            else if (character === ')')
            {
                parentheses = Math.max(0, parentheses - 1);
            }
            if (character === '{' && brackets === 0)
            {
                // Scope admission must recognize the declaration introducer
                // independently of the narrower naming-policy identifier regex.
                // Escaped and Unicode identifiers are still legal C# type names.
                const declaration = /^(?:(?:public|protected|private|internal|file|new|static|abstract|sealed|partial|readonly|ref|unsafe)\s+)*(?:namespace|class|struct|record(?:\s+(?:class|struct))?|interface|enum)\s+/u.test(stripLeadingScopeAttributes(header));
                const executable = scopes.includes('expression') || expression
                    || /(?:\)|=>|=|\bwith|\b(?:else|try|finally|do))\s*$/u.test(header)
                    || /\bnew\b/u.test(header);
                scopes.push(declaration && !expression ? 'declaration' : executable ? 'expression' : 'unknown');
                argumentHeaders.push(parentheses > 0 ? header : null);
                header = '';
            }
            else if (character === '}' && brackets === 0)
            {
                scopes.pop();
                const argumentHeader = argumentHeaders.pop();
                // Initializers or lambdas inside constructor/base arguments must
                // not erase the enclosing declaration before its body opens.
                header = argumentHeader === null || argumentHeader === undefined ? '' : `${argumentHeader} {}`;
            }
            else if (character === ';' && brackets === 0)
            {
                header = '';
            }
            else
            {
                header += character;
            }
        }
        header += '\n';
        return expression;
    });
}

function isStructuralIndentLine(value)
{
    return /^(?:public|protected|private|internal|file|namespace|class|struct|record|interface|enum|delegate|if|else|for|foreach|while|switch|case|default|try|catch|finally|do|lock|using|fixed|return|throw|break|continue)\b/u.test(value);
}

function parseUsingDirective(value, sharedThirdPartyGroup = false)
{
    const match = value.trim().match(/^using\s+(?:(static)\s+)?(?:([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/u);
    if (!match)
    {
        return null;
    }
    const [, staticImport, alias, namespace] = match;
    const rootNamespace = namespace.split('.')[0];
    const rank = alias ? 3 : (staticImport ? 2 : (rootNamespace === 'System' ? 0 : 1));
    const groupKey = alias ? 'alias' : (staticImport ? `static:${rootNamespace}`
        : (sharedThirdPartyGroup && rank === 1 && rootNamespace !== 'FsusBlog' ? 'third-party' : rootNamespace));
    return { namespace, sortKey: alias ?? namespace, rank, groupKey, rendered: value.trim() };
}

function loadImportCompatibility()
{
    const document = readJson(path.join(root, importCompatibilityFile), 'import compatibility declaration');
    const exactKeys = (value, keys) => value !== null && typeof value === 'object'
        && !Array.isArray(value) && Object.keys(value).sort().join('|') === keys.sort().join('|');
    if (!exactKeys(document, ['schema', 'entries']) || document.schema !== importCompatibilitySchema
        || !Array.isArray(document.entries) || document.entries.length !== importCompatibilityOwners.length
        || !document.entries.every((entry) => exactKeys(entry, ['path', 'order', 'reason'])
            && importCompatibilityOwners.includes(entry.path)
            && entry.order === 'system-third-party-fsusblog'
            && typeof entry.reason === 'string' && entry.reason.trim().length >= 20)
        || new Set(document.entries.map((entry) => entry.path)).size !== importCompatibilityOwners.length)
    {
        throw new Error('import compatibility requires the complete nine exact owners, supported order and a meaningful reason; unknown fields and widened declarations are forbidden');
    }
    return new Set(document.entries.map((entry) => entry.path));
}

function usesImportCompatibility(file)
{
    if (!importCompatibility.has(file))
    {
        return false;
    }
    requireCanonicalImportSource(file);
    return true;
}

function requireCanonicalImportSource(file)
{
    let directory = root;
    const parts = file.split('/');
    for (let index = 0; index < parts.length; index += 1)
    {
        const component = parts[index];
        if (!fs.readdirSync(directory).includes(component))
        {
            throw new Error('import compatibility requires a regular canonical source with exact path spelling');
        }
        const target = path.join(directory, component);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
        {
            throw new Error('import compatibility requires a regular canonical source without symlink aliases');
        }
        directory = target;
    }
}

function compareUsingDirectives(left, right, repositoryLast = false)
{
    // Repository-last ordering changes only ordinary imports; alias/static ranks stay intact.
    const rank = (directive) => repositoryLast && directive.rank === 1 && directive.groupKey === 'FsusBlog'
        ? 1.5 : directive.rank;
    return rank(left) - rank(right)
    || left.groupKey.localeCompare(right.groupKey)
    || (left.groupKey === 'third-party' && right.groupKey === 'third-party'
        ? (left.sortKey < right.sortKey ? -1 : (left.sortKey > right.sortKey ? 1 : 0))
        : left.sortKey.localeCompare(right.sortKey));
}

function normalizeUsingDirectives(file)
{
    if (motherStandardImports)
    {
        requireCanonicalImportSource(file);
        const absolute = path.join(root, file);
        const text = fs.readFileSync(absolute, 'utf8');
        const { imports } = inspectCsharpFormat(text);
        if (imports === null)
        {
            throw new Error(`mother-standard import fix requires an uncommented ordinary file-level using region: ${file}`);
        }
        const directives = imports.names.map(name => parseUsingDirective(`using ${name};`,
            sharedThirdPartyGroupOwners.has(file)));
        if (directives.some(directive => directive === null))
        {
            throw new Error(`mother-standard import fix cannot normalize this name syntax: ${file}`);
        }
        directives.sort((left, right) => compareUsingDirectives(left, right, true));
        const replacement = directives.map((directive, index) => (
            index > 0 && directive.groupKey !== directives[index - 1].groupKey ? '\n' : ''
        ) + directive.rendered).join('\n');
        const updated = text.slice(0, imports.start) + replacement + text.slice(imports.end);
        if (updated === text)
        {
            return false;
        }
        fs.writeFileSync(absolute, updated);
        return true;
    }
    const repositoryLast = usesImportCompatibility(file);
    const sharedThirdPartyGroup = repositoryLast && sharedThirdPartyGroupOwners.has(file);
    const absolute = path.join(root, file);
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split('\n');
    const indexes = [];
    for (let index = 0; index < lines.length; index += 1)
    {
        if (parseUsingDirective(lines[index]))
        {
            indexes.push(index);
        }
    }
    if (indexes.length < 2)
    {
        return false;
    }
    const first = indexes[0];
    const last = indexes.at(-1);
    if (lines.slice(first, last + 1).some((line) => line.trim() && !parseUsingDirective(line)))
    {
        return false;
    }

    const directives = indexes.map((index) => parseUsingDirective(lines[index], sharedThirdPartyGroup))
        .sort((left, right) => compareUsingDirectives(left, right, repositoryLast));
    const replacement = [];
    for (let index = 0; index < directives.length; index += 1)
    {
        if (index > 0 && directives[index].groupKey !== directives[index - 1].groupKey)
        {
            replacement.push('');
        }
        replacement.push(directives[index].rendered);
    }
    const current = lines.slice(first, last + 1);
    if (current.join('\n') === replacement.join('\n'))
    {
        return false;
    }
    lines.splice(first, last - first + 1, ...replacement);
    fs.writeFileSync(absolute, lines.join('\n'));
    return true;
}

function hasMeaningfulXmlDoc(lines, declarationIndex)
{
    const documentation = [];
    let sawAttribute = false;
    for (let index = declarationIndex - 1; index >= 0 && declarationIndex - index <= 16; index -= 1)
    {
        const trimmed = lines[index].trim();
        if (!trimmed)
        {
            continue;
        }
        if (trimmed.startsWith('///'))
        {
            documentation.unshift(trimmed.slice(3).trim());
            continue;
        }
        if (trimmed.startsWith('[') || trimmed.endsWith(']') || sawAttribute)
        {
            sawAttribute = true;
            if (trimmed.startsWith('['))
            {
                sawAttribute = false;
            }
            continue;
        }
        break;
    }
    const xml = documentation.join(' ');
    if (/<inheritdoc\b/iu.test(xml))
    {
        return true;
    }
    const summary = xml.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/iu)?.[1] ?? '';
    const text = summary.replace(/<[^>]+>/gu, ' ').replace(/&[A-Za-z0-9#]+;/gu, ' ').replace(/\s+/gu, ' ').trim();
    return text.length >= 3;
}

function isXmlDocScope(file, scopePatterns)
{
    return scopePatterns.some((pattern) => pattern.test(file));
}

function findMatchingParenthesis(value, openIndex)
{
    let depth = 0;
    for (let index = openIndex; index < value.length; index += 1)
    {
        if (value[index] === '(')
        {
            depth += 1;
        }
        else if (value[index] === ')')
        {
            depth -= 1;
            if (depth === 0)
            {
                return index;
            }
        }
    }
    return -1;
}

function splitTopLevelParameters(value)
{
    const parameters = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1)
    {
        if ('(<[{'.includes(value[index]))
        {
            depth += 1;
        }
        else if (')>]}'.includes(value[index]))
        {
            depth = Math.max(0, depth - 1);
        }
        else if (value[index] === ',' && depth === 0)
        {
            parameters.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    parameters.push(value.slice(start).trim());
    return parameters.filter(Boolean);
}

function parameterName(parameter)
{
    let declaration = parameter.trimStart();
    while (declaration.startsWith('['))
    {
        let depth = 0;
        let end = -1;
        for (let index = 0; index < declaration.length; index += 1)
        {
            if (declaration[index] === '[')
            {
                depth += 1;
            }
            else if (declaration[index] === ']')
            {
                depth -= 1;
                if (depth === 0)
                {
                    end = index;
                    break;
                }
            }
        }
        if (end < 0)
        {
            return null;
        }
        declaration = declaration.slice(end + 1).trimStart();
    }
    return declaration.replace(/\s*=.*$/u, '').match(/([A-Za-z_]\w*)\s*$/u)?.[1] ?? null;
}

function extractPrimaryConstructorDeclarations(code)
{
    const declarations = [];
    const consumed = Array.from(code, () => false);
    const modifiers = '(?:(?:public|protected|private|internal|file|new|static|abstract|sealed|partial|readonly|ref|unsafe)[ \\t]+)*';
    const pattern = new RegExp(`^[ \\t]*${modifiers}(?:class|struct|record(?:[ \\t]+(?:class|struct))?)[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\(`, 'gmu');
    let match;
    while ((match = pattern.exec(code)) !== null)
    {
        const openIndex = match.index + match[0].lastIndexOf('(');
        const closeIndex = findMatchingParenthesis(code, openIndex);
        if (closeIndex < 0)
        {
            declarations.push({ name: match[1], parameters: [null] });
            continue;
        }
        const lineEnd = code.indexOf('\n', closeIndex);
        const declarationEnd = lineEnd < 0 ? code.length : lineEnd;
        const suffix = code.slice(closeIndex + 1, declarationEnd);
        if (!/^[ \t]*(?::[^{};\n]*?)?[ \t]*;?[ \t]*$/u.test(suffix) || suffix.includes('=>'))
        {
            declarations.push({ name: match[1], parameters: [null] });
            pattern.lastIndex = closeIndex + 1;
            continue;
        }
        declarations.push({
            name: match[1],
            parameters: splitTopLevelParameters(code.slice(openIndex + 1, closeIndex)).map(parameterName)
        });
        for (let index = match.index; index < declarationEnd; index += 1)
        {
            consumed[index] = true;
        }
        pattern.lastIndex = declarationEnd;
    }
    const remainder = [...code].map((character, index) => consumed[index] ? ' ' : character).join('').trim();
    return { declarations, remainder };
}

function extractFieldNames(code)
{
    const fields = [];
    const remainder = [];
    for (const rawLine of code.split('\n'))
    {
        const line = rawLine.trim();
        if (!line)
        {
            continue;
        }
        if (/^\[[^\]\n]+\]$/u.test(line))
        {
            continue;
        }
        const match = line.match(/^(?:public|protected|private|internal)\s+(?:(?:static|readonly|volatile|const|unsafe|required|new)\s+)*(?<type>.+)[ \t]+(?<name>[A-Za-z_]\w*)\s*;$/u);
        if (!match?.groups || hasTopLevelComma(match.groups.type))
        {
            remainder.push(line);
            continue;
        }
        fields.push(match.groups.name);
    }
    return { fields, remainder: remainder.join('\n') };
}

function hasTopLevelComma(value)
{
    let depth = 0;
    for (const character of value)
    {
        if ('(<[{'.includes(character))
        {
            depth += 1;
        }
        else if (')>]}'.includes(character))
        {
            depth = Math.max(0, depth - 1);
        }
        else if (character === ',' && depth === 0)
        {
            return true;
        }
    }
    return false;
}

function sameContract(actual, expected)
{
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function checkRoslynCompatibilityExceptions(file, lines)
{
    const violations = [];
    const entries = policy.naming.roslynCompatibilityExceptions.filter((entry) => entry.path === file);
    const blocks = [];
    let open = null;

    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index];
        const directive = line.match(/^\s*#pragma\s+warning\s+(disable|restore)(?:\s+(.+?))?\s*$/u);
        if (!directive)
        {
            if (open)
            {
                open.contentLines.push(line);
            }
            continue;
        }
        const diagnostics = (directive[2] ?? '')
            .replace(/\/\/.*$/u, '')
            .split(',')
            .map((diagnostic) => diagnostic.trim())
            .filter(Boolean);
        const affectsEveryDiagnostic = diagnostics.length === 0;
        if (!affectsEveryDiagnostic && !diagnostics.includes('IDE1006'))
        {
            if (open)
            {
                open.contentLines.push(line);
            }
            continue;
        }
        if (affectsEveryDiagnostic || !sameContract(diagnostics, ['IDE1006']))
        {
            violations.push(makeViolation(file, index + 1, 'roslyn-exception-scope', line, 'IDE1006 must be isolated in its own pragma directive'));
        }
        if (directive[1] === 'disable')
        {
            if (open)
            {
                violations.push(makeViolation(file, index + 1, 'roslyn-exception-scope', line, 'IDE1006 exception blocks may not be nested'));
            }
            else
            {
                open = { line: index + 1, contentLines: [] };
            }
            continue;
        }
        if (!open)
        {
            violations.push(makeViolation(file, index + 1, 'roslyn-exception-scope', line, 'IDE1006 restore has no matching disable'));
        }
        else
        {
            blocks.push(open);
            open = null;
        }
    }

    if (open)
    {
        violations.push(makeViolation(file, open.line, 'roslyn-exception-scope', '#pragma warning disable IDE1006', 'IDE1006 exception block must restore the diagnostic'));
    }

    if (entries.length === 0 && blocks.length === 0)
    {
        return violations;
    }

    if (entries.length !== 1 || blocks.length !== 1)
    {
        const rule = entries.length === 0 ? 'roslyn-exception-registration' : 'roslyn-exception-contract';
        violations.push(makeViolation(file, blocks[0]?.line ?? 1, rule, file, 'IDE1006 requires exactly one registered path and one local exception block'));
        return violations;
    }

    const entry = entries[0];
    const block = blocks[0];
    const code = stripStringsAndComments(block.contentLines).join('\n');
    const primaryConstructors = extractPrimaryConstructorDeclarations(code);
    const fieldDeclarations = extractFieldNames(code);
    const declarationsMatch = entry.declarations
        ? sameContract(primaryConstructors.declarations, entry.declarations)
      && primaryConstructors.remainder.length === 0
        : primaryConstructors.declarations.length === 0;
    const fieldsMatch = entry.fields
        ? sameContract(fieldDeclarations.fields, entry.fields)
      && fieldDeclarations.remainder.length === 0
        : fieldDeclarations.fields.length === 0;
    if (!declarationsMatch || !fieldsMatch)
    {
        violations.push(makeViolation(
            file,
            block.line,
            'roslyn-exception-contract',
            code,
            'IDE1006 exception block must exactly match its registered declarations or fields'
        ));
    }

    return violations;
}

function parseMethodDeclaration(trimmed, codeLines = [], lineIndex = codeLines.length)
{
    if (!/^(?:public|protected|private|internal)\s+/u.test(trimmed))
    {
        return null;
    }
    if (/\b(?:class|struct|record|interface|enum|delegate)\b/u.test(trimmed))
    {
        return null;
    }
    if (/\boperator\b/u.test(trimmed))
    {
        return null;
    }
    const nonMethodNames = new Set([
        'public', 'protected', 'private', 'internal', 'file', 'new', 'static', 'abstract',
        'virtual', 'sealed', 'override', 'readonly', 'unsafe', 'required', 'volatile',
        'async', 'partial', 'extern', 'operator'
    ]);
    for (let openIndex = trimmed.indexOf('('); openIndex >= 0; openIndex = trimmed.indexOf('(', openIndex + 1))
    {
        const prefix = trimmed.slice(0, openIndex);
        if (prefix.includes('='))
        {
            return null;
        }
        const namePrefix = prefix.replace(/<[^<>]*>\s*$/u, '').trimEnd();
        const name = namePrefix.match(/([A-Za-z_]\w*)$/u)?.[1];
        if (!name || nonMethodNames.has(name))
        {
            continue;
        }
        let declaration = trimmed;
        let closeIndex = findMatchingParenthesis(declaration, openIndex);
        for (let index = lineIndex + 1; closeIndex < 0 && index < codeLines.length; index += 1)
        {
            declaration += `\n${codeLines[index]}`;
            closeIndex = findMatchingParenthesis(declaration, openIndex);
        }
        if (closeIndex < 0)
        {
            return null;
        }
        return {
            name,
            parameters: splitTopLevelParameters(declaration.slice(openIndex + 1, closeIndex))
        };
    }
    return null;
}

function checkFile(file, xmlScopePatterns, xmlMemberScopePatterns, segmentedMethodScopePatterns)
{
    const absolute = path.join(root, file);
    const violations = [];
    if (!fs.existsSync(absolute))
    {
        violations.push(makeViolation(file, 0, 'file-exists', file, 'selected C# file does not exist'));
        return violations;
    }
    const repositoryLast = usesImportCompatibility(file) || motherStandardImports;
    const sharedThirdPartyGroup = repositoryLast && sharedThirdPartyGroupOwners.has(file);
    const buffer = fs.readFileSync(absolute);
    if (!isUtf8(buffer))
    {
        violations.push(makeViolation(file, 1, 'utf8', file, 'file is not valid UTF-8'));
    }
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
    {
        violations.push(makeViolation(file, 1, 'utf8-bom', file, 'UTF-8 BOM is forbidden'));
    }
    const text = buffer.toString('utf8');
    if (text.includes('\r'))
    {
        violations.push(makeViolation(file, 1, 'line-ending', 'CR', 'line endings must be LF'));
    }
    if (!text.endsWith('\n'))
    {
        violations.push(makeViolation(file, Math.max(1, text.split(/\n/u).length), 'final-newline', file, 'file must end with newline'));
    }
    const lines = text.split(/\r?\n/u);
    const codeLines = stripStringsAndComments(lines);
    const recordExpressionLines = contextualRecordExpressionLines(codeLines);
    let namespaceSeen = false;
    const usings = [];
    const xmlScope = isXmlDocScope(file, xmlScopePatterns);
    const xmlMemberScope = isXmlDocScope(file, xmlMemberScopePatterns);
    const segmentedMethodNames = isXmlDocScope(file, segmentedMethodScopePatterns);

    for (let index = 0; index < lines.length; index += 1)
    {
        const lineNumber = index + 1;
        const raw = lines[index];
        const code = codeLines[index];
        const trimmed = code.trim();
        if (/\t/u.test(raw))
        {
            violations.push(makeViolation(file, lineNumber, 'tab', raw, 'Tab indentation is forbidden'));
        }
        if (/[ \t]+$/u.test(raw))
        {
            violations.push(makeViolation(file, lineNumber, 'trailing-whitespace', raw, 'trailing whitespace is forbidden'));
        }
        const indent = raw.match(/^ */u)?.[0].length ?? 0;
        if (trimmed && !trimmed.startsWith('#') && indent % 4 !== 0 && isStructuralIndentLine(trimmed))
        {
            violations.push(makeViolation(file, lineNumber, 'indent', raw, `indentation ${indent} is not a 4-space multiple`));
        }
        const autoPropertyAccessorLine = isAutoPropertyAccessorLine(trimmed);
        if (hasInlineBlockOpeningBrace(trimmed, recordExpressionLines[index]) && !autoPropertyAccessorLine)
        {
            violations.push(makeViolation(file, lineNumber, 'allman-brace', code, 'opening brace must be on its own line'));
        }
        const semicolons = [...trimmed.matchAll(/;/gu)].length;
        if (semicolons > 1 && !/^for\s*\(/u.test(trimmed) && !autoPropertyAccessorLine)
        {
            violations.push(makeViolation(file, lineNumber, 'one-statement', code, 'only one statement is allowed per line'));
        }
        if (trimmed.endsWith(';') && !trimmed.endsWith(');') && !trimmed.includes('(') && /^(?:const\s+)?[A-Za-z_][\w<>,.?[\]]*\s+[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*/u.test(trimmed))
        {
            violations.push(makeViolation(file, lineNumber, 'one-declaration', code, 'only one declaration is allowed per line'));
        }

        if (/^namespace\b/u.test(trimmed))
        {
            namespaceSeen = true;
        }
        const usingDirective = parseUsingDirective(trimmed, sharedThirdPartyGroup);
        if (usingDirective)
        {
            if (namespaceSeen)
            {
                violations.push(makeViolation(file, lineNumber, 'using-placement', code, 'using directives must be outside namespace'));
            }
            usings.push({ line: lineNumber, ...usingDirective });
        }

        for (const identifier of trimmed.matchAll(/\b[A-Za-z_]\w*__\w*\b/gu))
        {
            violations.push(makeViolation(file, lineNumber, 'double-underscore', identifier[0], 'consecutive underscores are forbidden in internal identifiers'));
        }

        const interfaceMatch = trimmed.match(/\binterface\s+([A-Za-z_]\w*)/u);
        if (interfaceMatch && !/^I[A-Z][A-Za-z0-9]*$/u.test(interfaceMatch[1]))
        {
            violations.push(makeViolation(file, lineNumber, 'interface-name', interfaceMatch[1], 'interface must use I + PascalCase'));
        }
        const typeMatch = trimmed.match(/^(?:(?:public|protected|private|internal|file|new|static|abstract|sealed|partial|readonly|ref|unsafe)\s+)*(?:class|struct|record(?:\s+(?:class|struct))?|enum|delegate)\s+([A-Za-z_]\w*)/u);
        if (typeMatch && !recordExpressionLines[index] && !isPascalCase(typeMatch[1]))
        {
            violations.push(makeViolation(file, lineNumber, 'type-name', typeMatch[1], 'type must use PascalCase'));
        }

        const fieldMatch = trimmed.match(/^(?<access>public|protected|private|internal)\s+(?<modifiers>(?:(?:static|readonly|volatile|const|unsafe|required|new)\s+)*)(?<type>[A-Za-z_][\w<>,.?[\]]*)\s+(?<name>[A-Za-z_]\w*)\s*(?<terminator>=>|=|;|\{)/u);
        if (fieldMatch?.groups)
        {
            const { access, modifiers, name, terminator } = fieldMatch.groups;
            const threadStatic = lines.slice(Math.max(0, index - 4), index).some((candidate) => candidate.includes('[ThreadStatic]'));
            const property = terminator === '=>' || terminator === '{';
            if (property)
            {
                if (!isPascalCase(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'property-name', name, 'property must use PascalCase'));
                }
            }
            else if (modifiers.includes('const'))
            {
                if (!isPascalCase(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'constant-name', name, 'constant must use PascalCase'));
                }
            }
            else if (threadStatic)
            {
                if (!/^t_[a-z][A-Za-z0-9]*$/u.test(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'thread-static-field-name', name, 'thread-static field must use t_camelCase'));
                }
            }
            else if ((access === 'private' || access === 'internal') && modifiers.includes('static'))
            {
                if (!/^s_[a-z][A-Za-z0-9]*$/u.test(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'private-static-field-name', name, 'private/internal static field must use s_camelCase'));
                }
            }
            else if (access === 'private' || access === 'internal')
            {
                if (!/^_[a-z][A-Za-z0-9]*$/u.test(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'private-field-name', name, 'private/internal instance field must use _camelCase'));
                }
            }
            else if (!isPascalCase(name))
            {
                violations.push(makeViolation(file, lineNumber, 'public-member-name', name, 'public/protected member must use PascalCase'));
            }
        }

        const method = parseMethodDeclaration(trimmed, codeLines, index);
        if (method)
        {
            const methodName = method.name;
            if (!isPascalCase(methodName) && !(segmentedMethodNames && isSegmentedPascalCase(methodName)))
            {
                violations.push(makeViolation(file, lineNumber, 'method-name', methodName, 'method/local function must use PascalCase; scenario separators are allowed only in declared test/benchmark scopes'));
            }
            for (const parameter of method.parameters)
            {
                const name = parameterName(parameter);
                if (name && !isCamelCase(name))
                {
                    violations.push(makeViolation(file, lineNumber, 'parameter-name', name, 'parameter must use camelCase'));
                }
            }
        }

        const closesPrimaryConstructor = /\)\s*(?::[^;]+)?;\s*$/u.test(trimmed);
        const localMatch = !trimmed.startsWith('using ') && trimmed.endsWith(';') && !closesPrimaryConstructor
            ? trimmed.match(/^(?:var|[A-Za-z_][\w<>,.?[\]]*)\s+([A-Za-z_]\w*)\s*=/u)
            : null;
        if (localMatch && !isCamelCase(localMatch[1]))
        {
            violations.push(makeViolation(file, lineNumber, 'local-name', localMatch[1], 'local must use camelCase'));
        }

        const enumMatch = trimmed.match(/\benum\s+([A-Za-z_]\w*)/u);
        if (enumMatch)
        {
            const flags = lines.slice(Math.max(0, index - 4), index).some((candidate) => candidate.includes('[Flags]'));
            const plural = enumMatch[1].endsWith('s') && !policy.enumNaming.acceptedSingularSuffixes.some((suffix) => enumMatch[1].endsWith(suffix));
            const compatibilityException = policy.enumNaming.compatibilityExceptions.some((entry) => entry.path === file && entry.name === enumMatch[1]);
            if (!compatibilityException && flags && !plural)
            {
                violations.push(makeViolation(file, lineNumber, 'flags-enum-name', enumMatch[1], 'flags enum must use a plural name'));
            }
            if (!compatibilityException && !flags && plural)
            {
                violations.push(makeViolation(file, lineNumber, 'enum-name', enumMatch[1], 'non-flags enum must use a singular name'));
            }
        }

        // Contract scopes use file-scoped namespaces. Restrict the text fallback to
        // top-level types and their direct members so a public field inside a
        // private nested scratch type is not mistaken for a public API surface.
        if (xmlScope && indent <= 4 && /^public\s+/u.test(trimmed) && !/\boverride\b/u.test(trimmed))
        {
            const typeDeclaration = /\b(?:class|struct|record|interface|enum|delegate)\b/u.test(trimmed);
            const memberDeclaration = /\b[A-Za-z_]\w*\s*\(/u.test(trimmed)
        || /\b[A-Za-z_]\w*\s*(?:=>|\{|;)/u.test(trimmed);
            if ((typeDeclaration || (xmlMemberScope && memberDeclaration)) && !hasMeaningfulXmlDoc(lines, index))
            {
                violations.push(makeViolation(file, lineNumber, 'xml-documentation', trimmed, 'public contract declaration requires meaningful XML documentation'));
            }
        }
    }

    for (let index = 1; index < usings.length; index += 1)
    {
        const previous = usings[index - 1];
        const current = usings[index];
        if (compareUsingDirectives(current, previous, repositoryLast) < 0)
        {
            violations.push(makeViolation(file, current.line, 'using-order', current.namespace, 'using directives must place System first and sort namespaces within a group'));
        }
        const separated = lines[current.line - 2]?.trim() === '';
        if (current.groupKey !== previous.groupKey && !separated)
        {
            violations.push(makeViolation(file, current.line, 'using-group', current.namespace, 'using groups must be separated by one blank line'));
        }
        if (current.groupKey === previous.groupKey && separated)
        {
            violations.push(makeViolation(file, current.line, 'using-group', current.namespace, 'using directives from the same root namespace must stay in one group'));
        }
    }
    violations.push(...checkRoslynCompatibilityExceptions(file, lines));
    return violations;
}

function loadBaseline()
{
    const baselinePath = path.join(root, policy.baseline);
    if (!fs.existsSync(baselinePath))
    {
        return new Map();
    }
    const document = readJson(baselinePath, policy.baseline);
    if (!document)
    {
        return new Map();
    }
    if (document.schema !== baselineSchema)
    {
        fail(`baseline schema must be ${baselineSchema}`);
    }
    const policyDigest = sha256(fs.readFileSync(policyFile));
    if (document.policySha256 !== policyDigest)
    {
        fail('C# style baseline policy digest is stale');
    }
    if (!Array.isArray(document.files))
    {
        fail('C# style baseline files must be an array');
        return new Map();
    }
    return new Map(document.files.map((entry) => [entry.path, entry]));
}

function runDotnetFormat(files, mode)
{
    if (files.length === 0 || mode === 'full')
    {
        return;
    }
    const relativeFiles = files.map((file) => path.join(root, file));
    const whitespace = command([
        'dotnet', 'format', 'whitespace', root, '--folder', '--verify-no-changes', '--include', ...relativeFiles, '--verbosity', 'quiet'
    ], { allowFailure: true });
    if (whitespace.status !== 0)
    {
        fail(`dotnet format whitespace rejected selected files: ${(whitespace.stderr || whitespace.stdout).trim()}`);
    }
    const workspace = path.join(root, policy.workspace);
    if (fs.existsSync(workspace))
    {
        const style = command([
            'dotnet', 'format', 'style', workspace, '--verify-no-changes', '--no-restore', '--severity', 'info', '--exclude-diagnostics', 'IDE1006', '--include', ...relativeFiles, '--verbosity', 'quiet'
        ], { allowFailure: true });
        if (style.status !== 0)
        {
            fail(`dotnet format style rejected selected files: ${(style.stderr || style.stdout).trim()}`);
        }
    }
}

function writeBaseline(violations)
{
    const target = path.join(root, policy.baseline);
    const commit = command(['git', 'rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim() || 'uncommitted';
    const byFile = new Map();
    for (const violation of violations)
    {
        const entry = byFile.get(violation.file) ?? { rules: {}, ids: [] };
        entry.rules[violation.rule] = (entry.rules[violation.rule] ?? 0) + 1;
        entry.ids.push(violation.id);
        byFile.set(violation.file, entry);
    }
    const files = [...byFile.entries()].map(([file, entry]) => ({
        path: file,
        sourceSha256: sha256(fs.readFileSync(path.join(root, file))),
        violationCount: entry.ids.length,
        violationDigest: sha256(entry.ids.sort().join('\n')),
        rules: Object.fromEntries(Object.entries(entry.rules).sort(([left], [right]) => left.localeCompare(right)))
    })).sort((left, right) => left.path.localeCompare(right.path));
    const document = {
        schema: baselineSchema,
        generatedFrom: commit,
        policySha256: sha256(fs.readFileSync(policyFile)),
        violationCount: violations.length,
        fileCount: files.length,
        files
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(document, null, 4)}\n`);
    console.log(`[csharp-style] baseline updated violations=${violations.length} path=${policy.baseline}`);
}

// This one-time producer admits only the original reviewed baseline and the
// issue-3650 Miss suffix extension. It never rescans or increases allowed debt.
function rebindBaselinePolicy(args)
{
    if (args.fix || args.updateBaseline || args.mode !== 'full' || args.files.length > 0 || args.base)
    {
        throw new Error('policy rebind cannot be mixed with fix, update-baseline or file selection; use full mode');
    }
    if (policyFile !== path.join(root, defaultPolicyPath))
    {
        throw new Error('policy rebind requires the canonical policy path');
    }
    function requireRegularInput(relativePath)
    {
        let current = root;
        const parts = relativePath.split('/');
        for (let index = 0; index < parts.length; index += 1)
        {
            current = path.join(current, parts[index]);
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
            {
                throw new Error('policy rebind requires regular canonical inputs');
            }
        }
    }
    requireRegularInput(defaultPolicyPath);
    requireRegularInput('config/development/csharp-style-baseline.json');
    const authority = 'b19b3dc715691b871f0e3cab598ec5da8f27633c';
    function authorityBlob(relativePath, objectId, digest)
    {
        const result = spawnSync('git', ['-C', defaultRoot, 'ls-tree', authority, '--', relativePath], {
            encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        if (result.status !== 0 || result.stdout.trim() !== `100644 blob ${objectId}\t${relativePath}`)
        {
            throw new Error('policy rebind original authority Git object mismatch');
        }
        const blob = spawnSync('git', ['-C', defaultRoot, 'cat-file', 'blob', objectId], {
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        if (blob.status !== 0 || sha256(blob.stdout) !== digest)
        {
            throw new Error('policy rebind original authority digest mismatch');
        }
        return blob.stdout.toString('utf8');
    }
    const originalPolicy = authorityBlob(defaultPolicyPath,
        '5cc03bb337ddcba71cb049e8f9ca47637d7ecb26',
        '29f9d010d5221b393164526fc6203dc555f453b83e26b77552617a13beb23200');
    const originalBaseline = authorityBlob('config/development/csharp-style-baseline.json',
        '44931fca7b3950cbaa54ba0a8f13097174c8cd42',
        '0ab4b1ebfecbba054015209fcb30f62dbd6395a1390da67a87b9e9fd057fd011');
    const expectedPolicy = JSON.parse(originalPolicy);
    expectedPolicy.enumNaming.acceptedSingularSuffixes.push('Miss');
    const policyBytes = fs.readFileSync(policyFile, 'utf8');
    if (policyBytes !== `${JSON.stringify(expectedPolicy, null, 4)}\n`)
    {
        throw new Error('policy rebind permits only the canonical Miss suffix extension');
    }
    const target = path.join(root, expectedPolicy.baseline);
    const rebound = originalBaseline.replace(JSON.parse(originalBaseline).policySha256, sha256(policyBytes));
    const current = fs.readFileSync(target, 'utf8');
    if (current !== originalBaseline && current !== rebound)
    {
        throw new Error('policy rebind requires the intact original baseline');
    }
    fs.writeFileSync(target, rebound);
    console.log(`[csharp-style] baseline policy rebound authority=${authority} path=${expectedPolicy.baseline}`);
    return { files: 0, violations: 0, unexpected: 0 };
}

function validatePolicy()
{
    if (policy.schema !== policySchema)
    {
        fail(`policy schema must be ${policySchema}`);
    }
    for (const field of ['editorConfig', 'workspace', 'baseline'])
    {
        if (typeof policy[field] !== 'string' || !policy[field])
        {
            fail(`policy is missing ${field}`);
        }
    }
    if (!fs.existsSync(path.join(root, policy.editorConfig)))
    {
        fail(`missing ${policy.editorConfig}`);
    }
    if (policy.minimumDotnetMajor !== 10)
    {
        fail('minimumDotnetMajor must be 10');
    }
    if (!Array.isArray(policy.excludedPaths) || policy.excludedPaths.length === 0)
    {
        fail('excludedPaths must be non-empty');
    }
    if (!Array.isArray(policy.xmlDocumentation?.scopes) || policy.xmlDocumentation.scopes.length === 0)
    {
        fail('xmlDocumentation.scopes must be non-empty');
    }
    if (!Array.isArray(policy.xmlDocumentation?.memberScopes) || policy.xmlDocumentation.memberScopes.length === 0)
    {
        fail('xmlDocumentation.memberScopes must be non-empty');
    }
    if (!Array.isArray(policy.naming?.pascalCaseSeparatorScopes) || policy.naming.pascalCaseSeparatorScopes.length === 0)
    {
        fail('naming.pascalCaseSeparatorScopes must be non-empty');
    }
    if (!Array.isArray(policy.naming?.roslynCompatibilityExceptions))
    {
        fail('naming.roslynCompatibilityExceptions must be an array');
    }
    const roslynExceptionPaths = new Set();
    for (const entry of policy.naming?.roslynCompatibilityExceptions ?? [])
    {
        const hasDeclarations = Array.isArray(entry?.declarations) && entry.declarations.length > 0;
        const hasFields = Array.isArray(entry?.fields) && entry.fields.length > 0;
        const validDeclarations = hasDeclarations
      && new Set(entry.declarations.map((declaration) => declaration?.name)).size === entry.declarations.length
      && entry.declarations.every((declaration) =>
      {
          const parameters = declaration?.parameters;
          return typeof declaration?.name === 'string'
          && /^[A-Za-z_]\w*$/u.test(declaration.name)
          && Array.isArray(parameters)
          && new Set(parameters).size === parameters.length
          && parameters.every((parameter) => typeof parameter === 'string' && /^[A-Za-z_]\w*$/u.test(parameter));
      });
        const validFields = hasFields
      && new Set(entry.fields).size === entry.fields.length
      && entry.fields.every((field) => typeof field === 'string' && /^[A-Za-z_]\w*$/u.test(field));
        const validContract = hasDeclarations !== hasFields && (hasDeclarations ? validDeclarations : validFields);
        if (!entry || typeof entry.path !== 'string' || !entry.path.endsWith('.cs') || !validContract || typeof entry.reason !== 'string' || entry.reason.length < 20)
        {
            fail('naming.roslynCompatibilityExceptions entries require a C# path, exactly one valid declaration/field contract and a meaningful reason');
            continue;
        }
        if (roslynExceptionPaths.has(entry.path))
        {
            fail(`naming.roslynCompatibilityExceptions contains duplicate path ${entry.path}`);
        }
        roslynExceptionPaths.add(entry.path);
    }
    if (!Array.isArray(policy.enumNaming?.compatibilityExceptions))
    {
        fail('enumNaming.compatibilityExceptions must be an array');
    }
    for (const entry of policy.enumNaming?.compatibilityExceptions ?? [])
    {
        if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string' || typeof entry.reason !== 'string' || entry.reason.length < 20)
        {
            fail('enumNaming.compatibilityExceptions entries require path, name and a meaningful reason');
        }
    }
    for (const required of ['_', 's_', 't_'])
    {
        const values = Object.values(policy.naming ?? {});
        if (!values.includes(required))
        {
            fail(`naming policy is missing required prefix ${required}`);
        }
    }
}

function main()
{
    const args = parseArgs(process.argv.slice(2));
    root = path.resolve(args.root ?? defaultRoot);
    args.mode ??= 'changed';
    if (args['import-order'] !== undefined && args['import-order'] !== 'mother-standard')
    {
        throw new Error('import-order must be mother-standard; omit it for the historical migration comparator');
    }
    motherStandardImports = args['import-order'] === 'mother-standard';
    if (motherStandardImports && (args.updateBaseline || args.rebindBaselinePolicy))
    {
        throw new Error('mother-standard import checking cannot rewrite historical baseline or policy bindings');
    }
    if (!validModes.has(args.mode))
    {
        throw new Error(`invalid mode ${args.mode}`);
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    {
        throw new Error(`repository root does not exist: ${root}`);
    }
    policyFile = path.resolve(args.policy ?? path.join(root, defaultPolicyPath));
    policy = readJson(policyFile, args.policy ?? defaultPolicyPath);
    if (!policy)
    {
        return null;
    }
    validatePolicy();
    if (args.rebindBaselinePolicy)
    {
        if (failures.length > 0)
        {
            return null;
        }
        return rebindBaselinePolicy(args);
    }
    importCompatibility = loadImportCompatibility();

    const exclusions = (policy.excludedPaths ?? []).map(globToRegExp);
    const xmlScopes = (policy.xmlDocumentation?.scopes ?? []).map(globToRegExp);
    const xmlMemberScopes = (policy.xmlDocumentation?.memberScopes ?? []).map(globToRegExp);
    const segmentedMethodScopes = (policy.naming?.pascalCaseSeparatorScopes ?? []).map(globToRegExp);
    const files = selectFiles(args).filter((file) => file.endsWith('.cs') && !isExcluded(file, exclusions));
    if (args.fix)
    {
        const fixed = files.filter((file) => normalizeUsingDirectives(file)).length;
        console.log(`[csharp-style] fixed using directives files=${fixed}`);
    }
    const violations = files.flatMap((file) => checkFile(file, xmlScopes, xmlMemberScopes, segmentedMethodScopes))
        .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule));

    if (args.updateBaseline)
    {
        writeBaseline(violations);
        return { files: files.length, violations: violations.length, unexpected: 0 };
    }

    baseline = loadBaseline();
    runDotnetFormat(files, args.mode);
    const sourceDigests = new Map(files.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]));
    const unexpected = args.mode === 'strict-full'
        ? violations
        : violations.filter((violation) =>
{
        const entry = baseline.get(violation.file);
        return (motherStandardImports && violation.rule.startsWith('using-'))
            || !entry || entry.sourceSha256 !== sourceDigests.get(violation.file);
      });
    for (const violation of unexpected)
    {
        fail(`${violation.file}:${violation.line} ${violation.rule}: ${violation.message} [${violation.evidence}]`);
    }
    return { files: files.length, violations: violations.length, unexpected: unexpected.length };
}

let summary = null;
try
{
    summary = main();
}
catch (error)
{
    fail(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0)
{
    for (const failure of failures)
    {
        console.error(failure);
    }
    process.exitCode = 1;
}
else if (summary)
{
    console.log(`[csharp-style] ok files=${summary.files} violations=${summary.violations} new=${summary.unexpected}`);
}
