using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only content, clocks, authority digests and IDs exercise the
/// original resolved-input and identity contracts. No artifact admission, native
/// allocation, database provenance or production-equivalence receipt is asserted.
/// A diagnostic graph is used solely to obtain the original native role roster;
/// every graph passed to the adapter has both explicit inputs and explicit IDs.
/// </summary>
public sealed class CommentScaleResolvedArticleAdapterTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void BindResolved_UsesWholePlanShuffledAssignmentsAndExplicitPayloadAndNativeIds(ArticleScaleVariant variant)
    {
        Fixture f = Create(variant);
        CommentScaleGraphFactBindings result = Bind(f);

        Assert.Equal(100, f.CoverageCount);
        Assert.Equal(variant, f.Graph.Variant);
        Assert.Equal(900007, result.ArticleId);
        Assert.NotEqual(f.Input.ArticleOrdinal, result.ArticleId);
        Assert.Equal(f.Graph.SemanticArticleId, result.ArticleSemanticRole);
        Assert.Equal(f.Article.ContentDigest, result.ArticlePlanDigest);
        Assert.Equal(f.Plan.ContentDigest, result.CommentPlanDigest);
        Assert.Empty(result.Comments);
        ArticleScaleRowPlan body = Assert.Single(f.Graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleBody));
        Assert.Equal(f.Input.MarkdownContent, body.Fields["MarkdownContent"]);
        Assert.Equal(f.Input.TemporalRoles[ArticleScaleTemporalRoles.ArticleCreated].ToString("O"), body.Fields["UpdatedAt"]);
        ArticleScaleRowPlan article = Assert.Single(f.Graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.Article));
        Assert.Equal(f.Input.Title, article.Fields["Title"]);
        Assert.True(CanonicalArticleGraphVerifier.VerifyArticleGraph(f.Article, f.Graph).IsValid);
    }

    [Theory]
    [InlineData("missing-slot")]
    [InlineData("duplicate-slot")]
    [InlineData("variant-count")]
    [InlineData("input-digest")]
    public void OriginalCompleteCoverageRefusesIncompleteOrCrossedAssignments(string change)
    {
        Fixture f = Create();
        var assignments = f.Inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal,
            input.Variant, ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToList();
        switch (change)
        {
            case "missing-slot":
                assignments.RemoveAt(assignments.Count - 1);
                break;
            case "duplicate-slot":
                assignments[^1] = assignments[0];
                break;
            case "variant-count":
                assignments[0] = assignments[0] with
                {
                    Variant = ArticleScaleVariant.Published
                };
                break;
            case "input-digest":
                assignments[0] = assignments[0] with
                {
                    InputDigest = "invalid"
                };
                break;
        }
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleAssignmentCoverage(f.Article, "synthetic-unit-only", assignments));
    }

    [Theory]
    [InlineData("title")]
    [InlineData("content")]
    [InlineData("temporal")]
    [InlineData("authority")]
    [InlineData("variant")]
    public void OriginalBatchRefusesInputsChangedAfterIndependentAssignmentDigest(string change)
    {
        Fixture f = Create();
        ArticleScaleResolvedInput changed = change switch
        {
            "title" => f.Input with { Title = "different unit title" },
            "content" => f.Input with { MarkdownContent = "different unit markdown" },
            "temporal" => f.Input with { TemporalRoles = Times().ToDictionary(pair => pair.Key, pair => pair.Value.AddSeconds(1)) },
            "authority" => f.Input with { HotnessAuthorityReference = "different-unit-authority" },
            "variant" => f.Input with { Variant = ArticleScaleVariant.Scheduled },
            _ => throw new InvalidOperationException(change)
        };
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleResolvedGraphBatch(f.Article, f.Coverage, [changed]));
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("over-bound")]
    [InlineData("duplicate")]
    public void OriginalBatchEnforcesItsActualBoundAndUniqueOrdinals(string change)
    {
        Fixture f = Create();
        IReadOnlyList<ArticleScaleResolvedInput> inputs = change switch
        {
            "empty" => [],
            "over-bound" => Enumerable.Repeat(f.Input, 1001).ToArray(),
            "duplicate" => [f.Input, f.Input],
            _ => throw new InvalidOperationException(change)
        };
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleResolvedGraphBatch(f.Article, f.Coverage, inputs));
    }

    [Theory]
    [InlineData("missing-input")]
    [InlineData("crossed-plan")]
    [InlineData("crossed-map")]
    [InlineData("missing-native-role")]
    [InlineData("native-reference-schema")]
    [InlineData("native-reference-digest")]
    [InlineData("graph-digest")]
    [InlineData("ordinal")]
    [InlineData("variant")]
    public void BindResolved_RefusesCrossedOriginalBatchGraphMapAndReference(string change)
    {
        Fixture f = Create();
        ArticleScaleResolvedGraphBatch batch = f.Batch;
        ArticleScalePlan article = f.Article;
        ArticleScaleArticleGraph graph = f.Graph;
        ArticleScaleGraphIdentityBindings map = f.Map;
        CommentScaleArtifactReference reference = f.Reference;
        switch (change)
        {
            case "missing-input":
                batch = new(f.Article, f.Coverage, [f.Inputs.First(input => input.ArticleOrdinal != f.Input.ArticleOrdinal)]);
                break;
            case "crossed-plan":
                article = ArticleScalePlanBuilder.Create("scale-s", "crossed-unit", f.Artifacts);
                break;
            case "crossed-map":
                map = new(OtherDigest, f.Map.SemanticArticleId, f.Map.Ids);
                break;
            case "missing-native-role":
                map = new(f.Article.ContentDigest, f.Map.SemanticArticleId,
                f.Map.Ids.Where(pair => pair.Key != f.Map.SemanticArticleId).ToDictionary(pair => pair.Key, pair => pair.Value));
                break;
            case "native-reference-schema":
                reference = reference with
                {
                    Schema = "unowned.v1"
                };
                break;
            case "native-reference-digest":
                reference = reference with
                {
                    ContentDigest = OtherDigest
                };
                break;
            case "graph-digest":
                graph = graph with
                {
                    ArticleDigest = OtherDigest
                };
                break;
            case "ordinal":
                graph = graph with
                {
                    ArticleOrdinal = f.Input.ArticleOrdinal + 1
                };
                break;
            case "variant":
                graph = graph with
                {
                    Variant = ArticleScaleVariant.Scheduled
                };
                break;
        }
        Assert.Throws<InvalidOperationException>(() => CommentScaleArticleBindingAdapter.BindResolved(
            f.Plan, article, f.Artifacts, batch, graph, map, Occurrence(), reference, []));
    }

    [Fact]
    public void BindResolved_RefusesResealedRowTamperWhichChangesTheOriginalExpectedGraph()
    {
        Fixture f = Create();
        ArticleScaleRowPlan[] rows = f.Graph.Rows.Select(row => row.Kind == ArticleScaleRowKind.Article
            ? row with
            {
                Fields = row.Fields.ToDictionary(pair => pair.Key, pair => pair.Key == "Title" ? (object?)"resealed unit tamper" : pair.Value)
            }
            : row).ToArray();
        ArticleScaleArticleGraph changed = f.Graph with
        {
            Rows = rows,
            ArticleDigest = CanonicalArticleGraphFactory.ComputeArticleDigest(f.Graph.SemanticArticleId, f.Graph.Variant,
                rows, f.Graph.Relations, f.Graph.Pointers)
        };
        Assert.NotEqual(f.Graph.ArticleDigest, changed.ArticleDigest);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CommentScaleArticleBindingAdapter.BindResolved(
            f.Plan, f.Article, f.Artifacts, f.Batch, changed, f.Map, Occurrence(), f.Reference, []));
        Assert.Contains("original resolved inputs and native identities", error.Message);
    }

    [Theory]
    [InlineData("missing-obligation")]
    [InlineData("reordered-obligations")]
    [InlineData("crossed-obligation")]
    [InlineData("changed-obligation")]
    [InlineData("null-obligations")]
    public void BindResolved_RefusesUnhashedOriginalEdgeObligationDrift(string change)
    {
        Fixture f = Create();
        Assert.True(f.Graph.EdgeObligations.Count > 1);
        ArticleScaleEdgeObligationPlan[] edges = f.Graph.EdgeObligations.ToArray();
        IReadOnlyList<ArticleScaleEdgeObligationPlan> changed = change switch
        {
            "missing-obligation" => edges.Skip(1).ToArray(),
            "reordered-obligations" => edges.Reverse().ToArray(),
            "crossed-obligation" => [edges[0] with { OutboxSemanticId = "crossed-unit-outbox" }, .. edges.Skip(1)],
            "changed-obligation" => [edges[0] with { EdgeName = "crossed-unit-edge" }, .. edges.Skip(1)],
            "null-obligations" => null!,
            _ => throw new InvalidOperationException(change)
        };
        ArticleScaleArticleGraph graph = f.Graph with
        {
            EdgeObligations = changed
        };
        Assert.Equal(f.Graph.ArticleDigest, graph.ArticleDigest);
        Assert.Throws<InvalidOperationException>(() => Bind(f with { Graph = graph }));
    }

    [Theory]
    [InlineData("numeric-string")]
    [InlineData("added-field")]
    [InlineData("dropped-field")]
    public void BindResolved_UsesFullOriginalStructureBeyondItsStringBasedDigest(string change)
    {
        Fixture f = Create();
        ArticleScaleRowPlan article = f.Graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        var fields = article.Fields.ToDictionary(pair => pair.Key, pair => pair.Value);
        switch (change)
        {
            case "numeric-string":
                fields["Views"] = f.Input.Views.ToString(System.Globalization.CultureInfo.InvariantCulture);
                break;
            case "added-field":
                fields.Add("UnownedUnitField", "unit-only");
                break;
            case "dropped-field":
                fields.Remove("Views");
                break;
        }
        ArticleScaleRowPlan[] rows = f.Graph.Rows.Select(row => row == article ? row with { Fields = fields } : row).ToArray();
        string digest = CanonicalArticleGraphFactory.ComputeArticleDigest(f.Graph.SemanticArticleId,
            f.Graph.Variant, rows, f.Graph.Relations, f.Graph.Pointers);
        if (change == "numeric-string")
        {
            Assert.Equal(f.Graph.ArticleDigest, digest);
        }
        ArticleScaleArticleGraph graph = f.Graph with
        {
            Rows = rows,
            ArticleDigest = digest
        };
        Assert.Throws<InvalidOperationException>(() => Bind(f with { Graph = graph }));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("article")]
    [InlineData("artifacts")]
    [InlineData("batch")]
    [InlineData("graph")]
    [InlineData("map")]
    [InlineData("occurrence")]
    [InlineData("reference")]
    [InlineData("comments")]
    public void BindResolved_RequiresEveryOriginalInputRatherThanSelectingDiagnosticFallbacks(string member)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentNullException>(() => CommentScaleArticleBindingAdapter.BindResolved(
            member == "plan" ? null! : f.Plan, member == "article" ? null! : f.Article,
            member == "artifacts" ? null! : f.Artifacts, member == "batch" ? null! : f.Batch,
            member == "graph" ? null! : f.Graph, member == "map" ? null! : f.Map,
            member == "occurrence" ? null! : Occurrence(), member == "reference" ? null! : f.Reference,
            member == "comments" ? null! : []));
    }

    [Fact]
    public void OriginalBatchAndNativeMapSnapshotMutableInputsAndExposeReadonlyCollections()
    {
        Fixture f = Create(ArticleScaleVariant.PublishedWithScheduledUpdate);
        var times = Times();
        var tags = new List<int> { 71, 83 };
        var contentAuthorities = f.Artifacts.Content.ToList();
        ArticleScaleResolvedInput input = f.Input with
        {
            TemporalRoles = times,
            TagIds = tags,
            Artifacts = f.Artifacts with
            {
                Content = contentAuthorities
            }
        };
        var assignments = f.Inputs.Select(item => item.ArticleOrdinal == input.ArticleOrdinal ? input : item)
            .Select(item => new ArticleScaleOrdinalAssignment(item.ArticleOrdinal, item.Variant,
                ArticleScaleAssignmentCoverage.ComputeInputDigest(item))).ToList();
        var coverage = new ArticleScaleAssignmentCoverage(f.Article, "synthetic-unit-only", assignments);
        var inputs = new List<ArticleScaleResolvedInput> { input };
        var batch = new ArticleScaleResolvedGraphBatch(f.Article, coverage, inputs);
        var ids = f.Map.Ids.ToDictionary(pair => pair.Key, pair => pair.Value);
        var map = new ArticleScaleGraphIdentityBindings(f.Article.ContentDigest, f.Graph.SemanticArticleId, ids);
        assignments.Clear();
        inputs.Clear();
        tags.Clear();
        times.Clear();
        ids.Clear();
        contentAuthorities.Clear();

        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(f.Article, input.ArticleOrdinal,
            input.Variant, ArticleScaleVariantContractCatalog.Get(input.Variant), map, batch);
        CommentScaleGraphFactBindings result = CommentScaleArticleBindingAdapter.BindResolved(f.Plan, f.Article, f.Artifacts,
            batch, graph, map, Occurrence(), new(ArticleScaleGraphIdentityBindings.Schema, map.Digest), []);
        Assert.Equal(900007, result.ArticleId);
        Assert.Throws<NotSupportedException>(() => ((IDictionary<string, long>)map.Ids).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<int>)batch.ArticleOrdinals).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleRequestFactBinding>)result.Comments).Clear());
        ArticleScaleRowPlan[] aliases = graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).ToArray();
        Assert.Equal(2, aliases.Length);
        Assert.Equal(map.Ids[aliases[0].SemanticId], map.Ids[aliases[1].SemanticId]);
    }

    [Fact]
    public void BindResolved_OriginalFactoryRefusesBrokenContentAliasesAndDuplicateNativeRows()
    {
        Fixture f = Create(ArticleScaleVariant.PublishedWithScheduledUpdate);
        ArticleScaleRowPlan[] blocks = f.Graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).ToArray();
        var ids = f.Map.Ids.ToDictionary(pair => pair.Key, pair => pair.Value);
        ids[blocks[1].SemanticId] = ids[blocks[0].SemanticId] + 400000;
        var map = new ArticleScaleGraphIdentityBindings(f.Article.ContentDigest, f.Graph.SemanticArticleId, ids);
        Assert.Throws<InvalidOperationException>(() => Bind(f with { Map = map, Reference = new(ArticleScaleGraphIdentityBindings.Schema, map.Digest) }));
        ids = f.Map.Ids.ToDictionary(pair => pair.Key, pair => pair.Value);
        ArticleScaleRowPlan[] revisions = f.Graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevision).ToArray();
        ids[revisions[1].SemanticId] = ids[revisions[0].SemanticId];
        map = new(f.Article.ContentDigest, f.Graph.SemanticArticleId, ids);
        Assert.Throws<InvalidOperationException>(() => Bind(f with { Map = map, Reference = new(ArticleScaleGraphIdentityBindings.Schema, map.Digest) }));
    }

    private static CommentScaleGraphFactBindings Bind(Fixture f)
        => CommentScaleArticleBindingAdapter.BindResolved(f.Plan, f.Article, f.Artifacts, f.Batch, f.Graph,
            f.Map, Occurrence(), f.Reference, []);

    private static CommentScaleGraphOccurrence Occurrence() => new("empty", 0, "original.article.target");

    private sealed record Fixture(ArticleScalePlan Article, ArticleScaleArtifactBindings Artifacts, CommentScalePlan Plan,
        ArticleScaleResolvedInput Input, IReadOnlyList<ArticleScaleResolvedInput> Inputs, ArticleScaleAssignmentCoverage Coverage,
        ArticleScaleResolvedGraphBatch Batch, ArticleScaleArticleGraph Graph, ArticleScaleGraphIdentityBindings Map,
        CommentScaleArtifactReference Reference, int CoverageCount);

    private static Fixture Create(ArticleScaleVariant variant = ArticleScaleVariant.Published)
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-s", "unit-resolved", artifacts);
        // Deliberate synthetic shuffle: lifecycle variants precede published slots.
        ArticleScaleVariant[] variants = ArticleScaleDistributionCatalog.Create("scale-s")
            .OrderByDescending(pair => pair.Key).SelectMany(pair => Enumerable.Repeat(pair.Key, pair.Value)).ToArray();
        ArticleScaleResolvedInput[] inputs = variants.Select((value, index) => new ArticleScaleResolvedInput(
            index + article.IdAllocation.ArticleOrdinalBase, value, $"Synthetic custom title {index}",
            "# Synthetic custom markdown\n\nExplicit unit payload.", "Explicit unit summary", null, 71, [83, 97], 12345,
            Times(), artifacts, "synthetic-unit-only-hotness-reference")).ToArray();
        var assignments = inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal, input.Variant,
            ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToArray();
        var coverage = new ArticleScaleAssignmentCoverage(article, "synthetic-unit-only-assignment", assignments);
        ArticleScaleResolvedInput input = inputs.First(item => item.Variant == variant);
        var batch = new ArticleScaleResolvedGraphBatch(article, coverage, [input]);
        ArticleScaleArticleGraph rosterOnly = CanonicalArticleGraphFactory.BuildArticleGraph(article, input.ArticleOrdinal,
            input.Variant, ArticleScaleVariantContractCatalog.Get(input.Variant), null, batch);
        var ids = new Dictionary<string, long>();
        long syntheticId = 900007;
        foreach (ArticleScaleNativeRoleRequirement role in CanonicalArticleGraphFactory.DescribeNativeRoles(article, [rosterOnly]))
        {
            long id = role.Kind == ArticleScaleRowKind.Article ? 900007 : syntheticId += 101;
            foreach (string semanticRole in role.SemanticRoles)
            {
                ids.Add(semanticRole, id);
            }
        }
        var map = new ArticleScaleGraphIdentityBindings(article.ContentDigest, rosterOnly.SemanticArticleId, ids);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(article, input.ArticleOrdinal,
            input.Variant, ArticleScaleVariantContractCatalog.Get(input.Variant), map, batch);
        CommentScalePlan plan = new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            article.Namespace, article.ScaleTier, 0, 1, new(ArticleScaleContractIds.PlanSchema, article.ContentDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, UnitDigest), new(ArticleScaleContractIds.TemporalArtifactSchema, UnitDigest),
            [new("empty", CommentScaleThreadShape.ZeroCommentArticle, "original.article.target", 1, [],
                new(Enum.GetValues<CommentScaleRelation>(), Enum.GetValues<CommentScaleAuthority>()
                    .Select(authority => new CommentScaleAuthorityReference(authority, new string('a', 40), UnitDigest)).ToArray()))], string.Empty);
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        return new(article, artifacts, plan, input, inputs, coverage, batch, graph, map,
            new(ArticleScaleGraphIdentityBindings.Schema, map.Digest), assignments.Length);
    }

    private static Dictionary<string, DateTime> Times()
    {
        DateTime created = new(2024, 2, 29, 12, 0, 0, DateTimeKind.Utc);
        return new()
        {
            [ArticleScaleTemporalRoles.ArticleCreated] = created,
            [ArticleScaleTemporalRoles.ArticleRevision] = created.AddMinutes(1),
            [ArticleScaleTemporalRoles.ArticlePublication] = created.AddMinutes(2),
            [ArticleScaleTemporalRoles.ArticlePublished] = created.AddMinutes(2),
            [ArticleScaleTemporalRoles.ArticleMetadataUpdated] = created.AddHours(2),
            [ArticleScaleTemporalRoles.CommandTime] = created.AddHours(3),
            [ArticleScaleTemporalRoles.BoundaryTime] = created.AddDays(7),
            [ArticleScaleTemporalRoles.Occurred] = created.AddDays(1)
        };
    }

    private static ArticleScaleArtifactBindings Artifacts()
        => new(new(ArticleScaleContractIds.TemporalArtifactSchema, "config/testing/resolved-temporal-roles", "data-scale.lifecycle", UnitDigest),
            new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.DistributionShape, UnitDigest),
            [new(ArticleScaleContractIds.ContentShapeCatalogSchema, "config/testing/content-shape-catalog", "script.zh-hans", UnitDigest)],
            [new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "webp-landscape", UnitDigest),
             new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "no-cover", UnitDigest)],
            [new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape, UnitDigest)]);
}
