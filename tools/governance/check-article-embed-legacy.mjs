#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { resolveLocalFsusUiRepositoryRoot } = await import(new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const rules = [
    ['include-syntax', /::include\b|(?:remote|file|html)[-_]include\b/giu, false],
    ['wikilink-probe', /\bconsumerRegexScan\b|\bwikilink\b/gu, true],
    ['latest-or-external-resolution', /\b(?:Get|Read|Load|Resolve|Fetch)(?:Latest|Remote|File|Html)(?:Embed(?:Target)?|Include|Target|Revision)\b/giu, true],
    ['private-copy', /\b(?:copyPrivate(?:Target|Embed|Content)|privateCopy|allowPrivateCopy|renderPrivateCopy)\b/giu, true],
    ['automatic-coordinate-refresh', /\b(?:autoRefresh(?:Embed|Dependency|Target)|refreshEmbedDependenciesAutomatically)\b/giu, true],
    ['global-invalidation', /\b(?:flushAll(?:Caches?|Articles?)|globalFlush|invalidateAll(?:Embeds?|Articles?|Caches?))\b/giu, true],
    ['rendered-source-scan', /\b(?:scanRendered(?:Embed|Target)|collectEmbedFromDOM)\b|\b(?:querySelectorAll|innerHTML|outerHTML|DOMParser)[^\r\n]{0,100}(?:data-embed|embed-target)/giu, true],
    ['second-authority', /\b(?:Other|Second|Fallback|Legacy)(?:ArticleEmbed(?:Authoring)?(?:Resolver|Provider|Parser|Store)|Embed(?:Resolver|Provider|Parser|Cache))\b/gu, true],
    ['html-provider-payload', /\b(?:html|iframe|component|dom)\s*:/giu, true]
];

// This masks programming-language comments for an inventory. It never parses Markdown,
// resolves targets, grants permissions, changes source, or substitutes for runtime denial.
function maskComments(source)
{
    const chars = source.split('');
    let quote = null;
    let comment = null;
    for (let index = 0; index < chars.length; index++)
    {
        const current = chars[index];
        const next = chars[index + 1];
        if (comment)
        {
            if (comment === 'line' && (current === '\n' || current === '\r'))
            {
                comment = null;
            }
            else if (comment === 'block' && current === '*' && next === '/')
            {
                chars[index] = chars[++index] = ' ';
                comment = null;
            }
            else if (current !== '\n' && current !== '\r')
            {
                chars[index] = ' ';
            }
            continue;
        }
        if (quote)
        {
            if (current === '\\')
            {
                index++;
            }
            else if (current === quote)
            {
                quote = null;
            }
            continue;
        }
        if (current === '"' || current === "'" || current === '`')
        {
            quote = current;
        }
        else if (current === '/' && (next === '/' || next === '*'))
        {
            comment = next === '/' ? 'line' : 'block';
            chars[index] = chars[++index] = ' ';
        }
    }
    return chars.join('');
}

function declarationAt(source, offset)
{
    return [...source.matchAll(/^(?:export )?(?:const|function|interface|type|class) (\w+)/gmu)].filter((match) => match.index <= offset).at(-1)?.[1];
}

function isMutationControl(relative, source, offset)
{
    if (!relative.startsWith('fsusui:vue/packages/wasm/markdown-embed-'))
    {
        return false;
    }
    const declaration = declarationAt(source, offset);
    if (/^evaluateMarkdownEmbed\w*Mutations$/u.test(declaration ?? ''))
    {
        return true;
    }
    if (relative.endsWith('/markdown-embed-directive.ts'))
    {
        return declaration === 'consumerRegexScan' || declaration === 'MarkdownEmbedMutationKind';
    }
    return relative.endsWith('/markdown-embed-acceptance.ts') && declaration === 'coverMutations';
}

function isGovernanceRuleLiteral(relative, source, offset)
{
    const declaration = relative === 'blog:tools/governance/check-article-embed-contract.mjs' ? 'const forbiddenRuntime = ['
        : relative === 'blog:tools/governance/check-article-embed-legacy.mjs' ? 'const rules = [' : null;
    if (!declaration)
    {
        return false;
    }
    const start = source.indexOf(declaration);
    const delimiter = declaration.includes('forbiddenRuntime') ? '\n    ];' : '\n];';
    const end = source.indexOf(delimiter, start);
    return start >= 0 && end > start && offset >= start && offset < end;
}

function isRejectionArgument(source, offset)
{
    // Only recognize the actual argument span of a throw-only validation branch.
    // An unrelated rejection word near an executable include is never a waiver.
    const branches = /if\s*\(\s*ContainsAnyOrdinalIgnoreCase\(([\s\S]{0,3000}?)\)\)\s*\{\s*throw new \w+\([^;]*\);\s*\}/gu;
    for (const branch of source.matchAll(branches))
    {
        const start = branch.index + branch[0].indexOf(branch[1]);
        if (offset >= start && offset < start + branch[1].length)
        {
            return true;
        }
    }
    return false;
}

function sourceRole(relative)
{
    const file = relative.slice(relative.indexOf(':') + 1);
    if (/(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/u.test(file))
    {
        return 'test-reference';
    }
    if (/\.(?:md|mdx|txt)$/u.test(file))
    {
        return 'document-reference';
    }
    if (/^(?:artifacts|config)\//u.test(file) || /\.(?:json|ya?ml|xml|csproj|props|targets)$/u.test(file))
    {
        return 'configuration-reference';
    }
    return 'runtime-or-tool';
}

export function inventoryArticleEmbedLegacySources(sources)
{
    const findings = [];
    const files = [];
    for (const [relative, source] of [...sources].sort(([left], [right]) => left.localeCompare(right)))
    {
        const code = maskComments(source);
        const embedContext = /ArticleEmbed|article[-_]embed|markdown[-_]embed|markdown-editor\.vue/iu.test(relative)
            || /\bembedProvider\b/gu.test(code);
        const role = sourceRole(relative);
        files.push({ path: relative, role, sha256: createHash('sha256').update(source).digest('hex') });
        for (const [rule, expression, scoped] of rules)
        {
            if (scoped && !embedContext)
            {
                continue;
            }
            for (const match of source.matchAll(new RegExp(expression.source, expression.flags)))
            {
                const offset = match.index;
                const line = source.slice(0, offset).split('\n').length;
                let disposition = 'active';
                if (code.slice(offset, offset + match[0].length) !== match[0])
                {
                    disposition = 'comment';
                }
                else if (role !== 'runtime-or-tool')
                {
                    disposition = role;
                }
                else if (isMutationControl(relative, code, offset))
                {
                    disposition = 'mutation-control';
                }
                else if (relative === 'blog:tools/governance/check-article-embed-legacy.mjs'
                    && declarationAt(code, offset) === 'isMutationControl'
                    && /['"]/u.test(code[offset - 1]) && code[offset + match[0].length] === code[offset - 1])
                {
                    disposition = 'inventory-classifier';
                }
                else if (isGovernanceRuleLiteral(relative, code, offset))
                {
                    disposition = 'governance-reference';
                }
                else if (rule === 'html-provider-payload' && /^\s*null\b/u.test(code.slice(offset + match[0].length)))
                {
                    disposition = 'inert-null-field';
                }
                else if (rule === 'include-syntax')
                {
                    disposition = isRejectionArgument(code, offset) ? 'denial' : 'review';
                }
                findings.push({ path: relative, line, rule, role, disposition });
            }
        }
    }
    const diagnostics = findings.filter((finding) => finding.disposition === 'active' || finding.disposition === 'review');
    return { kind: 'source-inventory-not-runtime-acceptance', scannedFiles: files.length, files, findings, diagnostics };
}

export function readArticleEmbedLegacySources({ blogRoot = repositoryRoot, uiRoot } = {})
{
    const actualUiRoot = resolveLocalFsusUiRepositoryRoot({ repositoryRoot: blogRoot, override: uiRoot });
    if (!actualUiRoot)
    {
        throw new Error('actual local FsusUI source is required for embed legacy inventory');
    }
    const sources = new Map();
    const heads = {};
    for (const [name, root] of [['blog', blogRoot], ['fsusui', actualUiRoot]])
    {
        heads[name] = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
        for (const relative of tracked.sort())
        {
            if (!/\.(?:cs|[cm]?js|[jt]sx?|vue|c|cc|cpp|h|hpp|md|mdx|json|ya?ml|xml|csproj|props|targets|sql|sh|ps1|txt)$/u.test(relative))
            {
                continue;
            }
            sources.set(`${name}:${relative}`, readFileSync(path.join(root, relative), 'utf8'));
        }
    }
    return { sources, heads, uiRoot: actualUiRoot };
}

export function checkArticleEmbedLegacy(options = {})
{
    const read = readArticleEmbedLegacySources(options);
    return { ...inventoryArticleEmbedLegacySources(read.sources), heads: read.heads, uiRoot: read.uiRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const report = checkArticleEmbedLegacy({ uiRoot: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (report.diagnostics.length)
        {
            process.exitCode = 1;
        }
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
