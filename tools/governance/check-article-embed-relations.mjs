#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const relationsDirectory = "src/shared/Contracts/ArticleEmbeds/Relations";
const contractsFile = `${relationsDirectory}/ArticleEmbedRelationContracts.cs`;
const validatorFile = `${relationsDirectory}/ArticleEmbedRelationContractValidator.cs`;
const deriverFile = `${relationsDirectory}/ArticleEmbedRelationDeriver.cs`;
const verifierFile = `${relationsDirectory}/ArticleEmbedRelationVerifier.cs`;
const digestFile = `${relationsDirectory}/ArticleEmbedRelationDigest.cs`;
const requiredFiles = [
    contractsFile,
    validatorFile,
    deriverFile,
    verifierFile,
    digestFile
];

function toPosix(value)
{
    return value.replaceAll(path.sep, "/");
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
            else if (
                entry.isFile() &&
                /\.(?:cs|json|js|jsx|mjs|ts|tsx|vue)$/u.test(entry.name)
            )
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readArticleEmbedRelationSources(root = repositoryRoot)
{
    return new Map(
        walk(path.join(root, "src")).map((absolute) => [
            toPosix(path.relative(root, absolute)),
            readFileSync(absolute, "utf8")
        ])
    );
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
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/[^\r\n]*/gu, "");
}

function recordParameters(source, recordName)
{
    const match = source.match(
        new RegExp(`\\brecord\\s+${recordName}\\s*\\(([^)]*)\\)`, "u")
    );
    return match ? match[1] : null;
}

export function checkArticleEmbedRelationSources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(
                `required article embed relation authority file missing: ${relative}`
            );
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const derivers = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbed[A-Za-z0-9_]*(?:RelationDeriver|RelationIndex|RelationStore|EdgeStore|EdgeIndex|RelationGraph)[A-Za-z0-9_]*)\b/gu
    );
    const verifiers = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbedRelation[A-Za-z0-9_]*Verifier[A-Za-z0-9_]*)\b/gu
    );
    const edges = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedRelationEdge)\b/gu
    );
    const edgeSets = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedRelationEdgeSet)\b/gu
    );
    const dependencyReceipts = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedDependencyReceipt)\b/gu
    );
    const queryReceipts = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedRelationQueryReceipt)\b/gu
    );
    const expectedDeriver = `${deriverFile}:ArticleEmbedRelationDeriver`;
    const expectedVerifier = `${verifierFile}:ArticleEmbedRelationVerifier`;
    const expectedEdge = `${contractsFile}:ArticleEmbedRelationEdge`;
    const expectedEdgeSet = `${contractsFile}:ArticleEmbedRelationEdgeSet`;
    const expectedReceipt = `${contractsFile}:ArticleEmbedDependencyReceipt`;
    const expectedQuery = `${contractsFile}:ArticleEmbedRelationQueryReceipt`;
    if (derivers.length !== 1 || derivers[0] !== expectedDeriver)
    {
        violations.push(
            `expected exact-one relation deriver ${expectedDeriver}; found ${derivers.join(", ") || "<none>"}`
        );
    }
    if (verifiers.length !== 1 || verifiers[0] !== expectedVerifier)
    {
        violations.push(
            `expected exact-one relation verifier ${expectedVerifier}; found ${verifiers.join(", ") || "<none>"}`
        );
    }
    if (edges.length !== 1 || edges[0] !== expectedEdge)
    {
        violations.push(
            `expected exact-one relation edge ${expectedEdge}; found ${edges.join(", ") || "<none>"}`
        );
    }
    if (edgeSets.length !== 1 || edgeSets[0] !== expectedEdgeSet)
    {
        violations.push(
            `expected exact-one relation edge set ${expectedEdgeSet}; found ${edgeSets.join(", ") || "<none>"}`
        );
    }
    if (
        dependencyReceipts.length !== 1 ||
        dependencyReceipts[0] !== expectedReceipt
    )
    {
        violations.push(
            `expected exact-one dependency receipt ${expectedReceipt}; found ${dependencyReceipts.join(", ") || "<none>"}`
        );
    }
    if (queryReceipts.length !== 1 || queryReceipts[0] !== expectedQuery)
    {
        violations.push(
            `expected exact-one relation query receipt ${expectedQuery}; found ${queryReceipts.join(", ") || "<none>"}`
        );
    }

    const relationSource = requiredFiles
        .map((relative) => withoutCSharpComments(sources.get(relative)))
        .join("\n");
    const forbiddenRelation = [
        [
            "regular-expression target or source parsing",
            /\b(?:Regex|GeneratedRegex|matchAll)\b|\.(?:match|exec)\s*\(/u
        ],
        [
            "rendered HTML, DOM, component or iframe payload",
            /\b[A-Za-z0-9_]*(?:Html|HTML|Dom|DOM|IFrame|WebView|VueComponent|innerHTML|outerHTML|querySelector|RenderedMarkdown)[A-Za-z0-9_]*\b/u
        ],
        [
            "authoring resolver or publication planner reuse",
            /\b(?:ArticleEmbedAuthoringResolver|ArticleEmbedPublicationPlanner)\s*\./u
        ],
        [
            "latest-target or previous-result reuse",
            /\b(?:GetLatest|LatestTarget|MostRecent|PreviousResult|AuthoringCache|PublicationCache)[A-Za-z0-9_]*\b/u
        ],
        [
            "title, slug, route or URL based resolution",
            /\b[A-Za-z0-9_]*(?:Title|Slug|Route)[A-Za-z0-9_]*\b|\bUrl\b/u
        ],
        [
            "persistent, cross-user or second cache or store",
            /\b(?:IMemoryCache|IDistributedCache|MemoryCache|ConcurrentDictionary)\b|\bstatic\s+(?:readonly\s+)?(?:Dictionary|HashSet)\s*</u
        ],
        [
            "business writes or transport inside the contract boundary",
            /\b(?:DbContext|SaveChanges|HttpClient|IHttpContext|RouteValueDictionary)\b/u
        ]
    ];
    for (const [label, expression] of forbiddenRelation)
    {
        if (expression.test(relationSource))
        {
            violations.push(
                `${relationsDirectory}: ${label} is forbidden in the article embed relation slice`
            );
        }
    }

    const deriverSource = withoutCSharpComments(sources.get(deriverFile));
    for (const guard of [
        [
            "authoring source re-verification",
            "ArticleEmbedDependencyGraphVerifier.Verify"
        ],
        [
            "publication source re-verification",
            "ArticleEmbedPublicationVerifier.Verify"
        ],
        ["sealed-plan requirement", "ArticleEmbedPublicationPlanStatus.Sealed"],
        ["blocked-plan rejection", "article_embed_relation_plan_blocked"],
        [
            "unverified-source rejection",
            "article_embed_relation_source_unverified"
        ],
        [
            "frozen-scope reconcile rejection",
            "article_embed_relation_scope_frozen_immutable"
        ],
        ["monotone reconcile generation", "previousGeneration + 1"],
        [
            "host binding drift check",
            "set.HostSourceRevision != snapshot.HostSourceRevision"
        ],
        ["derivation context drift check", "set.Actor != snapshot.Actor"],
        [
            "edge identity dedup",
            "ArticleEmbedRelationDigest.ComputeEdgeIdentity"
        ],
        [
            "bounded cache key digest",
            "ArticleEmbedRelationDigest.ComputeCacheKey"
        ],
        ["edge sealing", "ArticleEmbedRelationContractValidator.Seal"],
        ["actor-bound query enforcement", "actor != edgeSet.Actor"],
        ["frozen-only public query", "ArticleEmbedEdgeScope.FrozenPublication"],
        [
            "target-update transition",
            "ArticleEmbedInvalidationReason.TargetUpdated"
        ],
        [
            "non-public transition",
            "ArticleEmbedInvalidationReason.TargetNonPublic"
        ],
        [
            "removed-target transition",
            "ArticleEmbedInvalidationReason.TargetRemoved"
        ]
    ])
    {
        if (!deriverSource.includes(guard[1]))
        {
            violations.push(`${deriverFile}: missing ${guard[0]}`);
        }
    }

    const validatorSource = withoutCSharpComments(sources.get(validatorFile));
    for (const expectation of [
        "ArticleEmbedRelationDigest.ComputeEdge",
        "ArticleEmbedRelationDigest.ComputeEdgeIdentity",
        "ArticleEmbedRelationDigest.ComputeEdgeSet",
        "ArticleEmbedRelationDigest.ComputeDependencyReceipt",
        "ArticleEmbedRelationDigest.ComputeInvalidationTicket",
        "ArticleEmbedRelationDigest.ComputeQueryReceipt",
        "FixedTimeEquals",
        "article_embed_relation_edge_scope_status_mismatch",
        "article_embed_relation_edge_identity_mismatch",
        "article_embed_relation_edge_duplicate_or_scope_mismatch"
    ])
    {
        if (!validatorSource.includes(expectation))
        {
            violations.push(
                `${validatorFile}: relation sealing and validation incomplete; missing ${expectation}`
            );
        }
    }

    const verifierSource = withoutCSharpComments(sources.get(verifierFile));
    for (const forbidden of [
        "ArticleEmbedRelationDeriver.Derive",
        "ArticleEmbedRelationDeriver.Reconcile",
        "ArticleEmbedRelationDeriver.Query"
    ])
    {
        if (verifierSource.includes(forbidden))
        {
            violations.push(
                `${verifierFile}: the verifier must not call the deriver entry points it verifies`
            );
        }
    }
    for (const expectation of [
        "ArticleEmbedDependencyGraphVerifier.Verify",
        "ArticleEmbedPublicationVerifier.Verify",
        "ArticleEmbedRelationContractValidator.Validate",
        "ArticleEmbedRelationDigest.ComputeEdgeIdentity",
        "reconcile",
        "ticket"
    ])
    {
        if (!verifierSource.includes(expectation))
        {
            violations.push(
                `${verifierFile}: independent verification must re-verify sources, re-derive edges and recompute digests; missing ${expectation}`
            );
        }
    }

    const contractsSource = sources.get(contractsFile);
    if (!contractsSource.includes('"frozen-edge-artifact-only"'))
    {
        violations.push(
            `${contractsFile}: the frozen-only public delivery policy constant is required`
        );
    }
    const edgeParameters = recordParameters(
        contractsSource,
        "ArticleEmbedRelationEdge"
    );
    if (edgeParameters === null)
    {
        violations.push(
            `${contractsFile}: the relation edge record is required`
        );
    }
    else
    {
        for (const dimension of [
            "EdgeIdentity",
            "Scope",
            "Status",
            "OwnerPortableArticleIdentity",
            "OwnerRevision",
            "Directive",
            "Target",
            "ResolvedRevision",
            "LatestObservedRevision",
            "Visibility",
            "Lifecycle",
            "Permission",
            "DependencyDigest",
            "EdgeDigest"
        ])
        {
            if (!edgeParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the relation edge must bind ${dimension}`
                );
            }
        }
    }
    const edgeSetParameters = recordParameters(
        contractsSource,
        "ArticleEmbedRelationEdgeSet"
    );
    if (edgeSetParameters === null)
    {
        violations.push(
            `${contractsFile}: the relation edge set record is required`
        );
    }
    else
    {
        for (const dimension of [
            "HostDocument",
            "HostSourceRevision",
            "Scope",
            "AuthorityGeneration",
            "Actor",
            "Runtime",
            "SourceArtifactDigest",
            "Edges",
            "SetDigest"
        ])
        {
            if (!edgeSetParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the relation edge set must bind ${dimension}`
                );
            }
        }
    }
    const ticketParameters = recordParameters(
        contractsSource,
        "ArticleEmbedInvalidationTicket"
    );
    if (ticketParameters === null)
    {
        violations.push(
            `${contractsFile}: the invalidation ticket record is required`
        );
    }
    else
    {
        for (const dimension of [
            "EdgeIdentity",
            "FromStatus",
            "ToStatus",
            "Reason",
            "CacheKeyDigest",
            "ReconcileGeneration",
            "TicketDigest"
        ])
        {
            if (!ticketParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the invalidation ticket must bind ${dimension}`
                );
            }
        }
    }
    const cacheKeyParameters = recordParameters(
        contractsSource,
        "ArticleEmbedRelationCacheKey"
    );
    if (cacheKeyParameters === null)
    {
        violations.push(
            `${contractsFile}: the relation cache key record is required`
        );
    }
    else
    {
        for (const dimension of [
            "HostDocumentId",
            "HostDocumentEpoch",
            "HostSourceRevision",
            "Scope",
            "ProviderId",
            "ProviderVersion",
            "RuntimeDigest",
            "PermissionContextDigest",
            "SiteIdentity",
            "MaterialLocale",
            "MaterialTheme"
        ])
        {
            if (!cacheKeyParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the relation cache key must bind ${dimension}`
                );
            }
        }
    }
    for (const recordName of [
        "ArticleEmbedDependencyReceipt",
        "ArticleEmbedRelationQueryItem",
        "ArticleEmbedRelationQueryReceipt"
    ])
    {
        const parameters = recordParameters(contractsSource, recordName);
        if (
            parameters === null ||
            /DisplayText|Attribution|Content|Markdown|Html/u.test(parameters)
        )
        {
            violations.push(
                `${contractsFile}: ${recordName} must record identities, statuses and digests only, never target content`
            );
        }
    }
    return violations;
}

export function checkArticleEmbedRelations(root = repositoryRoot)
{
    return checkArticleEmbedRelationSources(
        readArticleEmbedRelationSources(root)
    );
}

function main()
{
    const violations = checkArticleEmbedRelations();
    if (violations.length > 0)
    {
        process.stderr.write(
            `[article-embed-relations] failed\n${violations.map((item) => `- ${item}`).join("\n")}\n`
        );
        process.exitCode = 1;
        return;
    }
    process.stdout.write("[article-embed-relations] ok\n");
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
{
    main();
}
