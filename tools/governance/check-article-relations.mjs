#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractDirectory = 'src/shared/Contracts/ArticleRelations';
const contractsFile = `${contractDirectory}/ArticleRelationContracts.cs`;
const catalogFile = `${contractDirectory}/ArticleRelationCatalog.cs`;
const digestFile = `${contractDirectory}/ArticleRelationDigest.cs`;
const validatorFile = `${contractDirectory}/ArticleRelationContractValidator.cs`;
const schemaFile = 'config/schemas/article-relation-contract.schema.json';
const catalogJsonFile = 'config/contracts/article-relation-catalog.json';
const requiredFiles = [contractsFile, catalogFile, digestFile, validatorFile];

const expectedKinds = ['outgoing', 'backlink', 'broken', 'visibility-risk', 'unlinked-mention'];
const expectedResolutionStatuses = [
    'resolved',
    'missing-target',
    'missing-anchor',
    'deleted',
    'archived',
    'unauthorized',
    'private',
    'draft',
    'stale',
    'ambiguous',
    'unsupported'
];
const expectedLifecycleEvents = [
    'create',
    'edit',
    'publish',
    'schedule',
    'archive',
    'delete',
    'restore',
    'rollback',
    'import',
    'migration',
    'slug-title-heading-rename'
];
const expectedLifecycleStates = ['draft', 'scheduled', 'published', 'archived', 'deleted'];
const expectedReceiptKinds = ['index', 'query', 'ignore-decision', 'prepublish', 'inspector'];

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
            else if (entry.isFile() && /\.cs$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readArticleRelationSources(root = repositoryRoot)
{
    return new Map(walk(path.join(root, 'src')).map((absolute) => [
        toPosix(path.relative(root, absolute)),
        readFileSync(absolute, 'utf8')
    ]));
}

function withoutComments(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/[^\r\n]*/gu, '');
}

function declarations(sources, expression)
{
    const found = [];
    for (const [relative, source] of sources)
    {
        for (const match of withoutComments(source).matchAll(expression))
        {
            found.push(`${relative}:${match[1]}`);
        }
    }
    return found;
}

function enumMembers(source, enumName)
{
    const match = withoutComments(source).match(
        new RegExp(`\\benum\\s+${enumName}(?:\\s*:\\s*[^\\{]+)?\\s*\\{([\\s\\S]*?)\\}`, 'u')
    );
    if (!match)
    {
        return [];
    }
    return [...match[1].matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:\d+|0x[0-9a-f]+)\s*,?/giu)]
        .map((item) => item[1]);
}

function exactMembers(source, enumName, expected)
{
    return JSON.stringify(enumMembers(source, enumName)) === JSON.stringify(expected);
}

export function checkArticleRelationSources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(`required article relation authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const contracts = withoutComments(sources.get(contractsFile));
    const catalog = withoutComments(sources.get(catalogFile));
    const digest = withoutComments(sources.get(digestFile));
    const validator = withoutComments(sources.get(validatorFile));
    const relationSource = `${contracts}\n${catalog}\n${digest}\n${validator}`;

    const exactAuthorities = [
        [declarations(sources, /\bclass\s+(ArticleRelationSchemas)\b/gu), `${contractsFile}:ArticleRelationSchemas`, 'schema constants'],
        [declarations(sources, /\b(?:sealed\s+)?record\s+(ArticleRelationRecord)\b/gu), `${contractsFile}:ArticleRelationRecord`, 'relation record'],
        [declarations(sources, /\b(?:sealed\s+)?record\s+(ArticleRelationSet)\b/gu), `${contractsFile}:ArticleRelationSet`, 'relation set'],
        [declarations(sources, /\b(?:sealed\s+)?record\s+(ArticleRelationUnlinkedMentionCandidate)\b/gu), `${contractsFile}:ArticleRelationUnlinkedMentionCandidate`, 'mention candidate'],
        [declarations(sources, /\b(?:sealed\s+)?record\s+(ArticleRelationLifecycleEvent)\b/gu), `${contractsFile}:ArticleRelationLifecycleEvent`, 'lifecycle event'],
        [declarations(sources, /\b(?:sealed\s+)?record\s+(ArticleRelationReceipt)\b/gu), `${contractsFile}:ArticleRelationReceipt`, 'receipt'],
        [declarations(sources, /\b(?:sealed\s+)?enum\s+(ArticleRelationKind)\b/gu), `${contractsFile}:ArticleRelationKind`, 'relation kind enum'],
        [declarations(sources, /\b(?:sealed\s+)?enum\s+(ArticleRelationResolutionStatus)\b/gu), `${contractsFile}:ArticleRelationResolutionStatus`, 'resolution status enum'],
        [declarations(sources, /\b(?:sealed\s+)?enum\s+(ArticleRelationLifecycleEventKind)\b/gu), `${contractsFile}:ArticleRelationLifecycleEventKind`, 'lifecycle event enum'],
        [declarations(sources, /\bclass\s+(ArticleRelationCatalog)\b/gu), `${catalogFile}:ArticleRelationCatalog`, 'relation catalog'],
        [declarations(sources, /\bclass\s+(ArticleRelationDigest)\b/gu), `${digestFile}:ArticleRelationDigest`, 'relation digest'],
        [declarations(sources, /\bclass\s+(ArticleRelationContractValidator)\b/gu), `${validatorFile}:ArticleRelationContractValidator`, 'relation validator']
    ];
    for (const [found, expected, label] of exactAuthorities)
    {
        if (found.length !== 1 || found[0] !== expected)
        {
            violations.push(`expected exact-one ${label} ${expected}; found ${found.join(', ') || '<none>'}`);
        }
    }

    if (!exactMembers(contracts, 'ArticleRelationKind', [
        'Outgoing',
        'Backlink',
        'Broken',
        'VisibilityRisk',
        'UnlinkedMention'
    ]))
    {
        violations.push('relation kind enum must remain the exact five closed kinds');
    }
    if (!exactMembers(contracts, 'ArticleRelationResolutionStatus', [
        'Resolved',
        'MissingTarget',
        'MissingAnchor',
        'Deleted',
        'Archived',
        'Unauthorized',
        'Private',
        'Draft',
        'Stale',
        'Ambiguous',
        'Unsupported'
    ]))
    {
        violations.push('resolution status enum must remain closed and unknown-free');
    }
    if (!exactMembers(contracts, 'ArticleRelationLifecycleEventKind', [
        'Create',
        'Edit',
        'Publish',
        'Schedule',
        'Archive',
        'Delete',
        'Restore',
        'Rollback',
        'Import',
        'Migration',
        'SlugTitleHeadingRename'
    ]))
    {
        violations.push('lifecycle event enum must remain the exact closed event set');
    }

    const forbidden = [
        ['Markdown parser or regular-expression scanning', /\b(?:Regex|GeneratedRegex|System\.Text\.RegularExpressions|MarkdownParser|parseMarkdown|matchAll)\b|\.(?:Match|Exec)\s*\(/u],
        ['rendered HTML, DOM, component or browser payload', /\b[A-Za-z0-9_]*(?:Html|HTML|Dom|DOM|IFrame|WebView|Vue|Component|innerHTML|outerHTML|querySelector)[A-Za-z0-9_]*\b/u],
        ['database, transport or business write', /\b(?:DbContext|SaveChanges|HttpClient|IHttpContext|INSERT\s+INTO|UPDATE\s+.*\bSET\b|DELETE\s+FROM)\b/u],
        ['AI, embedding, fuzzy or semantic relationship type', /\b(?:AI|LLM|Embedding|Vector|Fuzzy|SemanticSimilarity|KnowledgeGraph)\b/u],
        ['related-reading or search-index authority', /\b(?:RelatedReading|SearchIndex|SearchIndexService|SearchIndexEntry)\b/u]
    ];
    for (const [label, expression] of forbidden)
    {
        if (expression.test(relationSource))
        {
            violations.push(`${contractDirectory}: ${label} is forbidden in the contract slice`);
        }
    }

    const implementationNames = declarations(
        sources,
        /\b(?:class|interface|struct)\s+([A-Za-z0-9_]*ArticleRelation[A-Za-z0-9_]*(?:Parser|Producer|Indexer|IndexWriter|Query|Prepublish|Inspector|Ui)[A-Za-z0-9_]*)\b/gu
    );
    if (implementationNames.length > 0)
    {
        violations.push(`relation contract slice contains a forbidden downstream implementation: ${implementationNames.join(', ')}`);
    }

    const targetIdentity = contracts.match(
        /\brecord\s+ArticleRelationTargetIdentity\s*\(([^)]*)\)/u
    );
    if (!targetIdentity || /\b(?:Url|URL|Slug|Title|HeadingText|Route|Path)\b/u.test(targetIdentity[1]))
    {
        violations.push('target identity must contain stable identities only, never URL/slug/title/heading text');
    }
    if (/\b(?:bool\s+(?:Is)?Visible|Visible\s*=)\b/u.test(relationSource))
    {
        violations.push('relation visibility must not collapse to a visible boolean');
    }
    const receiptPayload = [
        contracts.match(/\brecord\s+ArticleRelationReceiptContext\s*\(([^)]*)\)/u)?.[1] ?? '',
        contracts.match(/\brecord\s+ArticleRelationReceipt\s*\(([^)]*)\)/u)?.[1] ?? ''
    ].join('\n');
    if (/\b(?:Content|Markdown|Html|HTML|Body|Title|DisplayText|RenderedOutput)\b/u.test(receiptPayload))
    {
        violations.push('relation receipts must record identities, statuses and digests only');
    }

    const requiredGuards = [
        ['catalog validation', 'ArticleRelationCatalog.Validate'],
        ['kind orphan rejection', 'article_relation_kind_orphan'],
        ['stable target requirement', 'article_relation_kind_target_required'],
        ['duplicate relation rejection', 'article_relation_duplicate_or_orphan_record'],
        ['draft/public rejection', 'article_relation_public_draft_or_private_mix'],
        ['target revision/lifecycle consistency', 'article_relation_target_draft_revision_lifecycle_mismatch'],
        ['unknown contract rejection', 'article_relation_contract_version_unknown'],
        ['unowned lifecycle rejection', 'article_relation_lifecycle_owner_mismatch'],
        ['relation identity digest', 'article_relation_identity_digest_mismatch'],
        ['record digest', 'article_relation_record_digest_mismatch'],
        ['candidate non-authority rejection', 'article_relation_mention_candidate_invalid'],
        ['lifecycle obligation validation', 'article_relation_lifecycle_obligations_invalid'],
        ['receipt digest validation', 'article_relation_receipt_digest_mismatch']
    ];
    for (const [label, token] of requiredGuards)
    {
        if (!validator.includes(token) && !catalog.includes(token))
        {
            violations.push(`missing ${label} guard: ${token}`);
        }
    }

    if (!digest.includes('length-prefixed') && !contracts.includes('CanonicalSerialization'))
    {
        violations.push('relation contracts must declare the canonical length-prefixed serialization');
    }

    return violations;
}

export function checkArticleRelationCatalog(catalog, schema)
{
    const violations = [];
    if (!catalog || catalog.schema !== 'fsusblog.article-relation-catalog.v1'
        || catalog.contract !== 'fsusblog.article-relation-contract.v1'
        || catalog.version !== 1
        || catalog.kindCatalogVersion !== 1
        || catalog.resolutionCatalogVersion !== 1
        || catalog.visibilityCatalogVersion !== 1
        || catalog.lifecycleCatalogVersion !== 1
        || catalog.publicQueryPolicy !== 'current-public-publication-only')
    {
        violations.push('article relation catalog metadata/version/policy is not canonical');
    }

    const kinds = catalog?.kinds;
    if (!Array.isArray(kinds) || kinds.length !== expectedKinds.length)
    {
        violations.push('article relation catalog must contain exactly five kind definitions');
    }
    else
    {
        const keys = kinds.map((entry) => entry?.key);
        if (JSON.stringify(keys) !== JSON.stringify(expectedKinds))
        {
            violations.push(`article relation kind keys must be ${JSON.stringify(expectedKinds)}`);
        }
        const owners = kinds.map((entry) => entry?.owner);
        if (new Set(owners).size !== kinds.length || owners.some((owner) => typeof owner !== 'string' || owner.length === 0))
        {
            violations.push('article relation kind owners must be unique and non-empty');
        }
        for (const entry of kinds)
        {
            if (typeof entry?.sourceFacts !== 'string'
                || typeof entry?.targetFacts !== 'string'
                || !Array.isArray(entry?.eligibility)
                || entry.eligibility.length === 0
                || typeof entry?.proofTestId !== 'string'
                || typeof entry?.requiresStableTarget !== 'boolean')
            {
                violations.push(`article relation kind definition is incomplete: ${entry?.key ?? '<missing>'}`);
            }
        }
    }

    if (JSON.stringify(catalog?.resolutionStatuses) !== JSON.stringify(expectedResolutionStatuses))
    {
        violations.push('article relation resolution statuses are not the exact closed set');
    }
    if (JSON.stringify(catalog?.lifecycleEvents) !== JSON.stringify(expectedLifecycleEvents))
    {
        violations.push('article relation lifecycle events are not the exact closed set');
    }
    if (!Array.isArray(catalog?.revisionKinds)
        || JSON.stringify(catalog.revisionKinds) !== JSON.stringify(['draft', 'current', 'published']))
    {
        violations.push('article relation revision kinds must distinguish draft/current/published');
    }
    if (JSON.stringify(catalog?.lifecycleStates) !== JSON.stringify(expectedLifecycleStates))
    {
        violations.push('article relation lifecycle states are not the exact closed set');
    }
    if (JSON.stringify(catalog?.receipts) !== JSON.stringify(expectedReceiptKinds))
    {
        violations.push('article relation receipt kinds are not the exact closed set');
    }

    const metadata = schema?.['x-fsusblog-contract'];
    if (!schema || metadata?.schema !== 'fsusblog.article-relation-contract.v1'
        || metadata.contractVersion !== 1
        || metadata.publicQueryPolicy !== 'current-public-publication-only'
        || metadata.identityPolicy !== 'stable-article-revision-range-anchor-only'
        || JSON.stringify(metadata.projectionOnlyFields) !== JSON.stringify(['url', 'slug', 'title', 'headingText']))
    {
        violations.push('article relation schema metadata does not declare the stable-identity/projection boundary');
    }
    if (JSON.stringify(metadata?.forbiddenAuthorities)
        !== JSON.stringify(['frontend-regex', 'rendered-dom', 'related-reading', 'search-index', 'ai', 'embedding']))
    {
        violations.push('article relation schema metadata must close frontend/rendered/search/AI authorities');
    }

    for (const name of [
        'coordinate',
        'targetIdentity',
        'sourceFacts',
        'targetFacts',
        'visibilityFacts',
        'relation',
        'mentionCandidate',
        'lifecycleEvent',
        'receipt'
    ])
    {
        if (schema?.$defs?.[name]?.additionalProperties !== false)
        {
            violations.push(`article relation schema definition ${name} must remain closed`);
        }
    }
    if (schema?.$defs?.targetIdentity?.properties?.url
        || schema?.$defs?.targetIdentity?.properties?.slug
        || schema?.$defs?.targetIdentity?.properties?.title
        || schema?.$defs?.targetIdentity?.properties?.headingText)
    {
        violations.push('target identity schema must not define URL/slug/title/heading-text fields');
    }
    if (schema?.$defs?.targetIdentity?.properties?.blockAnchorIdentity?.oneOf?.[0]?.pattern
        !== '^(?:(?:block|anchor):)?[a-z][a-z0-9-]{0,63}$')
    {
        violations.push('block target schema must accept canonical raw anchors and preserve only canonical prefixed suffixes');
    }
    if (schema?.$defs?.mentionCandidate?.properties?.isAuthoritative?.const !== false)
    {
        violations.push('unlinked mention candidate schema must be explicitly non-authoritative');
    }
    return violations;
}

export function checkArticleRelations(root = repositoryRoot)
{
    const sourceViolations = checkArticleRelationSources(readArticleRelationSources(root));
    let catalog;
    let schema;
    try
    {
        catalog = JSON.parse(readFileSync(path.join(root, catalogJsonFile), 'utf8'));
    }
    catch (error)
    {
        sourceViolations.push(`${catalogJsonFile}: invalid JSON: ${error.message}`);
    }
    try
    {
        schema = JSON.parse(readFileSync(path.join(root, schemaFile), 'utf8'));
    }
    catch (error)
    {
        sourceViolations.push(`${schemaFile}: invalid JSON: ${error.message}`);
    }
    return sourceViolations.concat(checkArticleRelationCatalog(catalog, schema));
}

function main()
{
    const violations = checkArticleRelations();
    if (violations.length > 0)
    {
        process.stderr.write(`[article-relations] failed\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[article-relations] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
