using System.Collections;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual pure component controls; caller inputs never establish complete package authority.</summary>
public sealed class ArticlePackageManifestCandidatePlannerTests
{
    private static readonly Guid s_definition = Guid.Parse("30000000-0000-4000-8000-000000000001");
    private static readonly string s_definitionDigest = new('a', 64);

    [Theory]
    [InlineData("# 原文\nexact  \n", false)]
    [InlineData("# 原文 😀 שלום\r\nexact  \t\r\n", true)]
    [InlineData("no final newline  ", false)]
    public void Planner_PreservesExactSourceBytesAndNullSummary(string markdown, bool bom)
    {
        byte[] sourceBytes = Bytes(markdown, bom);
        ArticlePackageManifestCandidateInput input = Input(markdown: markdown, bytes: sourceBytes);
        ArticlePackageManifestCandidatePlan plan = Create([input]);
        ArticlePackageManifestPlannedArticle article = Assert.Single(plan.Articles);

        Assert.Equal(sourceBytes, article.CopySourceBytes());
        Assert.Null(article.Manifest.Summary);
        Assert.Equal(input.Article.Title, article.Manifest.Title);
        Assert.Equal(input.TitleBinding.SourceCanonicalHash, article.TitleSummary.SourceCanonicalHash);
        Assert.Equal(input.PropertySnapshot.ContentDigest, article.Properties.SourceSnapshotDigest);
        Assert.True(ArticlePackageSourceBytes.Verify(sourceBytes, article.Manifest.SourceBytes).IsValid);
        Assert.Equal(bom, article.Manifest.SourceBytes.HasUtf8Bom);
        Assert.False(plan.RequirePackageAuthority().IsValid);
        Assert.Equal("article_package_manifest_authority_unavailable", plan.RequirePackageAuthority().ReasonCode);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("text")]
    [InlineData("zero")]
    [InlineData("false")]
    public void Planner_ReusesRealPropertyMapperForEmptyOrPrimitiveCandidates(string kind)
    {
        ArticlePropertyTypedValue? value = kind switch
        {
            "text" => new ArticlePropertyTextValue("exact e\u0301 😀"),
            "zero" => new ArticlePropertyNumberValue(0),
            "false" => new ArticlePropertyBooleanValue(false),
            _ => null
        };
        ArticlePackageManifestCandidateInput input = Input(value: value);
        ArticlePackageManifestCandidatePlan plan = Create([input]);
        ArticlePackageManifestPlannedArticle article = Assert.Single(plan.Articles);

        Assert.Equal(input.PropertySnapshot.ContentDigest, article.Manifest.PropertySnapshotDigest);
        Assert.Equal(article.Properties.MappingDigest, article.Manifest.PropertyMappingDigest);
        Assert.True(ArticlePackagePropertyMapper.ValidateCandidate(input.PropertySnapshot, input.PropertyBindings, article.Properties).IsValid);
        if (value is null)
        {
            Assert.Empty(article.Properties.Properties);
        }
        else
        {
            Assert.Equal(value, Assert.IsType<ArticlePackagePrimitivePropertyProjection>(Assert.Single(article.Properties.Properties).Projection).Value);
        }
        Assert.False(plan.RequirePackageAuthority().IsValid);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Planner_RejectsEmptyAndNonemptyReferencesWithoutActualReferenceAuthority(bool nonempty)
    {
        ArticlePackageManifestCandidateInput input = Input(value: new ArticlePropertyArticleReferenceValue(nonempty ? [18] : []));
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(input.PropertySnapshot, input.PropertyBindings, out _).IsValid);

        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([input], out var plan);

        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_reference_authority_unavailable", result.ReasonCode);
        Assert.Null(plan);
    }

    [Fact]
    public void Planner_OneThousandArticleBoundaryRemainsOrderedAndNeverQualified()
    {
        ArticlePackageManifestCandidateInput[] inputs = Enumerable.Range(1, 1000).Select(id => Input(id)).Reverse().ToArray();
        ArticlePackageManifestCandidatePlan plan = Create(inputs);

        Assert.Equal(1000, plan.Articles.Count);
        Assert.Equal(plan.Articles.Select(static article => article.Manifest.PortableArticle.Value).Order(StringComparer.Ordinal),
            plan.Articles.Select(static article => article.Manifest.PortableArticle.Value));
        Assert.Equal(plan.Manifest.Articles.Select(static article => article.PortableArticle.Value),
            plan.Articles.Select(static article => article.Manifest.PortableArticle.Value));
        Assert.False(plan.RequirePackageAuthority().IsValid);
        Reject(Enumerable.Repeat(inputs[0], 1001).ToArray());
        Reject([]);
    }

    [Fact]
    public void Planner_InputOrderDoesNotChangeSemanticDigestOrCodecBinding()
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input(19), Input(17), Input(18)];
        ArticlePackageManifestCandidatePlan original = Create(inputs);
        ArticlePackageManifestCandidatePlan permuted = Create(inputs.Reverse().ToArray());

        Assert.Equal(original.Manifest.SemanticDigest, permuted.Manifest.SemanticDigest);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteCandidate(original.Manifest),
            ArticlePackageManifestCandidateCodec.WriteCandidate(permuted.Manifest));
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(original.Manifest);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(encoded, out var parsed).IsValid);
        Assert.True(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(parsed, inputs, out var rebound).IsValid);
        ArticlePackageManifestCandidatePlan bound = Assert.IsType<ArticlePackageManifestCandidatePlan>(rebound);
        Assert.Equal(original.Manifest.SemanticDigest, bound.Manifest.SemanticDigest);
        Assert.Equal(original.Articles.Select(static article => article.Manifest.SourceBytes.Sha256),
            bound.Articles.Select(static article => article.Manifest.SourceBytes.Sha256));
    }

    [Theory]
    [InlineData("newlines")]
    [InlineData("unicode")]
    public void Planner_RejectsDifferentRawBytesEvenWhenCanonicalHashIsIdentical(string difference)
    {
        string markdown = "# Café\nraw  \n";
        string alternate = difference == "newlines" ? "# Café\r\nraw  \r\n" : "# Cafe\u0301\nraw  \n";
        ArticlePackageManifestCandidateInput original = Input(markdown: markdown);
        ArticleCanonicalInput normalizedEquivalent = original.Article with
        {
            MarkdownContent = alternate
        };
        Assert.Equal(ArticleCanonicalHashV1.ComputeHashHex(original.Article), ArticleCanonicalHashV1.ComputeHashHex(normalizedEquivalent));
        var wrongBytes = new ArticlePackageManifestCandidateInput(original.Article, original.TitleBinding,
            original.PropertySnapshot, original.PropertyBindings, Bytes(alternate));

        Reject([wrongBytes]);
        var matchingBytes = new ArticlePackageManifestCandidateInput(normalizedEquivalent, original.TitleBinding,
            original.PropertySnapshot, original.PropertyBindings, Bytes(alternate));
        ArticlePackageManifestCandidatePlan left = Create([original]);
        ArticlePackageManifestCandidatePlan right = Create([matchingBytes]);
        Assert.NotEqual(left.Manifest.SemanticDigest, right.Manifest.SemanticDigest);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(left.Manifest, [matchingBytes], out var mismatch).IsValid);
        Assert.Null(mismatch);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("site")]
    [InlineData("property-revision")]
    [InlineData("draft")]
    [InlineData("draft-server-revision")]
    [InlineData("publication")]
    [InlineData("snapshot-digest")]
    public void Planner_RejectsPropertyCoordinatesOrDigestDriftAgainstOriginalBindings(string fault)
    {
        ArticlePackageManifestCandidateInput input = Input(value: new ArticlePropertyBooleanValue(false));
        ArticlePropertySnapshotCoordinates original = input.PropertySnapshot.Coordinates;
        ArticlePropertySnapshotCoordinates changed = fault switch
        {
            "article" => original with
            {
                ArticleId = original.ArticleId + 1
            },
            "revision" => original with
            {
                ArticleRevisionId = original.ArticleRevisionId + 1
            },
            "site" => original with
            {
                SiteScope = "site-b"
            },
            "property-revision" => original with
            {
                PropertyRevision = original.PropertyRevision + 1
            },
            "draft" => original with
            {
                DraftId = 5,
                DraftServerRevision = 2
            },
            "draft-server-revision" => original with
            {
                DraftId = 5,
                DraftServerRevision = 3
            },
            "publication" => original with
            {
                DraftId = null,
                DraftServerRevision = null,
                PublicationId = 99
            },
            _ => original
        };
        string digest = fault == "snapshot-digest" ? new string('b', 64)
            : ArticlePropertyValueDigest.ComputeSnapshot(changed, input.PropertySnapshot.Values);
        var snapshot = new ArticlePropertyValueSnapshot(1, changed, input.PropertySnapshot.Values, digest);
        var drifted = new ArticlePackageManifestCandidateInput(input.Article, input.TitleBinding,
            snapshot, input.PropertyBindings, Bytes(input.Article.MarkdownContent));

        Reject([drifted]);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    public void Planner_RejectsSelfConsistentPropertySnapshotForAnotherCanonicalArticleRevision(string fault)
    {
        ArticlePackageManifestCandidateInput input = Input();
        ArticlePropertySnapshotCoordinates coordinates = fault == "article" ? input.PropertySnapshot.Coordinates with
        {
            ArticleId = 18
        } : input.PropertySnapshot.Coordinates with
        {
            ArticleRevisionId = 999
        };
        ArticlePropertyValueSnapshot snapshot = Snapshot(coordinates, input.PropertySnapshot.Values);
        ArticlePackagePropertyMappingBindings bindings = PropertyBindings(snapshot);
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out _).IsValid);
        var mismatch = new ArticlePackageManifestCandidateInput(input.Article, input.TitleBinding,
            snapshot, bindings, Bytes(input.Article.MarkdownContent));

        Reject([mismatch]);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("property-revision")]
    [InlineData("draft")]
    [InlineData("publication")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("title-digest")]
    [InlineData("property-digest")]
    public void Binder_RejectsSelfConsistentAlteredManifestAgainstOriginalInputs(string fault)
    {
        ArticlePackageManifestCandidateInput input = Input();
        ArticlePackageManifestCandidatePlan plan = Create([input]);
        ArticlePackageManifestArticle entry = plan.Manifest.Articles[0];
        ArticlePackageManifestSource source = fault switch
        {
            "site" => entry.Source with
            {
                SiteScope = "site-b"
            },
            "property-revision" => entry.Source with
            {
                PropertyRevision = entry.Source.PropertyRevision + 1
            },
            "draft" => entry.Source with
            {
                DraftId = 5,
                DraftServerRevision = 2
            },
            "publication" => entry.Source with
            {
                DraftId = null,
                DraftServerRevision = null,
                PublicationId = 99
            },
            _ => entry.Source
        };
        ArticlePackageManifestArticle altered = entry with
        {
            Source = source,
            Title = fault == "title" ? entry.Title + "changed" : entry.Title,
            Summary = fault == "summary" ? string.Empty : entry.Summary,
            TitleSummaryDigest = fault == "title-digest" ? new string('b', 64) : entry.TitleSummaryDigest,
            PropertyMappingDigest = fault == "property-digest" ? new string('b', 64) : entry.PropertyMappingDigest
        };
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate([altered], out var changed).IsValid);
        Assert.NotEqual(plan.Manifest.SemanticDigest, changed!.SemanticDigest);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(changed, [input], out var rebound).IsValid);
        Assert.Null(rebound);
    }

    [Fact]
    public void Planner_OwnsInputBytesAndReturnsDetachedPlanCopies()
    {
        string markdown = "# frozen\r\nexact  \t\r\n";
        byte[] callerBytes = Bytes(markdown, bom: true);
        byte[] expected = (byte[])callerBytes.Clone();
        ArticlePackageManifestCandidateInput input = Input(markdown: markdown, bytes: callerBytes);
        Array.Fill(callerBytes, (byte)0);
        ArticlePackageManifestCandidateInput[] callerInputs = [input];
        ArticlePackageManifestCandidatePlan plan = Create(callerInputs);
        string digest = plan.Manifest.SemanticDigest;
        callerInputs[0] = Input(18);
        ArticlePackageManifestPlannedArticle held = Assert.Single(plan.Articles);
        byte[] detached = held.CopySourceBytes();
        Array.Fill(detached, (byte)0);

        Assert.Equal(expected, held.CopySourceBytes());
        Assert.Equal(digest, plan.Manifest.SemanticDigest);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageManifestPlannedArticle>)plan.Articles)[0] = held);
    }

    [Theory]
    [InlineData("draft")]
    [InlineData("publication")]
    public void Planner_RejectsSelfConsistentDraftOrPublicationWithoutExactCrossOwnerSourceProof(string scope)
    {
        ArticlePackageManifestCandidateInput input = Input();
        ArticlePropertySnapshotCoordinates coordinates = scope == "draft" ? input.PropertySnapshot.Coordinates with
        {
            DraftId = 5,
            DraftServerRevision = 2
        } : input.PropertySnapshot.Coordinates with
        {
            PublicationId = 99
        };
        ArticlePropertyValueSnapshot snapshot = Snapshot(coordinates, input.PropertySnapshot.Values);
        var asserted = new ArticlePackageManifestCandidateInput(input.Article, input.TitleBinding,
            snapshot, PropertyBindings(snapshot), Bytes(input.Article.MarkdownContent));
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(snapshot, asserted.PropertyBindings, out _).IsValid);

        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([asserted], out var plan);

        Assert.False(result.IsValid);
        Assert.Contains("authority_unavailable", result.ReasonCode, StringComparison.Ordinal);
        Assert.Null(plan);
    }

    [Theory]
    [InlineData("source-to-two-portable")]
    [InlineData("two-source-to-portable")]
    [InlineData("definition-revision")]
    [InlineData("definition-digest")]
    public void Planner_RejectsCrossArticleDefinitionAliasesAndEpochDrift(string fault)
    {
        ArticlePackageManifestCandidateInput first = Input(17, value: new ArticlePropertyNumberValue(0));
        ArticlePackageManifestCandidateInput second = Input(18, value: new ArticlePropertyNumberValue(0));
        Guid sourceDefinition = fault == "two-source-to-portable"
            ? Guid.Parse("30000000-0000-4000-8000-000000000002") : s_definition;
        long revision = fault == "definition-revision" ? 2 : 1;
        string digest = fault == "definition-digest" ? new string('b', 64) : s_definitionDigest;
        ArticlePackageIdentity portable = Portable(ArticlePackageIdentityKind.Definition, fault == "source-to-two-portable" ? 2 : 1);
        var value = new ArticlePropertyValueInput(sourceDefinition, revision, digest,
            ArticlePropertyValuePresence.Present, new ArticlePropertyNumberValue(0));
        ArticlePropertyValueEntry entry = new(sourceDefinition, revision, digest, value.Presence, value.Value,
            ArticlePropertyValueDigest.ComputeValue(value));
        ArticlePropertyValueSnapshot snapshot = Snapshot(second.PropertySnapshot.Coordinates, [entry]);
        var bindings = new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest,
            [new(sourceDefinition, revision, digest, portable)], [], []);
        var altered = new ArticlePackageManifestCandidateInput(second.Article, second.TitleBinding,
            snapshot, bindings, Bytes(second.Article.MarkdownContent));
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out _).IsValid);

        Reject([first, altered]);
        Assert.Equal(2, Create([first, second]).Articles.Count);
    }

    [Theory]
    [InlineData("source-to-two-portable")]
    [InlineData("two-source-to-portable")]
    [InlineData("definition-scope-alias")]
    public void Planner_RejectsCrossArticleOptionAliasesWhileRespectingDefinitionScope(string fault)
    {
        Guid option = Guid.Parse("40000000-0000-4000-8000-000000000001");
        Guid otherOption = Guid.Parse("40000000-0000-4000-8000-000000000002");
        Guid otherDefinition = Guid.Parse("30000000-0000-4000-8000-000000000002");
        ArticlePackageManifestCandidateInput first = SelectInput(17, s_definition, option, 1, 1);
        ArticlePackageManifestCandidateInput consistent = SelectInput(18, s_definition, option, 1, 1);
        ArticlePackageManifestCandidateInput altered = fault switch
        {
            "source-to-two-portable" => SelectInput(18, s_definition, option, 1, 2),
            "two-source-to-portable" => SelectInput(18, s_definition, otherOption, 1, 1),
            _ => SelectInput(18, otherDefinition, option, 2, 1)
        };
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(first.PropertySnapshot, first.PropertyBindings, out _).IsValid);
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(altered.PropertySnapshot, altered.PropertyBindings, out _).IsValid);

        Reject([first, altered]);
        Assert.Equal(2, Create([first, consistent]).Articles.Count);
        Assert.Equal(2, Create([first, SelectInput(18, otherDefinition, option, 2, 2)]).Articles.Count);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("owner")]
    public void Planner_RejectsIndividuallyConsistentInputsFromDifferentOwnerScopes(string fault)
    {
        ArticlePackageManifestCandidateInput first = Input(17);
        ArticlePackageManifestCandidateInput second = Input(18);
        ArticlePropertySnapshotCoordinates coordinates = fault == "site" ? second.PropertySnapshot.Coordinates with
        {
            SiteScope = "site-b"
        } : second.PropertySnapshot.Coordinates with
        {
            DefinitionOwnerUserId = 43
        };
        ArticlePropertyValueSnapshot snapshot = Snapshot(coordinates, second.PropertySnapshot.Values);
        var altered = new ArticlePackageManifestCandidateInput(second.Article, second.TitleBinding,
            snapshot, PropertyBindings(snapshot), Bytes(second.Article.MarkdownContent));
        Assert.Single(Create([altered]).Articles);

        Reject([first, altered]);
    }

    [Fact]
    public void Planner_RejectsAggregateTextBudgetEvenWhenEachInputFitsItsMapperBudget()
    {
        string markdown = new('x', 1048576 - 256);
        ArticlePackageManifestCandidateInput[] inputs = Enumerable.Range(1, 17)
            .Select(id => Input(id, markdown: markdown)).ToArray();
        Assert.True(ArticlePackageTitleSummaryMapper.TryMapCandidate(inputs[0].Article, inputs[0].TitleBinding, out _).IsValid);

        Reject(inputs);
        Assert.Single(Create([Input()]).Articles);
    }

    [Fact]
    public void Planner_RejectsAggregatePropertyBudgetBeforePublishingAnySubset()
    {
        ArticlePropertyValueEntry[] values = Enumerable.Range(1, 1000).Select(index =>
        {
            Guid definition = Guid.Parse($"30000000-0000-4000-8000-{index:x12}");
            var value = new ArticlePropertyValueInput(definition, 1, s_definitionDigest,
                ArticlePropertyValuePresence.Present, new ArticlePropertyNumberValue(0));
            return new ArticlePropertyValueEntry(definition, 1, s_definitionDigest, value.Presence,
                value.Value, ArticlePropertyValueDigest.ComputeValue(value));
        }).ToArray();
        ArticlePackagePropertyDefinitionBinding[] definitions = values.Select((value, index) =>
            new ArticlePackagePropertyDefinitionBinding(value.DefinitionId, value.DefinitionSchemaRevision,
                value.DefinitionDigest, Portable(ArticlePackageIdentityKind.Definition, index + 1))).ToArray();
        ArticlePackageManifestCandidateInput[] inputs = Enumerable.Range(1, 21).Select(id =>
        {
            ArticlePackageManifestCandidateInput input = Input(id);
            ArticlePropertyValueSnapshot snapshot = Snapshot(input.PropertySnapshot.Coordinates, values);
            var bindings = new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest, definitions, [], []);
            return new ArticlePackageManifestCandidateInput(input.Article, input.TitleBinding, snapshot,
                bindings, Bytes(input.Article.MarkdownContent));
        }).ToArray();
        Assert.True(ArticlePackagePropertyMapper.TryMapCandidate(inputs[0].PropertySnapshot, inputs[0].PropertyBindings, out _).IsValid);

        Reject(inputs);
        Assert.Single(Create([Input()]).Articles);
    }

    [Fact]
    public void Planner_FailedAndRepeatedAttemptsNeverReturnPartialPlanOrPoisonLaterValidRun()
    {
        ArticlePackageManifestCandidateInput valid = Input();
        var invalid = new ArticlePackageManifestCandidateInput(valid.Article, valid.TitleBinding,
            valid.PropertySnapshot, valid.PropertyBindings, new byte[] { 0xff });
        string initialDigest = Create([valid]).Manifest.SemanticDigest;

        for (int attempt = 0; attempt < 2; attempt++)
        {
            Reject([valid, invalid]);
            Reject([invalid, valid]);
            Assert.Equal(initialDigest, Create([valid]).Manifest.SemanticDigest);
        }
        Assert.False(ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(null, out var absent).IsValid);
        Assert.Null(absent);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(null, [valid], out var noManifest).IsValid);
        Assert.Null(noManifest);
    }

    [Fact]
    public void Planner_RefusesChangedCallerTagsAfterFreezingAndCanRetryRestoredInput()
    {
        int[] tags = [1];
        ArticlePackageManifestCandidateInput original = Input(tags: tags);
        ArticlePackageManifestCandidatePlan frozen = Create([original]);
        string digest = frozen.Manifest.SemanticDigest;
        tags[0] = 2;

        Reject([original]);
        Assert.Equal(digest, frozen.Manifest.SemanticDigest);
        tags[0] = 1;
        Assert.Equal(digest, Create([original]).Manifest.SemanticDigest);
    }

    [Fact]
    public void Planner_HoldsBoundedInputCountAndNeverEnumeratesCallerCollection()
    {
        ArticlePackageManifestCandidateInput input = Input();
        var caller = new TrackingInputs(input, 1, 1001);
        ArticlePackageManifestCandidatePlan plan = Create(caller);

        Assert.Single(plan.Articles);
        Assert.Equal(1, caller.CountReads);
        Assert.Equal(1, caller.IndexReads);
        Assert.Equal(0, caller.EnumeratorReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1001)]
    public void Planner_RejectsInvalidInputCountBeforeReadingItems(int count)
    {
        var caller = new TrackingInputs(Input(), count, 1);

        Reject(caller);
        Assert.Equal(1, caller.CountReads);
        Assert.Equal(0, caller.IndexReads);
        Assert.Equal(0, caller.EnumeratorReads);
    }

    [Fact]
    public void Planner_CallerIndexFailureHasNoEnumerationFallbackOrPartialResult()
    {
        ArticlePackageManifestCandidateInput input = Input();
        var caller = new TrackingInputs(input, 1, 1, failIndex: true);

        Reject(caller);
        Assert.Equal(1, caller.CountReads);
        Assert.Equal(1, caller.IndexReads);
        Assert.Equal(0, caller.EnumeratorReads);
        Assert.Single(Create([input]).Articles);
    }

    [Fact]
    public void Planner_UsesBoundedTagCopyWithoutEnumeratingOrRereadingCallerCount()
    {
        ArticlePackageManifestCandidateInput ordinary = Input(tags: [1]);
        var tags = new TrackingTags();
        ArticleCanonicalInput source = ordinary.Article with
        {
            TagIds = tags
        };
        var input = new ArticlePackageManifestCandidateInput(source, ordinary.TitleBinding,
            ordinary.PropertySnapshot, ordinary.PropertyBindings, Bytes(source.MarkdownContent));

        Assert.Single(Create([input]).Articles);
        Assert.Equal(1, tags.CountReads);
        Assert.Equal(1, tags.IndexReads);
        Assert.Equal(0, tags.EnumeratorReads);
    }

    [Fact]
    public void Planner_RejectsConstructorSourceByteOverflowWithoutChangingValidInput()
    {
        ArticlePackageManifestCandidateInput input = Input();
        byte[] tooLarge = new byte[ArticlePackageSourceBytes.MaximumByteLength + 1];

        Assert.Throws<ArgumentException>(() => new ArticlePackageManifestCandidateInput(input.Article,
            input.TitleBinding, input.PropertySnapshot, input.PropertyBindings, tooLarge));
        Assert.Single(Create([input]).Articles);
    }

    private static ArticlePackageManifestCandidatePlan Create(IReadOnlyList<ArticlePackageManifestCandidateInput> inputs)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageManifestCandidatePlan>(plan);
    }

    private static void Reject(IReadOnlyList<ArticlePackageManifestCandidateInput> inputs)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, out var plan);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        Assert.Null(plan);
    }

    private static ArticlePackageManifestCandidateInput Input(int id = 17, string markdown = "# 原文\r\nexact  \r\n",
        byte[]? bytes = null, ArticlePropertyTypedValue? value = null, IReadOnlyList<int>? tags = null)
    {
        var article = new ArticleCanonicalInput(id, 1000 + id, 3, "route", "原始 title e\u0301 😀", null,
            null, 1, tags ?? [], ArticleStatusValues.Draft, null, null, markdown);
        var titleBinding = new ArticlePackageTitleSummaryBinding(id, article.ArticleRevisionId!.Value,
            article.RevisionNo!.Value, ArticleCanonicalHashV1.ComputeHashHex(article), Portable(ArticlePackageIdentityKind.Article, id));
        ArticlePropertyValueEntry[] values = [];
        if (value is not null)
        {
            var entry = new ArticlePropertyValueInput(s_definition, 1, s_definitionDigest, ArticlePropertyValuePresence.Present, value);
            values = [new(s_definition, 1, s_definitionDigest, entry.Presence, value, ArticlePropertyValueDigest.ComputeValue(entry))];
        }
        var coordinates = new ArticlePropertySnapshotCoordinates(42, "site-a", id, 1, 1000 + id);
        ArticlePropertyValueSnapshot snapshot = Snapshot(coordinates, values);
        return new ArticlePackageManifestCandidateInput(article, titleBinding, snapshot, PropertyBindings(snapshot), bytes ?? Bytes(markdown));
    }

    private static ArticlePackageManifestCandidateInput SelectInput(int articleId, Guid definitionId, Guid optionId,
        int portableDefinitionId, int portableOptionId)
    {
        ArticlePackageManifestCandidateInput source = Input(articleId);
        var value = new ArticlePropertyValueInput(definitionId, 1, s_definitionDigest,
            ArticlePropertyValuePresence.Present, new ArticlePropertySingleSelectValue(optionId));
        ArticlePropertyValueEntry entry = new(definitionId, 1, s_definitionDigest, value.Presence,
            value.Value, ArticlePropertyValueDigest.ComputeValue(value));
        ArticlePropertyValueSnapshot snapshot = Snapshot(source.PropertySnapshot.Coordinates, [entry]);
        var bindings = new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest,
            [new(definitionId, 1, s_definitionDigest, Portable(ArticlePackageIdentityKind.Definition, portableDefinitionId))],
            [new(definitionId, optionId, Portable(ArticlePackageIdentityKind.Option, portableOptionId))], []);
        return new ArticlePackageManifestCandidateInput(source.Article, source.TitleBinding, snapshot, bindings,
            Bytes(source.Article.MarkdownContent));
    }

    private static ArticlePropertyValueSnapshot Snapshot(ArticlePropertySnapshotCoordinates coordinates, IReadOnlyList<ArticlePropertyValueEntry> values)
        => new(1, coordinates, values, ArticlePropertyValueDigest.ComputeSnapshot(coordinates, values));

    private static ArticlePackagePropertyMappingBindings PropertyBindings(ArticlePropertyValueSnapshot snapshot)
    {
        ArticlePackagePropertyDefinitionBinding[] definitions = snapshot.Values.Select(static value =>
            new ArticlePackagePropertyDefinitionBinding(value.DefinitionId, value.DefinitionSchemaRevision,
                value.DefinitionDigest, Portable(ArticlePackageIdentityKind.Definition, 1))).ToArray();
        ArticlePackagePropertyArticleBinding[] articles = snapshot.Values.SelectMany(static value =>
            value.Value is ArticlePropertyArticleReferenceValue references ? references.ArticleIds : [])
            .Distinct().Select(static id => new ArticlePackagePropertyArticleBinding(id, Portable(ArticlePackageIdentityKind.Article, checked((int)id)),
                new ArticleRelationTargetFacts(new ArticleRelationTargetIdentity(Portable(ArticlePackageIdentityKind.Article, checked((int)id)).Value!,
                    ArticleRelationTargetKind.Article, null, null), "revision:target", 1, ArticleRelationRevisionKind.Current,
                    ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed))).ToArray();
        return new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest, definitions, [], articles);
    }

    private static byte[] Bytes(string markdown, bool bom = false)
        => bom ? [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes(markdown)] : Encoding.UTF8.GetBytes(markdown);

    private static ArticlePackageIdentity Portable(ArticlePackageIdentityKind kind, int number)
    {
        string prefix = kind switch
        {
            ArticlePackageIdentityKind.Article => "article:",
            ArticlePackageIdentityKind.Option => "portable-option:",
            _ => "portable-definition:"
        };
        string value = $"{prefix}20000000-0000-4000-8000-{number:x12}";
        Assert.True(ArticlePackageIdentity.TryCreate(kind, value, out var identity).IsValid);
        return identity;
    }

    private sealed class TrackingInputs(ArticlePackageManifestCandidateInput input, int firstCount, int laterCount,
        bool failIndex = false) : IReadOnlyList<ArticlePackageManifestCandidateInput>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? firstCount : laterCount;
            }
        }
        public ArticlePackageManifestCandidateInput this[int index]
        {
            get
            {
                IndexReads++;
                if (failIndex || index != 0)
                {
                    throw new IndexOutOfRangeException();
                }
                return input;
            }
        }

        public IEnumerator<ArticlePackageManifestCandidateInput> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller input collection must be consumed by bounded indexes.");
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class TrackingTags : IReadOnlyList<int>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? 1 : 1001;
            }
        }
        public int this[int index]
        {
            get
            {
                IndexReads++;
                return index == 0 ? 1 : throw new IndexOutOfRangeException();
            }
        }

        public IEnumerator<int> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller tags must be consumed through bounded indexes.");
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
