#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractDirectory = 'src/shared/Contracts/BlockLinks';
const contractsFile = `${contractDirectory}/BlockAnchorContracts.cs`;
const codecFile = `${contractDirectory}/BlockAnchorCodec.cs`;
const markdownFile = `${contractDirectory}/BlockAnchorMarkdown.cs`;
const validatorFile = `${contractDirectory}/BlockAnchorContractValidator.cs`;
const digestFile = `${contractDirectory}/BlockAnchorContractDigest.cs`;
const verifierFile = `${contractDirectory}/BlockAnchorIndependentVerifier.cs`;
const schemaFile = `${contractDirectory}/block-anchor-contract.schema.json`;
const testFile = 'tests/backend/Unit/BlockAnchorContractTests.cs';
const nodeTestFile = 'tests/tools/block-anchor-contract.test.mjs';
const documentationFile = 'docs/architecture/block-anchor-contract.md';
const requiredSourceFiles = [
    contractsFile,
    codecFile,
    markdownFile,
    validatorFile,
    digestFile,
    verifierFile,
    schemaFile
];

function toPosix(value)
{
    return value.replaceAll(path.sep, '/');
}

function walk(directory)
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
            else if (entry.isFile() && /\.(?:cs|json|js|jsx|mjs|ts|tsx|vue|md)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readBlockAnchorSources(root = repositoryRoot)
{
    const directories = ['src', 'tests', 'docs'];
    const sources = new Map();
    for (const directory of directories)
    {
        for (const absolute of walk(path.join(root, directory)))
        {
            sources.set(toPosix(path.relative(root, absolute)), readFileSync(absolute, 'utf8'));
        }
    }
    return sources;
}

function declarations(sources, expression)
{
    const found = [];
    for (const [relative, source] of sources)
    {
        for (const match of source.matchAll(expression))
        {
            found.push(`${relative}:${match[1]}`);
        }
    }
    return found;
}

function withoutCSharpComments(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/[^\r\n]*/gu, '');
}

function requiredFileErrors(sources)
{
    const missing = [];
    for (const relative of [...requiredSourceFiles, testFile, nodeTestFile, documentationFile])
    {
        if (!sources.has(relative))
        {
            missing.push(`required block-anchor authority file missing: ${relative}`);
        }
    }
    return missing;
}

export function checkBlockAnchorContractSources(sources)
{
    const violations = requiredFileErrors(sources);
    if (violations.length > 0)
    {
        return violations;
    }

    const sourceDeclarations = new Map(
        [...sources]
            .filter(([relative]) => relative.startsWith('src/'))
            .map(([relative, source]) => [relative, withoutCSharpComments(source)])
    );
    const anchorIds = declarations(
        sourceDeclarations,
        /\b(?:readonly\s+)?record\s+struct\s+([A-Za-z0-9_]*BlockAnchorId)\b/gu
    );
    const targets = declarations(
        sourceDeclarations,
        /\brecord\s+([A-Za-z0-9_]*ArticleBlockTarget)\b/gu
    );
    const consumerIdentities = declarations(
        sourceDeclarations,
        /\brecord\s+([A-Za-z0-9_]*BlockAnchorConsumerIdentity)\b/gu
    );
    const canonicalPredicates = declarations(
        sourceDeclarations,
        /\b(?:public|private|internal|protected)\s+static\s+bool\s+(IsCanonical)\s*\(/gu
    );
    if (anchorIds.length !== 1 || anchorIds[0] !== `${contractsFile}:BlockAnchorId`)
    {
        violations.push(`expected exact-one BlockAnchorId ${contractsFile}; found ${anchorIds.join(', ') || '<none>'}`);
    }
    if (targets.length !== 1 || targets[0] !== `${contractsFile}:ArticleBlockTarget`)
    {
        violations.push(`expected exact-one ArticleBlockTarget ${contractsFile}; found ${targets.join(', ') || '<none>'}`);
    }
    if (consumerIdentities.length !== 1 || consumerIdentities[0] !== `${contractsFile}:BlockAnchorConsumerIdentity`)
    {
        violations.push(`expected exact-one consumer identity ${contractsFile}; found ${consumerIdentities.join(', ') || '<none>'}`);
    }
    if (canonicalPredicates.length !== 1 || canonicalPredicates[0] !== `${contractsFile}:IsCanonical`)
    {
        violations.push(`expected exact-one anchor grammar predicate ${contractsFile}:IsCanonical; found ${canonicalPredicates.join(', ') || '<none>'}`);
    }

    const contracts = sourceDeclarations.get(contractsFile);
    const codec = sourceDeclarations.get(codecFile);
    const markdown = sourceDeclarations.get(markdownFile);
    const validator = sourceDeclarations.get(validatorFile);
    const digest = sourceDeclarations.get(digestFile);
    const verifier = sourceDeclarations.get(verifierFile);
    const implementation = [codec, markdown, validator, digest, verifier].join('\n');
    const forbiddenRuntime = [
        ['regular-expression parsing', /\b(?:Regex|GeneratedRegex|Match|matchAll)\b|\.(?:match|exec)\s*\(/u],
        ['percent decoding or compatibility normalization', /(?:UnescapeDataString|UrlDecode|PercentDecode|Transliterat|ToLower(?:Invariant)?|Trim(?:Start|End)?|Normalize\s*\()/u],
        ['content, source-offset or hash fallback identity', /(?:ContentHash|ContentDigest|SourceOffset|DomPath|DOMPath|ParagraphText|TextFallback|FirstMatch|FirstOrDefault)/u],
        ['query, relation, package or UI implementation', /\b(?:Query|Resolver|Relation|Package|Picker|UI)[A-Za-z0-9_]*|\b(?:DbContext|HttpClient|SaveChanges|RouteValueDictionary)\b/u],
        ['HTML or sidecar anchor authority', /(?:innerHTML|outerHTML|querySelector|Sidecar|DatabaseBlock|HtmlId|HtmlAnchor)/u],
        ['second marker or link syntax literal', /#\^|\[\[|\{#/u]
    ];
    for (const [label, expression] of forbiddenRuntime)
    {
        if (expression.test(implementation))
        {
            violations.push(`${contractDirectory}: ${label} is forbidden in the identity/codec slice`);
        }
    }

    const expectedErrors = [
        ['InvalidGrammar', 1],
        ['UnsupportedSyntax', 2],
        ['Duplicate', 3],
        ['MissingArticle', 4],
        ['MissingAnchor', 5],
        ['CodecMismatch', 6]
    ];
    if (!contracts.includes('BlockAnchorErrorCode')
        || expectedErrors.some(([name, value]) => !new RegExp(`\\b${name}\\s*=\\s*${value}\\b`, 'u').test(contracts)))
    {
        violations.push(`${contractsFile}: closed error taxonomy is incomplete`);
    }

    if (!codec.includes('BlockAnchorId.TryCreate')
        || !codec.includes('TryParseSourceMarker(')
        || !codec.includes('TryParseFragment(')
        || !codec.includes('TryParseUrl('))
    {
        violations.push(`${codecFile}: source marker, fragment and URL parsers must use the sole value-object validator`);
    }
    if (!markdown.includes('Uri.EscapeDataString')
        || !markdown.includes('BuildFragment')
        || !markdown.includes('TryParseFragment'))
    {
        violations.push(`${markdownFile}: route-only encoding and exact fragment parsing are required`);
    }
    if (!digest.includes('ComputeContract')
        || !digest.includes('ComputeTarget')
        || !digest.includes('ComputeConsumerIdentity'))
    {
        violations.push(`${digestFile}: contract, target and consumer digests are required`);
    }
    if (!verifier.includes('TryParseSourceMarker')
        || !verifier.includes('TryParseFragment')
        || !verifier.includes('BlockAnchorMarkdownParser.TryParse'))
    {
        violations.push(`${verifierFile}: independent source/fragment/Markdown re-reads are required`);
    }

    const articleEmbedCodec = sourceDeclarations.get('src/shared/Contracts/ArticleEmbeds/ArticleEmbedTargetCodec.cs') ?? '';
    if (!articleEmbedCodec.includes('=> BlockAnchorId.IsCanonical(value)'))
    {
        violations.push('ArticleEmbedTargetCodec must delegate block-anchor grammar to BlockAnchorId');
    }

    let schema;
    try
    {
        schema = JSON.parse(sources.get(schemaFile));
    }
    catch (error)
    {
        violations.push(`${schemaFile}: invalid JSON: ${error.message}`);
        return violations;
    }
    const properties = schema.properties ?? {};
    const exactConstants = [
        ['contract', 'fsusblog.block-anchor-contract.v1'],
        ['version', 1],
        ['upstreamContract', 'fsusui.markdown-anchor.v1'],
        ['grammar', '[a-z][a-z0-9-]{0,63}'],
        ['sourceMarkerPrefix', '^'],
        ['urlFragmentPrefix', '#'],
        ['markdownRoutePrefix', '/posts/'],
        ['digestAlgorithm', 'sha256'],
        ['canonicalSerialization', 'length-prefixed-utf8-v1'],
        ['verificationReceipt', 'fsusblog.block-anchor-verification-receipt.v1']
    ];
    for (const [name, value] of exactConstants)
    {
        if (properties[name]?.const !== value)
        {
            violations.push(`${schemaFile}: ${name} must remain the exact canonical constant`);
        }
    }
    if (schema.additionalProperties !== false || properties.errorCodes?.additionalProperties !== false)
    {
        violations.push(`${schemaFile}: contract and error taxonomy must be closed`);
    }

    const testSource = sources.get(testFile);
    const documentation = sources.get(documentationFile);
    for (const [label, text] of [
        ['test corpus', testSource],
        ['current documentation', documentation]
    ])
    {
        for (const required of ['#^', '[[', '{#', 'sidecar', 'content hash', 'first-match'])
        {
            if (!text.toLowerCase().includes(required.toLowerCase()))
            {
                violations.push(`${label} must record the forbidden ${required} mutation`);
            }
        }
    }
    if (!documentation.includes('FsusUI #289')
        || !documentation.includes('article identity')
        || !documentation.includes('query/index/picker/refactor/package'))
    {
        violations.push(`${documentationFile}: current contract boundaries and consumer digest rule are required`);
    }
    return violations;
}

export function checkBlockAnchorContract(root = repositoryRoot)
{
    return checkBlockAnchorContractSources(readBlockAnchorSources(root));
}

function main()
{
    const violations = checkBlockAnchorContract();
    if (violations.length > 0)
    {
        process.stderr.write(`[block-anchor-contract] failed\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[block-anchor-contract] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
