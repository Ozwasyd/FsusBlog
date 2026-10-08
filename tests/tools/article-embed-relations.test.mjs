import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const {
    checkArticleEmbedRelations,
    checkArticleEmbedRelationSources,
    readArticleEmbedRelationSources
} = await import(
    pathToFileURL(
        path.join(root, "tools/governance/check-article-embed-relations.mjs")
    ).href
);

const contractsPath =
    "src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationContracts.cs";
const deriverPath =
    "src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationDeriver.cs";
const verifierPath =
    "src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationVerifier.cs";
const validatorPath =
    "src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationContractValidator.cs";

function sources()
{
    return new Map(readArticleEmbedRelationSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkArticleEmbedRelationSources(fixture).join("\n");
}

test("repository has one closed relation deriver, verifier, edge, set and receipts", () =>
{
    assert.deepEqual(checkArticleEmbedRelations(), []);
});

test("second relation deriver, verifier or contract record fails closed", () =>
{
    const mutations = [
        [
            "src/backend/OtherArticleEmbedRelationIndex.cs",
            "public class OtherArticleEmbedRelationIndex {}",
            /exact-one relation deriver/u
        ],
        [
            "src/backend/OtherArticleEmbedRelationVerifier.cs",
            "public class OtherArticleEmbedRelationVerifier {}",
            /exact-one relation verifier/u
        ],
        [
            "src/backend/OtherArticleEmbedRelationEdge.cs",
            "public record ArticleEmbedRelationEdge();",
            /exact-one relation edge/u
        ],
        [
            "src/backend/OtherArticleEmbedRelationEdgeSet.cs",
            "public record ArticleEmbedRelationEdgeSet();",
            /exact-one relation edge set/u
        ],
        [
            "src/backend/OtherArticleEmbedDependencyReceipt.cs",
            "public record ArticleEmbedDependencyReceipt();",
            /exact-one dependency receipt/u
        ],
        [
            "src/backend/OtherArticleEmbedRelationQueryReceipt.cs",
            "public record ArticleEmbedRelationQueryReceipt();",
            /exact-one relation query receipt/u
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

test("regex, rendered payloads, pipeline reuse, title resolution and second stores fail closed", () =>
{
    const mutations = [
        [" var hit = Regex.Match(token, pattern);", /regular-expression target or source parsing/u],
        [" var html = new HtmlDocument();", /rendered HTML, DOM, component or iframe payload/u],
        [
            " var resolved = ArticleEmbedAuthoringResolver.Resolve(x, y, z);",
            /authoring resolver or publication planner reuse/u
        ],
        [
            " var plan = ArticleEmbedPublicationPlanner.Plan(x, y, z);",
            /authoring resolver or publication planner reuse/u
        ],
        [
            " var target = GetLatestRevision(identity);",
            /latest-target or previous-result reuse/u
        ],
        [" var key = facts.Title;", /title, slug, route or URL based resolution/u],
        [
            " static readonly Dictionary<string, int> s_edges = new();",
            /persistent, cross-user or second cache or store/u
        ],
        [" var cache = new MemoryCache();", /persistent, cross-user or second cache or store/u],
        [" context.SaveChanges();", /business writes or transport inside the contract boundary/u]
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(deriverPath, `${fixture.get(deriverPath)}\n${injected}\n`)
            ),
            expected
        );
    }
});

test("missing source verification, scope or transition guards fail closed", () =>
{
    const guards = [
        ["ArticleEmbedDependencyGraphVerifier.Verify", /authoring source re-verification/u],
        ["ArticleEmbedPublicationVerifier.Verify", /publication source re-verification/u],
        ["ArticleEmbedPublicationPlanStatus.Sealed", /sealed-plan requirement/u],
        ["article_embed_relation_plan_blocked", /blocked-plan rejection/u],
        ["article_embed_relation_source_unverified", /unverified-source rejection/u],
        ["article_embed_relation_scope_frozen_immutable", /frozen-scope reconcile rejection/u],
        ["previousGeneration + 1", /monotone reconcile generation/u],
        [
            "set.HostSourceRevision != snapshot.HostSourceRevision",
            /host binding drift check/u
        ],
        ["set.Actor != snapshot.Actor", /derivation context drift check/u],
        ["actor != edgeSet.Actor", /actor-bound query enforcement/u],
        ["ArticleEmbedEdgeScope.FrozenPublication", /frozen-only public query/u],
        ["ArticleEmbedInvalidationReason.TargetUpdated", /target-update transition/u],
        ["ArticleEmbedInvalidationReason.TargetNonPublic", /non-public transition/u],
        ["ArticleEmbedInvalidationReason.TargetRemoved", /removed-target transition/u],
        ["ArticleEmbedRelationDigest.ComputeCacheKey", /bounded cache key digest/u]
    ];
    for (const [removed, expected] of guards)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    deriverPath,
                    fixture.get(deriverPath).replaceAll(removed, "removed_guard")
                )
            ),
            expected
        );
    }
});

test("edge sealing, digest recomputation and fixed-time comparison are mandatory", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                validatorPath,
                fixture.get(validatorPath).replaceAll("FixedTimeEquals", "SequenceEqual")
            )
        ),
        /relation sealing and validation incomplete/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                validatorPath,
                fixture
                    .get(validatorPath)
                    .replaceAll("ComputeEdgeIdentity", "ComputeEdge")
            )
        ),
        /relation sealing and validation incomplete/u
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
                        "ArticleEmbedEdgeStatus Status,\n    string DependencyDigest,\n    string EdgeDigest);",
                        "ArticleEmbedEdgeStatus Status,\n    string DependencyDigest,\n    string EdgeDigest, string DisplayText);"
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
                        "IReadOnlyList<ArticleEmbedRelationQueryItem> Items,",
                        "string Markdown,\n    IReadOnlyList<ArticleEmbedRelationQueryItem> Items,"
                    )
            )
        ),
        /must record identities, statuses and digests only/u
    );
});

test("edge, set, ticket, key and delivery policy bindings are mandatory", () =>
{
    const mutations = [
        ["long ResolvedRevision,\n    long LatestObservedRevision,", /edge must bind LatestObservedRevision/u],
        ["ArticleEmbedActorContext Actor,\n    ArticleEmbedRuntimeContext Runtime,", /edge set must bind Actor/u],
        ["long ReconcileGeneration,\n    string TicketDigest);", /invalidation ticket must bind ReconcileGeneration/u],
        ["string? MaterialLocale,\n    string? MaterialTheme);", /relation cache key must bind MaterialLocale/u],
        ['"frozen-edge-artifact-only"', /frozen-only public delivery policy constant is required/u]
    ];
    const replacements = [
        ["long ResolvedRevision,\n    long LatestObservedRevision,", "long ResolvedRevision,"],
        ["ArticleEmbedActorContext Actor,\n    ArticleEmbedRuntimeContext Runtime,", ""],
        ["long ReconcileGeneration,\n    string TicketDigest);", "string TicketDigest);"],
        ["string? MaterialLocale,\n    string? MaterialTheme);", "string? MaterialTheme);"],
        ['"frozen-edge-artifact-only"', '"other-policy"']
    ];
    for (let index = 0; index < mutations.length; index++)
    {
        const [find, expected] = mutations[index];
        const [search, replacement] = [replacements[index][0], replacements[index][1]];
        assert.equal(find, search);
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    contractsPath,
                    fixture.get(contractsPath).replace(search, replacement)
                )
            ),
            expected
        );
    }
});

test("verifier must not call the deriver entry points and must recompute digests", () =>
{
    for (const call of [
        "ArticleEmbedRelationDeriver.DeriveFromAuthoring(null, null, null, null);",
        "ArticleEmbedRelationDeriver.Reconcile(null, null, 0);",
        "ArticleEmbedRelationDeriver.Query(null, 0, null, null);"
    ])
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(verifierPath, `${fixture.get(verifierPath)}\n${call}\n`)
            ),
            /must not call the deriver entry points it verifies/u
        );
    }
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                verifierPath,
                fixture
                    .get(verifierPath)
                    .replaceAll("ArticleEmbedDependencyGraphVerifier.Verify", "TrueMethod")
            )
        ),
        /re-verify sources, re-derive edges and recompute digests/u
    );
});
