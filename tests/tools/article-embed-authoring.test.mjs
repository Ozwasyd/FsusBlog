import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const {
    checkArticleEmbedAuthoring,
    checkArticleEmbedAuthoringSources,
    readArticleEmbedAuthoringSources
} = await import(
    pathToFileURL(
        path.join(root, "tools/governance/check-article-embed-authoring.mjs")
    ).href
);

const contractsPath =
    "src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringContracts.cs";
const resolverPath =
    "src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringResolver.cs";
const graphPlannerPath = "src/shared/Contracts/ArticleEmbeds/Graph/ArticleEmbedDependencyGraphPlanner.cs";
const graphVerifierPath = "src/shared/Contracts/ArticleEmbeds/Graph/ArticleEmbedDependencyGraphVerifier.cs";
const verifierPath =
    "src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringVerifier.cs";

function sources()
{
    return new Map(readArticleEmbedAuthoringSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkArticleEmbedAuthoringSources(fixture).join("\n");
}

test("repository has one closed authoring resolver, verifier, snapshot, resolution and receipt", () =>
{
    assert.deepEqual(checkArticleEmbedAuthoring(), []);
});

test("second authoring resolver, verifier or authority record fails closed", () =>
{
    const mutations = [
        [
            "src/backend/OtherArticleEmbedAuthoringResolver.cs",
            "public class OtherArticleEmbedAuthoringResolver {}",
            /exact-one authoring resolver/u
        ],
        [
            "src/backend/OtherArticleEmbedAuthoringVerifier.cs",
            "public class OtherArticleEmbedAuthoringVerifier {}",
            /exact-one authoring verifier/u
        ],
        [
            "src/backend/OtherArticleEmbedAuthoritySnapshot.cs",
            "public record OtherArticleEmbedAuthoritySnapshot();",
            /exact-one authority snapshot/u
        ],
        [
            "src/backend/OtherArticleEmbedAuthoringResolution.cs",
            "public record ArticleEmbedAuthoringResolution();",
            /exact-one authoring resolution/u
        ],
        [
            "src/backend/OtherArticleEmbedAuthoringReceipt.cs",
            "public record ArticleEmbedAuthoringReceipt();",
            /exact-one authoring receipt/u
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

test("regex, rendered payloads, latest reuse, title resolution and persistent caches fail closed", () =>
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
            " var target = GetLatestRevision(identity);",
            /latest or publication-plan target reuse/u
        ],
        [
            " var scope = ArticleEmbedRequestedScope.PublicationPlan;",
            /latest or publication-plan target reuse/u
        ],
        [
            " var key = facts.Title;",
            /title, slug, route or URL based resolution/u
        ],
        [
            " var key = facts.Slug;",
            /title, slug, route or URL based resolution/u
        ],
        [
            " static readonly Dictionary<string, int> s_cache = new();",
            /persistent or cross-user cache/u
        ],
        [" var cache = new MemoryCache();", /persistent or cross-user cache/u]
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    resolverPath,
                    `${fixture.get(resolverPath)}\n${injected}\n`
                )
            ),
            expected
        );
    }
});

test("missing cycle, budget, scope, staleness or binding guards fail closed", () =>
{
    const guards = [
        ["path.Contains", /cycle detection on the expansion path/u],
        ["IsCancellationRequested", /stale cancellation observation/u],
        [
            "RequestedScope != ArticleEmbedRequestedScope.Authoring",
            /authoring scope enforcement/u
        ],
        ["MaxDepth", /closed depth budget/u],
        ["snapshot.HostSourceDigest", /host source binding/u]
    ];
    for (const [removed, expected] of guards)
    {
        const targetPath = removed === "path.Contains" || removed === "MaxDepth" ? graphPlannerPath : resolverPath;
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    targetPath,
                    fixture
                        .get(targetPath)
                        .replaceAll(removed, "removed_guard")
                )
            ),
            expected
        );
    }
});

test("receipt and open-source intent cannot smuggle target content", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "string ResultDigest);",
                        "string ResultDigest, string DisplayText);"
                    )
            )
        ),
        /receipt items must record identities, statuses and digests only/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "long ResolvedRevision);",
                        "long ResolvedRevision, string Markdown);"
                    )
            )
        ),
        /open-source intent must carry only the stable target coordinate/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "string? MaterialLocale,\n    string? MaterialTheme);",
                        "string? MaterialLocale);"
                    )
            )
        ),
        /cache key must bind MaterialTheme/u
    );
});

test("verifier must re-validate, re-decode and recompute independently", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                verifierPath,
                fixture
                    .get(verifierPath)
                    .replaceAll(
                        "ArticleEmbedTargetCodec.TryDecode",
                        "ArticleEmbedAuthoringContractValidator.Validate"
                    )
            )
        ),
        /re-validate contracts, re-decode targets and recompute digests/u
    );
});

test("projection cannot regain nested expansion and graph cannot skip source re-verification", () =>
{
    for (const injected of [" ResolveNode(context);", " var children = facts.NestedDirectives;", " ResolveNested(context);"])
    {
        assert.match(diagnostics((fixture) => fixture.set(resolverPath, `${fixture.get(resolverPath)}\n${injected}`)), /dependency expansion is forbidden/u);
    }
    for (const removed of ["ArticleEmbedAuthoringVerifier.Verify", "ArticleEmbedAuthoringResolver.ProjectCurrent"])
    {
        assert.match(diagnostics((fixture) => fixture.set(graphPlannerPath, fixture.get(graphPlannerPath).replaceAll(removed, "removed_stage_guard"))), /missing/u);
    }
    assert.match(diagnostics((fixture) => fixture.set(graphVerifierPath, `${fixture.get(graphVerifierPath)}\nArticleEmbedDependencyGraphPlanner.Expand();`)), /must not call the production stages/u);
    assert.match(diagnostics((fixture) => fixture.set("src/backend/DuplicateGraph.cs", "public class OtherArticleEmbedDependencyGraphPlanner {}")), /exact-one dependency graph stage/u);
});

test("graph root path failures require an independently observed cause", () =>
{
    for (const token of ["root_cycle_without_host_ancestor", "root_depth_failure_unjustified"])
    {
        assert.match(diagnostics((fixture) => fixture.set(graphVerifierPath, fixture.get(graphVerifierPath).replaceAll(token, "removed_path_proof"))), /complete-graph verification missing/u);
    }
});
