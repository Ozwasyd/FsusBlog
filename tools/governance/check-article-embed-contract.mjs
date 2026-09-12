#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractsFile = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedContracts.cs';
const codecFile = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedTargetCodec.cs';
const validatorFile = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedContractValidator.cs';
const digestFile = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedContractDigest.cs';
const schemaFile = 'src/shared/Contracts/ArticleEmbeds/article-embed-contract.schema.json';
const requiredFiles = [contractsFile, codecFile, validatorFile, digestFile, schemaFile];

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
            else if (entry.isFile() && /\.(?:cs|json|js|jsx|mjs|ts|tsx|vue)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readArticleEmbedSources(root = repositoryRoot)
{
    return new Map(walk(path.join(root, 'src')).map((absolute) => [
        toPosix(path.relative(root, absolute)),
        readFileSync(absolute, 'utf8')
    ]));
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

export function checkArticleEmbedContractSources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(`required article embed authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const codecs = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbed[A-Za-z0-9_]*(?:TargetCodec|TargetParser|TargetDecoder)[A-Za-z0-9_]*)\b/gu
    );
    const requests = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedProviderRequest[A-Za-z0-9_]*)\b/gu
    );
    const results = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedProviderResult[A-Za-z0-9_]*)\b/gu
    );
    const dependencies = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedDependencyCoordinate[A-Za-z0-9_]*)\b/gu
    );
    const expectedCodec = `${codecFile}:ArticleEmbedTargetCodec`;
    const expectedRequest = `${contractsFile}:ArticleEmbedProviderRequest`;
    const expectedResult = `${contractsFile}:ArticleEmbedProviderResult`;
    const expectedDependency = `${contractsFile}:ArticleEmbedDependencyCoordinate`;
    if (codecs.length !== 1 || codecs[0] !== expectedCodec)
    {
        violations.push(`expected exact-one target codec ${expectedCodec}; found ${codecs.join(', ') || '<none>'}`);
    }
    if (requests.length !== 1 || requests[0] !== expectedRequest)
    {
        violations.push(`expected exact-one provider request contract ${expectedRequest}; found ${requests.join(', ') || '<none>'}`);
    }
    if (results.length !== 1 || results[0] !== expectedResult)
    {
        violations.push(`expected exact-one provider result contract ${expectedResult}; found ${results.join(', ') || '<none>'}`);
    }
    if (dependencies.length !== 1 || dependencies[0] !== expectedDependency)
    {
        violations.push(`expected exact-one dependency coordinate ${expectedDependency}; found ${dependencies.join(', ') || '<none>'}`);
    }

    const codecSource = sources.get(codecFile);
    const validatorSource = sources.get(validatorFile);
    const contractsSource = sources.get(contractsFile);
    const schemaSource = sources.get(schemaFile);
    const contractImplementation = `${codecSource}\n${validatorSource}`;
    const forbiddenRuntime = [
        ['regular-expression target parsing', /\b(?:Regex|GeneratedRegex|matchAll|\.match\s*\(|\.exec\s*\()/u],
        ['compatibility include or wikilink syntax', /::include|!\[\[|\[\[[^\]]/u],
        ['remote or file target', /https?:\/\/|file:\/\/|\.\.\//u],
        ['HTML or DOM provider payload', /\b[A-Za-z0-9_]*(?:Html|HTML|Dom|DOM|IFrame|WebView|VueComponent|innerHTML|outerHTML|querySelector)[A-Za-z0-9_]*\b/u],
        ['mode inference or guessing', /\b(?:Infer|Guess|Derive)[A-Za-z0-9_]*Mode\b/u],
        ['database-id target identity', /\b(?:Database|Db|Sql)[A-Za-z0-9_]*ArticleId\b/u]
    ];
    for (const [label, expression] of forbiddenRuntime)
    {
        if (expression.test(contractImplementation))
        {
            violations.push(`${codecFile}: ${label} is forbidden in the article embed codec/validator`);
        }
    }

    if (!/TryDecode\s*\(\s*string\?\s+token\s*,\s*ArticleEmbedTargetKind\s+mode\s*,/u.test(codecSource)
        || !/request\.Directive\.Mode\s*!=\s*request\.Target\.Kind/u.test(validatorSource)
        || !/request\.Directive\.TargetToken\s*!=\s*ArticleEmbedTargetCodec\.Encode\(request\.Target\)/u.test(validatorSource))
    {
        violations.push(`${codecFile}: caller-supplied mode and exact directive target binding are required`);
    }
    if (/\b[A-Za-z0-9_]*(?:Html|Dom|Component|IFrame|WebView|ServiceObject)[A-Za-z0-9_]*\b/u.test(withoutCSharpComments(contractsSource)))
    {
        violations.push(`${contractsFile}: provider result must not expose HTML, DOM, component, iframe, WebView or service-object fields`);
    }

    let schema;
    try
    {
        schema = JSON.parse(schemaSource);
    }
    catch (error)
    {
        violations.push(`${schemaFile}: invalid JSON: ${error.message}`);
        return violations;
    }
    const metadata = schema['x-fsusblog-contract'];
    const grammar = metadata?.sourceGrammar;
    if (metadata?.schema !== 'fsusblog.article-embed-contract.v1'
        || metadata?.contractVersion !== 1
        || grammar?.ownerPackage !== '@ozwasyd/element-plus/markdown-runtime'
        || grammar?.parserExport !== 'parseMarkdownEmbedLine'
        || grammar?.parserContract !== 'fsusui.markdown-embed-directive.v1'
        || grammar?.modeRequired !== true
        || grammar?.blogParserForbidden !== true
        || JSON.stringify(grammar?.modes) !== JSON.stringify(['article', 'heading', 'block']))
    {
        violations.push(`${schemaFile}: exact FsusUI #290 parser ownership and modes are required`);
    }
    if (JSON.stringify(metadata?.dependencyConsumers)
        !== JSON.stringify(['article-relation', 'article-package', 'document-export']))
    {
        violations.push(`${schemaFile}: relation, package and export must share the canonical dependency coordinate`);
    }
    for (const name of ['providerRequest', 'providerResult', 'dependencyCoordinate', 'target'])
    {
        if (schema.$defs?.[name]?.additionalProperties !== false)
        {
            violations.push(`${schemaFile}: ${name} must remain closed`);
        }
    }
    const resultProperties = Object.keys(schema.$defs?.providerResult?.properties ?? {});
    if (resultProperties.some((name) => /html|dom|component|iframe|webview|service/iu.test(name)))
    {
        violations.push(`${schemaFile}: provider result contains a forbidden executable or UI payload field`);
    }
    return violations;
}

export function checkArticleEmbedContract(root = repositoryRoot)
{
    return checkArticleEmbedContractSources(readArticleEmbedSources(root));
}

function main()
{
    const violations = checkArticleEmbedContract();
    if (violations.length > 0)
    {
        process.stderr.write(`[article-embed-contract] failed\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[article-embed-contract] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
