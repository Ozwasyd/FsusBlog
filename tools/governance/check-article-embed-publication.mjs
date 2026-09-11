#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const publicationDirectory = "src/shared/Contracts/ArticleEmbeds/Publication";
const contractsFile = `${publicationDirectory}/ArticleEmbedPublicationContracts.cs`;
const validatorFile = `${publicationDirectory}/ArticleEmbedPublicationContractValidator.cs`;
const plannerFile = `${publicationDirectory}/ArticleEmbedPublicationPlanner.cs`;
const verifierFile = `${publicationDirectory}/ArticleEmbedPublicationVerifier.cs`;
const digestFile = `${publicationDirectory}/ArticleEmbedPublicationDigest.cs`;
const requiredFiles = [
    contractsFile,
    validatorFile,
    plannerFile,
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

export function readArticleEmbedPublicationSources(root = repositoryRoot)
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

export function checkArticleEmbedPublicationSources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(
                `required article embed publication authority file missing: ${relative}`
            );
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const planners = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbed[A-Za-z0-9_]*(?:PublicationPlanner|PublicationFinalizer|PublicationResolver)[A-Za-z0-9_]*)\b/gu
    );
    const verifiers = declarations(
        sources,
        /\bclass\s+([A-Za-z0-9_]*ArticleEmbedPublication[A-Za-z0-9_]*Verifier[A-Za-z0-9_]*)\b/gu
    );
    const authorities = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedPublicationAuthority)\b/gu
    );
    const plans = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedPublicationPlan)\b/gu
    );
    const receipts = declarations(
        sources,
        /\brecord\s+([A-Za-z0-9_]*ArticleEmbedPublicationReceipt)\b/gu
    );
    const expectedPlanner = `${plannerFile}:ArticleEmbedPublicationPlanner`;
    const expectedVerifier = `${verifierFile}:ArticleEmbedPublicationVerifier`;
    const expectedAuthority = `${contractsFile}:ArticleEmbedPublicationAuthority`;
    const expectedPlan = `${contractsFile}:ArticleEmbedPublicationPlan`;
    const expectedReceipt = `${contractsFile}:ArticleEmbedPublicationReceipt`;
    if (planners.length !== 1 || planners[0] !== expectedPlanner)
    {
        violations.push(
            `expected exact-one publication planner ${expectedPlanner}; found ${planners.join(", ") || "<none>"}`
        );
    }
    if (verifiers.length !== 1 || verifiers[0] !== expectedVerifier)
    {
        violations.push(
            `expected exact-one publication verifier ${expectedVerifier}; found ${verifiers.join(", ") || "<none>"}`
        );
    }
    if (authorities.length !== 1 || authorities[0] !== expectedAuthority)
    {
        violations.push(
            `expected exact-one publication authority ${expectedAuthority}; found ${authorities.join(", ") || "<none>"}`
        );
    }
    if (plans.length !== 1 || plans[0] !== expectedPlan)
    {
        violations.push(
            `expected exact-one publication plan ${expectedPlan}; found ${plans.join(", ") || "<none>"}`
        );
    }
    if (receipts.length !== 1 || receipts[0] !== expectedReceipt)
    {
        violations.push(
            `expected exact-one publication receipt ${expectedReceipt}; found ${receipts.join(", ") || "<none>"}`
        );
    }

    const publicationSource = requiredFiles
        .map((relative) => withoutCSharpComments(sources.get(relative)))
        .join("\n");
    const forbiddenPublication = [
        [
            "regular-expression target or source parsing",
            /\b(?:Regex|GeneratedRegex|matchAll)\b|\.(?:match|exec)\s*\(/u
        ],
        [
            "rendered HTML, DOM, component or iframe payload",
            /\b[A-Za-z0-9_]*(?:Html|HTML|Dom|DOM|IFrame|WebView|VueComponent|innerHTML|outerHTML|querySelector|RenderedMarkdown)[A-Za-z0-9_]*\b/u
        ],
        [
            "authoring cache, latest-target or previous-result reuse",
            /\b(?:ArticleEmbedAuthoringResolver|ArticleEmbedAuthoringVerifier|CacheHit|GetLatest|LatestTarget|MostRecent|PreviousResult|AuthoringCache)[A-Za-z0-9_]*\b/u
        ],
        [
            "title, slug, route or URL based resolution",
            /\b[A-Za-z0-9_]*(?:Title|Slug|Route)[A-Za-z0-9_]*\b|\bUrl\b/u
        ],
        [
            "persistent or cross-user cache",
            /\b(?:IMemoryCache|IDistributedCache|MemoryCache|ConcurrentDictionary)\b|\bstatic\s+(?:readonly\s+)?(?:Dictionary|HashSet)\s*</u
        ],
        [
            "business writes or transport inside the contract boundary",
            /\b(?:DbContext|SaveChanges|HttpClient|IHttpContext|RouteValueDictionary)\b/u
        ]
    ];
    for (const [label, expression] of forbiddenPublication)
    {
        if (expression.test(publicationSource))
        {
            violations.push(
                `${publicationDirectory}: ${label} is forbidden in the article embed publication slice`
            );
        }
    }

    const plannerSource = withoutCSharpComments(sources.get(plannerFile));
    for (const guard of [
        ["closed depth budget", "MaxDepth"],
        ["closed expanded-node budget", "MaxExpandedNodes"],
        ["closed source-byte budget", "MaxSourceBytes"],
        ["closed elapsed-time budget", "MaxElapsedMilliseconds"],
        ["closed authority-message budget", "MaxAuthorityMessages"],
        ["cycle detection on the expansion path", "path.Contains"],
        ["stale cancellation observation", "IsCancellationRequested"],
        [
            "publication scope enforcement",
            "RequestedScope != ArticleEmbedRequestedScope.PublicationPlan"
        ],
        ["host source binding", "authority.HostSourceDigest"],
        ["permission context binding", "authority.Actor"],
        ["provider runtime binding", "authority.Runtime"],
        ["authority generation binding", "AuthorityGeneration"],
        ["frozen artifact retention gate", "FrozenArtifactRetention"],
        ["private visibility rejection", "ArticleEmbedVisibilityStatus.Private"],
        ["permission denial rejection", "ArticleEmbedPermissionStatus.Denied"],
        ["revision package completeness", "RevisionPackageComplete"],
        ["dependency coordinate sealing", "ArticleEmbedContractValidator.Seal"]
    ])
    {
        if (!plannerSource.includes(guard[1]))
        {
            violations.push(`${plannerFile}: missing ${guard[0]}`);
        }
    }

    const validatorSource = withoutCSharpComments(sources.get(validatorFile));
    for (const expectation of [
        "ArticleEmbedPublicationDigest.ComputeAuthority",
        "ArticleEmbedPublicationDigest.ComputeEdge",
        "ArticleEmbedPublicationDigest.ComputeReceipt",
        "ArticleEmbedPublicationDigest.ComputePlan",
        "FixedTimeEquals",
        "ValidateForCommit",
        "article_embed_publication_plan_stale"
    ])
    {
        if (!validatorSource.includes(expectation))
        {
            violations.push(
                `${validatorFile}: publication sealing and commit gating incomplete; missing ${expectation}`
            );
        }
    }

    const verifierSource = withoutCSharpComments(sources.get(verifierFile));
    if (verifierSource.includes("ArticleEmbedPublicationPlanner."))
    {
        violations.push(
            `${verifierFile}: the verifier must not call the planner it verifies`
        );
    }
    for (const expectation of [
        "ArticleEmbedPublicationContractValidator.Validate",
        "ArticleEmbedTargetCodec.TryDecode",
        "ArticleEmbedPublicationDigest.ComputeGraph",
        "ArticleEmbedPublicationDigest.ComputeReceipt",
        "ArticleEmbedPublicationDigest.ComputePlan"
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
    if (!contractsSource.includes("\"publication-frozen-artifact\""))
    {
        violations.push(
            `${contractsFile}: the frozen-artifact delivery policy constant is required`
        );
    }
    const authorityParameters = recordParameters(
        contractsSource,
        "ArticleEmbedPublicationAuthority"
    );
    if (authorityParameters === null)
    {
        violations.push(
            `${contractsFile}: the publication authority record is required`
        );
    }
    else
    {
        for (const dimension of [
            "HostPortableArticleIdentity",
            "HostCurrentRevision",
            "HostSourceDigest",
            "PublicationRequestId",
            "ExpectedRevision",
            "AuthorityGeneration",
            "FrozenArtifactRetention",
            "Targets",
            "AuthorityDigest"
        ])
        {
            if (!authorityParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the publication authority must bind ${dimension}`
                );
            }
        }
    }
    const edgeParameters = recordParameters(
        contractsSource,
        "ArticleEmbedPublicationEdge"
    );
    if (edgeParameters === null)
    {
        violations.push(
            `${contractsFile}: the publication edge record is required`
        );
    }
    else
    {
        for (const dimension of [
            "OwnerPortableArticleIdentity",
            "OwnerRevision",
            "Coordinate",
            "Depth",
            "LatestObservedRevision",
            "EdgeDigest"
        ])
        {
            if (!edgeParameters.includes(dimension))
            {
                violations.push(
                    `${contractsFile}: the publication edge must bind ${dimension}`
                );
            }
        }
    }
    for (const recordName of [
        "ArticleEmbedPublicationReceipt",
        "ArticleEmbedPublicationReceiptItem"
    ])
    {
        const parameters = recordParameters(contractsSource, recordName);
        if (
            parameters === null ||
            /DisplayText|Projection|Content|Markdown/u.test(parameters)
        )
        {
            violations.push(
                `${contractsFile}: ${recordName} must record identities, statuses and digests only, never target content`
            );
        }
    }
    return violations;
}

export function checkArticleEmbedPublication(root = repositoryRoot)
{
    return checkArticleEmbedPublicationSources(
        readArticleEmbedPublicationSources(root)
    );
}

function main()
{
    const violations = checkArticleEmbedPublication();
    if (violations.length > 0)
    {
        process.stderr.write(
            `[article-embed-publication] failed\n${violations.map((item) => `- ${item}`).join("\n")}\n`
        );
        process.exitCode = 1;
        return;
    }
    process.stdout.write("[article-embed-publication] ok\n");
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
{
    main();
}
