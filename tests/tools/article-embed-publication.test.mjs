import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const {
    checkArticleEmbedPublication,
    checkArticleEmbedPublicationSources,
    readArticleEmbedPublicationSources
} = await import(
    pathToFileURL(
        path.join(root, "tools/governance/check-article-embed-publication.mjs")
    ).href
);

const contractsPath =
    "src/shared/Contracts/ArticleEmbeds/Publication/ArticleEmbedPublicationContracts.cs";
const plannerPath =
    "src/shared/Contracts/ArticleEmbeds/Publication/ArticleEmbedPublicationPlanner.cs";
const verifierPath =
    "src/shared/Contracts/ArticleEmbeds/Publication/ArticleEmbedPublicationVerifier.cs";
const validatorPath =
    "src/shared/Contracts/ArticleEmbeds/Publication/ArticleEmbedPublicationContractValidator.cs";

function sources()
{
    return new Map(readArticleEmbedPublicationSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkArticleEmbedPublicationSources(fixture).join("\n");
}

test("repository has one closed publication planner, verifier, authority, plan and receipt", () =>
{
    assert.deepEqual(checkArticleEmbedPublication(), []);
});

test("second publication planner, verifier or contract record fails closed", () =>
{
    const mutations = [
        [
            "src/backend/OtherArticleEmbedPublicationPlanner.cs",
            "public class OtherArticleEmbedPublicationPlanner {}",
            /exact-one publication planner/u
        ],
        [
            "src/backend/OtherArticleEmbedPublicationVerifier.cs",
            "public class OtherArticleEmbedPublicationVerifier {}",
            /exact-one publication verifier/u
        ],
        [
            "src/backend/OtherArticleEmbedPublicationAuthority.cs",
            "public record OtherArticleEmbedPublicationAuthority();",
            /exact-one publication authority/u
        ],
        [
            "src/backend/OtherArticleEmbedPublicationPlan.cs",
            "public record ArticleEmbedPublicationPlan();",
            /exact-one publication plan/u
        ],
        [
            "src/backend/OtherArticleEmbedPublicationReceipt.cs",
            "public record ArticleEmbedPublicationReceipt();",
            /exact-one publication receipt/u
        ]
    ];
    for (const [relative, source, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) => fixture.set(relative, source)),
            expected
        );
    }
});

test("regex, rendered payloads, authoring reuse, title resolution and caches fail closed", () =>
{
    const mutations = [
        [
            " var hit = Regex.Match(token, pattern);",
            /regular-expression target or source parsing/u
        ],
        [
            " var html = new HtmlDocument();",
            /rendered HTML, DOM, component or iframe payload/u
        ],
        [
            " var resolved = ArticleEmbedAuthoringResolver.Resolve(x, y, z);",
            /authoring cache, latest-target or previous-result reuse/u
        ],
        [
            " var target = GetLatestRevision(identity);",
            /authoring cache, latest-target or previous-result reuse/u
        ],
        [
            " var key = facts.Title;",
            /title, slug, route or URL based resolution/u
        ],
        [
            " static readonly Dictionary<string, int> s_cache = new();",
            /persistent or cross-user cache/u
        ],
        [" var cache = new MemoryCache();", /persistent or cross-user cache/u],
        [
            " context.SaveChanges();",
            /business writes or transport inside the contract boundary/u
        ]
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    plannerPath,
                    `${fixture.get(plannerPath)}\n${injected}\n`
                )
            ),
            expected
        );
    }
});

test("missing cycle, budget, scope, public-only or retention guards fail closed", () =>
{
    const guards = [
        ["path.Contains", /cycle detection on the expansion path/u],
        ["IsCancellationRequested", /stale cancellation observation/u],
        [
            "RequestedScope != ArticleEmbedRequestedScope.PublicationPlan",
            /publication scope enforcement/u
        ],
        ["MaxDepth", /closed depth budget/u],
        ["authority.HostSourceDigest", /host source binding/u],
        ["FrozenArtifactRetention", /frozen artifact retention gate/u],
        [
            "ArticleEmbedVisibilityStatus.Private",
            /private visibility rejection/u
        ],
        ["RevisionPackageComplete", /revision package completeness/u]
    ];
    for (const [removed, expected] of guards)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    plannerPath,
                    fixture
                        .get(plannerPath)
                        .replaceAll(removed, "removed_guard")
                )
            ),
            expected
        );
    }
});

test("commit gate and digest recomputation are mandatory", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                validatorPath,
                fixture
                    .get(validatorPath)
                    .replaceAll("ValidateForCommit", "SealCheck")
            )
        ),
        /publication sealing and commit gating incomplete/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                validatorPath,
                fixture
                    .get(validatorPath)
                    .replaceAll("FixedTimeEquals", "SequenceEqual")
            )
        ),
        /publication sealing and commit gating incomplete/u
    );
});

test("receipt records cannot smuggle target content", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "int BlockedDescendantCount,\n    string EdgeDigest);",
                        "int BlockedDescendantCount,\n    string EdgeDigest, string DisplayText);"
                    )
            )
        ),
        /must record identities, statuses and digests only/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "IReadOnlyList<ArticleEmbedPublicationReceiptItem> Items,",
                        "string Markdown,\n    IReadOnlyList<ArticleEmbedPublicationReceiptItem> Items,"
                    )
            )
        ),
        /must record identities, statuses and digests only/u
    );
});

test("authority, edge and delivery policy must bind frozen coordinates", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace("bool FrozenArtifactRetention,\n    ", "")
            )
        ),
        /authority must bind FrozenArtifactRetention/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace("long OwnerRevision,\n    ", "")
            )
        ),
        /edge must bind OwnerRevision/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace('"publication-frozen-artifact"', '"other-policy"')
            )
        ),
        /frozen-artifact delivery policy constant is required/u
    );
});

test("verifier must not call the planner and must recompute digests", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                verifierPath,
                `${fixture.get(verifierPath)}\nArticleEmbedPublicationPlanner.Plan(null, null, null);\n`
            )
        ),
        /must not call the planner it verifies/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                verifierPath,
                fixture
                    .get(verifierPath)
                    .replaceAll(
                        "ArticleEmbedTargetCodec.TryDecode",
                        "ArticleEmbedPublicationContractValidator.Validate"
                    )
            )
        ),
        /re-validate contracts, re-decode targets and recompute digests/u
    );
});
