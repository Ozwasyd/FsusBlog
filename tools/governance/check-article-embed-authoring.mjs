#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const authoringDirectory = "src/shared/Contracts/ArticleEmbeds/Authoring";
const contractsFile = `${authoringDirectory}/ArticleEmbedAuthoringContracts.cs`;
const validatorFile = `${authoringDirectory}/ArticleEmbedAuthoringContractValidator.cs`;
const resolverFile = `${authoringDirectory}/ArticleEmbedAuthoringResolver.cs`;
const verifierFile = `${authoringDirectory}/ArticleEmbedAuthoringVerifier.cs`;
const graphDirectory = "src/shared/Contracts/ArticleEmbeds/Graph";
const graphPlannerFile = `${graphDirectory}/ArticleEmbedDependencyGraphPlanner.cs`;
const graphVerifierFile = `${graphDirectory}/ArticleEmbedDependencyGraphVerifier.cs`;
const digestFile = `${authoringDirectory}/ArticleEmbedAuthoringDigest.cs`;
const requiredFiles = [
    contractsFile,
    validatorFile,
    resolverFile,
    verifierFile,
    digestFile,
    graphPlannerFile,
    graphVerifierFile
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

export function readArticleEmbedAuthoringSources(root = repositoryRoot)
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

export function checkArticleEmbedAuthoringSources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(
                `required article embed authoring authority file missing: ${relative}`
            );
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const resolvers = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbed[A-Za-z0-9_]*(?:AuthoringResolver|AuthoringProvider|AuthoringExpander)[A-Za-z0-9_]*)\b/gu
    );
    const verifiers = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbedAuthoring[A-Za-z0-9_]*Verifier[A-Za-z0-9_]*)\b/gu
    );
    const snapshots = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedAuthoritySnapshot)\b/gu
    );
    const resolutions = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedAuthoringResolution)\b/gu
    );
    const receipts = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedAuthoringReceipt)\b/gu
    );
    const expectedResolver = `${resolverFile}:ArticleEmbedAuthoringResolver`;
    const expectedVerifier = `${verifierFile}:ArticleEmbedAuthoringVerifier`;
    const expectedSnapshot = `${contractsFile}:ArticleEmbedAuthoritySnapshot`;
    const expectedResolution = `${contractsFile}:ArticleEmbedAuthoringResolution`;
    const expectedReceipt = `${contractsFile}:ArticleEmbedAuthoringReceipt`;
    if (resolvers.length !== 1 || resolvers[0] !== expectedResolver)
    {
        violations.push(
            `expected exact-one authoring resolver ${expectedResolver}; found ${resolvers.join(", ") || "<none>"}`
        );
    }
    if (verifiers.length !== 1 || verifiers[0] !== expectedVerifier)
    {
        violations.push(
            `expected exact-one authoring verifier ${expectedVerifier}; found ${verifiers.join(", ") || "<none>"}`
        );
    }
    if (snapshots.length !== 1 || snapshots[0] !== expectedSnapshot)
    {
        violations.push(
            `expected exact-one authority snapshot ${expectedSnapshot}; found ${snapshots.join(", ") || "<none>"}`
        );
    }
    if (resolutions.length !== 1 || resolutions[0] !== expectedResolution)
    {
        violations.push(
            `expected exact-one authoring resolution ${expectedResolution}; found ${resolutions.join(", ") || "<none>"}`
        );
    }
    if (receipts.length !== 1 || receipts[0] !== expectedReceipt)
    {
        violations.push(
            `expected exact-one authoring receipt ${expectedReceipt}; found ${receipts.join(", ") || "<none>"}`
        );
    }

    const authoringSource = requiredFiles
        .map((relative) => withoutCSharpComments(sources.get(relative)))
        .join("\n");
    const forbiddenAuthoring = [
        [
            "regular-expression target or source parsing",
            /\b(?:Regex|GeneratedRegex|matchAll)\b|\.(?:match|exec)\s*\(/u
        ],
        [
            "rendered HTML, DOM, component or iframe payload",
            /\b[A-Za-z0-9_]*(?:Html|HTML|Dom|DOM|IFrame|WebView|VueComponent|innerHTML|outerHTML|querySelector|RenderedMarkdown)[A-Za-z0-9_]*\b/u
        ],
        [
            "latest or publication-plan target reuse",
            /\b(?:GetLatest|LatestTarget|LatestRevision|MostRecent|PublicationPlan)[A-Za-z0-9_]*\b/u
        ],
        [
            "title, slug, route or URL based resolution",
            /\b[A-Za-z0-9_]*(?:Title|Slug|Route)[A-Za-z0-9_]*\b|\bUrl\b/u
        ],
        [
            "persistent or cross-user cache",
            /\b(?:IMemoryCache|IDistributedCache|MemoryCache|ConcurrentDictionary)\b|\bstatic\s+(?:readonly\s+)?(?:Dictionary|HashSet)\s*</u
        ]
    ];
    for (const [label, expression] of forbiddenAuthoring)
    {
        if (expression.test(authoringSource))
        {
            violations.push(
                `${authoringDirectory}: ${label} is forbidden in the article embed authoring slice`
            );
        }
    }

    const resolverSource = withoutCSharpComments(sources.get(resolverFile));
    const graphSource = withoutCSharpComments(sources.get(graphPlannerFile));
    for (const [relative, source, guards] of [
        [resolverFile, resolverSource, [
            ["closed expanded-node budget", "MaxExpandedNodes"],
            ["closed source-byte budget", "MaxSourceBytes"],
            ["closed elapsed-time budget", "MaxElapsedMilliseconds"],
            ["closed authority-message budget", "MaxAuthorityMessages"],
            ["stale cancellation observation", "IsCancellationRequested"],
            ["authoring scope enforcement", "RequestedScope != ArticleEmbedRequestedScope.Authoring"],
            ["host source binding", "snapshot.HostSourceDigest"],
            ["permission context binding", "snapshot.Actor"],
            ["provider runtime binding", "snapshot.Runtime"]
        ]],
        [graphPlannerFile, graphSource, [
            ["closed depth budget", "MaxDepth"],
            ["closed expanded-node budget", "MaxExpandedNodes"],
            ["closed elapsed-time budget", "MaxElapsedMilliseconds"],
            ["cycle detection on the expansion path", "path.Contains"],
            ["stale cancellation observation", "IsCancellationRequested"],
            ["projection stage re-verification", "ArticleEmbedAuthoringVerifier.Verify"],
            ["sole current projection owner", "ArticleEmbedAuthoringResolver.ProjectCurrent"]
        ]]
    ])
    {
        for (const [label, token] of guards)
        {
            if (!source.includes(token))
            {
                violations.push(`${relative}: missing ${label}`);
            }
        }
    }
    if (/ResolveNode|ResolveNested|OrderedNested|path\.Contains|\.NestedDirectives/u.test(resolverSource))
    {
        violations.push(`${resolverFile}: recursive or nested dependency expansion is forbidden in the projection provider stage`);
    }
    for (const [relative, name] of [
        [graphPlannerFile, "ArticleEmbedDependencyGraphPlanner"],
        [graphVerifierFile, "ArticleEmbedDependencyGraphVerifier"]
    ])
    {
        const matches = declarations(sources, new RegExp(`\\bclass\\s+([A-Za-z0-9_]*${name}[A-Za-z0-9_]*)\\b`, "gu"));
        if (matches.length !== 1 || matches[0] !== `${relative}:${name}`)
        {
            violations.push(`expected exact-one dependency graph stage ${relative}:${name}`);
        }
    }
    const graphVerifierSource = withoutCSharpComments(sources.get(graphVerifierFile));
    for (const token of ["ArticleEmbedAuthoringContractValidator.Validate", "ArticleEmbedTargetCodec.TryDecode", "VerifyChildren", "path.Contains", "root_cycle_without_host_ancestor", "root_depth_failure_unjustified"])
    {
        if (!graphVerifierSource.includes(token))
        {
            violations.push(`${graphVerifierFile}: independent complete-graph verification missing ${token}`);
        }
    }
    if (graphVerifierSource.includes("ArticleEmbedDependencyGraphPlanner.Expand") || graphVerifierSource.includes("ArticleEmbedAuthoringResolver.Resolve"))
    {
        violations.push(`${graphVerifierFile}: graph verifier must not call the production stages it verifies`);
    }

    const validatorSource = withoutCSharpComments(sources.get(validatorFile));
    if (
        !validatorSource.includes(
            "ArticleEmbedAuthoringDigest.ComputeSnapshot"
        ) ||
        !validatorSource.includes("SnapshotDigest") ||
        !validatorSource.includes("FixedTimeEquals")
    )
    {
        violations.push(
            `${validatorFile}: snapshot and resolution digests must be recomputed and compared in fixed time`
        );
    }

    const verifierSource = withoutCSharpComments(sources.get(verifierFile));
    for (const expectation of [
        "ArticleEmbedAuthoringContractValidator.Validate",
        "ArticleEmbedTargetCodec.TryDecode",
        "ArticleEmbedContractDigest"
    ])
    {
        if (!verifierSource.includes(expectation))
        {
            violations.push(
                `${verifierFile}: independent verification must re-validate contracts, re-decode targets and recompute digests; missing ${expectation}`
            );
        }
    }

    const contractsSource = sources.get(contractsFile);
    const receiptParameters = recordParameters(
        contractsSource,
        "ArticleEmbedAuthoringReceiptItem"
    );
    if (
        receiptParameters === null ||
        /DisplayText|Projection|Content|Markdown/u.test(receiptParameters)
    )
    {
        violations.push(
            `${contractsFile}: receipt items must record identities, statuses and digests only, never target content`
        );
    }
    const intentParameters = recordParameters(
        contractsSource,
        "ArticleEmbedOpenSourceIntent"
    );
    if (
        intentParameters === null ||
        /DisplayText|Projection|Content|Markdown|Mutation/u.test(
            intentParameters
        )
    )
    {
        violations.push(
            `${contractsFile}: the open-source intent must carry only the stable target coordinate, never content or mutation`
        );
    }
    const cacheKeyParameters = recordParameters(
        contractsSource,
        "ArticleEmbedAuthoringCacheKey"
    );
    if (cacheKeyParameters === null)
    {
        violations.push(
            `${contractsFile}: the authoring cache key contract is required`
        );
    }
    else
    {
        for (const dimension of [
            "HostDocumentId",
            "HostDocumentEpoch",
            "HostSourceRevision",
            "PortableArticleIdentity",
            "ResolvedRevision",
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
                    `${contractsFile}: the authoring cache key must bind ${dimension}`
                );
            }
        }
    }
    return violations;
}

export function checkArticleEmbedAuthoring(root = repositoryRoot)
{
    return checkArticleEmbedAuthoringSources(
        readArticleEmbedAuthoringSources(root)
    );
}

function main()
{
    const violations = checkArticleEmbedAuthoring();
    if (violations.length > 0)
    {
        process.stderr.write(
            `[article-embed-authoring] failed\n${violations.map((item) => `- ${item}`).join("\n")}\n`
        );
        process.exitCode = 1;
        return;
    }
    process.stdout.write("[article-embed-authoring] ok\n");
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
{
    main();
}
