using System.Collections;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Contracts.Assets;
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

    [Fact]
    public void AssetPlannerUsesOriginalMappersAndRootAndOwnsCompleteSharedClosure()
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input(18), Input(17)];
        byte[] bytes = AssetBytes();
        var source = AssetSource(1, bytes);
        ArticlePackageAssetCollectionSource[] sources = [source];
        ArticlePackageManifestAssetReference[] references = AssetReferences(inputs, source);
        ArticlePackageInventoryEntry[] inventory = AssetInventory(inputs, sources);
        ArticlePackageManifestCandidatePlan plan = CreateAssets(inputs, sources, references, inventory);
        Assert.True(ArticlePackageAssetCollectionMapper.TryMapCandidate(sources, references, inventory, out var collection).IsValid);
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(
            Create(inputs).Manifest.Articles, collection, inventory, out var root).IsValid);

        Assert.Equal(root!.SemanticDigest, plan.Manifest.SemanticDigest);
        Assert.Equal(2, plan.Manifest.SchemaVersion);
        Assert.Equal(2, plan.Manifest.Assets!.References.Count);
        ArticlePackageManifestPlannedAsset asset = Assert.Single(plan.Assets!);
        Assert.Equal(source.Record, asset.Record);
        Assert.NotSame(source.Record, asset.Record);
        Assert.Equal(bytes, asset.CopySourceBytes());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), asset.RawByteSha256);
        Assert.Equal(asset.RawByteSha256, asset.Metadata.Metadata.Sha256);
        Assert.True(ArticlePackageAssetMetadataMapper.ValidateCandidate(asset.Metadata,
            source.PortableAsset, asset.Record, asset.CopySourceBytes()).IsValid);
        Assert.Equal(inventory.OrderBy(static entry => entry.Path, StringComparer.Ordinal), plan.Inventory!);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(plan.Manifest, plan.Manifest.Assets, plan.Inventory);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(encoded, collection, inventory, out var parsed).IsValid);
        Assert.True(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            parsed, inputs.Reverse().ToArray(), sources, references.Reverse().ToArray(), inventory.Reverse().ToArray(), out var rebound).IsValid);
        Assert.Equal(encoded, ArticlePackageManifestCandidateCodec.WriteCandidate(rebound!.Manifest, rebound.Manifest.Assets, rebound.Inventory));
        Assert.Equal(bytes, Assert.Single(rebound.Assets!).CopySourceBytes());
        Assert.False(plan.RequirePackageAuthority().IsValid);
        Assert.Equal("article_package_manifest_authority_unavailable", plan.RequirePackageAuthority().ReasonCode);
        Assert.False(plan.Manifest.Assets.RequireAssetAuthority().IsValid);
        Assert.False(asset.Metadata.RequireAssetAuthority().IsValid);
        Assert.Null(Create(inputs).Assets);
        Assert.Null(Create(inputs).Inventory);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(plan.Manifest, inputs, out _).IsValid);
    }

    [Fact]
    public void AssetPlannerDistinguishesExplicitEmptyFromEveryMissingInput()
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        var inventory = AssetInventory(inputs, []);
        var empty = CreateAssets(inputs, [], [], inventory);
        Assert.Empty(empty.Assets!);
        Assert.NotNull(empty.Manifest.Assets);
        Assert.Empty(empty.Manifest.Assets.Assets);
        Assert.False(empty.RequirePackageAuthority().IsValid);
        RejectAssets(inputs, null, [], inventory);
        RejectAssets(inputs, [], null, inventory);
        RejectAssets(inputs, [], [], null);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            null, inputs, [], [], inventory, out var absent).IsValid);
        Assert.Null(absent);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            Create(inputs).Manifest, inputs, [], [], inventory, out absent).IsValid);
        Assert.Null(absent);
    }

    [Fact]
    public void AssetPlannerOneThousandArticlesShareOneFrozenAssetInStableOrder()
    {
        var inputs = Enumerable.Range(1, 1000).Select(id => Input(id)).ToArray();
        var sources = new[] { AssetSource(1, AssetBytes()) };
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var original = CreateAssets(inputs, sources, references, inventory);
        var reversed = CreateAssets(inputs.Reverse().ToArray(), sources, references.Reverse().ToArray(), inventory.Reverse().ToArray());
        Assert.Equal(1000, original.Articles.Count);
        Assert.Single(original.Assets!);
        Assert.Equal(1000, original.Manifest.Assets!.References.Count);
        Assert.Equal(original.Manifest.SemanticDigest, reversed.Manifest.SemanticDigest);
        Assert.Equal(ArticlePackageManifestCandidateCodec.WriteCandidate(original.Manifest, original.Manifest.Assets, original.Inventory),
            ArticlePackageManifestCandidateCodec.WriteCandidate(reversed.Manifest, reversed.Manifest.Assets, reversed.Inventory));
        RejectAssets([], sources, references, inventory);
        RejectAssets([.. inputs, Input(1001)], sources, references, inventory);
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("record")]
    [InlineData("references")]
    [InlineData("inventory")]
    [InlineData("article")]
    public void AssetPlannerFreezesCallerStateAndBindReprojectsEveryChangedSource(string fault)
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        byte[] bytes = AssetBytes();
        ArticlePackageAssetCollectionSource[] sources = [AssetSource(1, bytes)];
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var plan = CreateAssets(inputs, sources, references, inventory);
        byte[] encoded = ArticlePackageManifestCandidateCodec.WriteCandidate(plan.Manifest, plan.Manifest.Assets, plan.Inventory);
        byte[] detached = plan.Assets![0].CopySourceBytes();
        detached[0] ^= 1;
        switch (fault)
        {
            case "bytes":
                bytes[^1] ^= 1;
                break;
            case "record":
                sources[0] = sources[0] with
                {
                    Record = sources[0].Record with
                    {
                        Sha256 = new string('b', 64)
                    }
                };
                break;
            case "references":
                references[0] = references[0] with
                {
                    PortableArticle = Portable(ArticlePackageIdentityKind.Article, 18)
                };
                break;
            case "inventory":
                inventory[^1] = inventory[^1] with
                {
                    CompressedBytes = inventory[^1].CompressedBytes + 1
                };
                break;
            default:
                // The canonical hash normalizes newlines; raw bytes must still be rebound independently.
                var original = inputs[0];
                var article = original.Article with
                {
                    MarkdownContent = original.Article.MarkdownContent.Replace("\r\n", "\n", StringComparison.Ordinal)
                };
                Assert.Equal(original.TitleBinding.SourceCanonicalHash, ArticleCanonicalHashV1.ComputeHashHex(article));
                inputs[0] = new(article, original.TitleBinding, original.PropertySnapshot, original.PropertyBindings, Bytes(article.MarkdownContent));
                inventory = AssetInventory(inputs, sources);
                break;
        }
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            plan.Manifest, inputs, sources, references, inventory, out var rebound).IsValid);
        Assert.Null(rebound);
        Assert.Equal(encoded, ArticlePackageManifestCandidateCodec.WriteCandidate(plan.Manifest, plan.Manifest.Assets, plan.Inventory));
        Assert.Equal(AssetBytes(), plan.Assets[0].CopySourceBytes());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(AssetBytes())), plan.Assets[0].RawByteSha256);
        Assert.Equal(AssetSource(1, AssetBytes()).Record, plan.Assets[0].Record);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("draft")]
    [InlineData("publication")]
    [InlineData("duplicateSource")]
    [InlineData("duplicateEdge")]
    [InlineData("unknownAsset")]
    [InlineData("unknownArticle")]
    [InlineData("orphan")]
    [InlineData("missingAsset")]
    [InlineData("extraArticle")]
    [InlineData("articleSize")]
    [InlineData("assetSize")]
    [InlineData("private")]
    [InlineData("pendingDelete")]
    [InlineData("forgedBytes")]
    [InlineData("media")]
    public void AssetPlannerCreateAndBindRefuseCoordinateClosureByteAndPermissionFaults(string fault)
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        ArticlePackageAssetCollectionSource[] sources = [AssetSource(1, AssetBytes())];
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var original = CreateAssets(inputs, sources, references, inventory);
        switch (fault)
        {
            case "revision":
            case "draft":
            case "publication":
                var input = inputs[0];
                var coordinates = fault switch
                {
                    "revision" => input.PropertySnapshot.Coordinates with { ArticleRevisionId = 9999 },
                    "draft" => input.PropertySnapshot.Coordinates with { DraftId = 3, DraftServerRevision = 2 },
                    _ => input.PropertySnapshot.Coordinates with { PublicationId = 9 }
                };
                var snapshot = Snapshot(coordinates, input.PropertySnapshot.Values);
                inputs[0] = new(input.Article, input.TitleBinding, snapshot, PropertyBindings(snapshot), input.SourceBytes);
                break;
            case "duplicateSource":
                sources = [sources[0], sources[0]];
                break;
            case "duplicateEdge":
                references = [references[0], references[0]];
                break;
            case "unknownAsset":
                references[0] = references[0] with
                {
                    PortableAsset = AssetIdentity(2)
                };
                break;
            case "unknownArticle":
                references[0] = references[0] with
                {
                    PortableArticle = Portable(ArticlePackageIdentityKind.Article, 18)
                };
                break;
            case "orphan":
                references = [];
                break;
            case "missingAsset":
                inventory = inventory.Where(static entry => !entry.Path.StartsWith("assets/", StringComparison.Ordinal)).ToArray();
                break;
            case "extraArticle":
                inventory = [.. inventory, InventoryEntry("articles/" + Portable(ArticlePackageIdentityKind.Article, 18).FileNameToken + ".md", 1)];
                break;
            case "articleSize":
                inventory[2] = inventory[2] with
                {
                    UncompressedBytes = inventory[2].UncompressedBytes + 1
                };
                break;
            case "assetSize":
                inventory[^1] = inventory[^1] with
                {
                    UncompressedBytes = inventory[^1].UncompressedBytes + 1
                };
                break;
            case "private":
                sources[0] = sources[0] with
                {
                    Record = sources[0].Record with
                    {
                        StorageClass = "private"
                    }
                };
                break;
            case "pendingDelete":
                sources[0] = sources[0] with
                {
                    Record = sources[0].Record with
                    {
                        State = ContentAssetState.PendingDelete
                    }
                };
                break;
            case "forgedBytes":
                sources[0] = sources[0] with
                {
                    SourceBytes = new byte[AssetBytes().Length]
                };
                break;
            default:
                sources[0] = sources[0] with
                {
                    Record = sources[0].Record with
                    {
                        WidthPixels = 2
                    }
                };
                break;
        }
        RejectAssets(inputs, sources, references, inventory);
        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            original.Manifest, inputs, sources, references, inventory, out var rebound).IsValid);
        Assert.Null(rebound);
        Assert.Single(CreateAssets([Input()], [AssetSource(1, AssetBytes())],
            AssetReferences([Input()], AssetSource(1, AssetBytes())), AssetInventory([Input()], [AssetSource(1, AssetBytes())])).Assets!);
    }

    [Theory]
    [InlineData("rootDigest")]
    [InlineData("componentDigest")]
    [InlineData("childDigest")]
    [InlineData("rootArticle")]
    [InlineData("childMetadata")]
    [InlineData("references")]
    public void AssetPlannerBindRejectsForgedCandidatesWithCopiedDigests(string fault)
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        ArticlePackageAssetCollectionSource[] sources = [AssetSource(1, AssetBytes())];
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var original = CreateAssets(inputs, sources, references, inventory);
        var collection = original.Manifest.Assets!;
        var metadata = collection.Assets[0].Metadata;
        var child = Construct<ArticlePackageManifestAssetMetadataCandidate>(
            fault == "childMetadata" ? metadata with
            {
                WidthPixels = 2
            } : metadata,
            fault == "childDigest" ? new string('b', 64) : collection.Assets[0].ComponentDigest);
        var forgedCollection = Construct<ArticlePackageManifestAssetCollectionCandidate>(
            new[] { child }, fault == "references" ? Array.Empty<ArticlePackageManifestAssetReference>() : references,
            inventory.OrderBy(static entry => entry.Path, StringComparer.Ordinal).ToArray(), collection.TotalAssetBytes,
            fault == "componentDigest" ? new string('b', 64) : collection.ComponentDigest);
        var rows = original.Manifest.Articles.ToArray();
        if (fault == "rootArticle")
        {
            rows[0] = rows[0] with
            {
                Source = rows[0].Source with
                {
                    ArticleRevisionId = rows[0].Source.ArticleRevisionId + 1
                }
            };
        }
        var forged = Construct<ArticlePackageManifestCandidate>(rows,
            fault == "rootDigest" ? new string('b', 64) : original.Manifest.SemanticDigest);
        typeof(ArticlePackageManifestCandidate).GetProperty(nameof(ArticlePackageManifestCandidate.Assets))!.SetValue(forged, forgedCollection);

        Assert.False(ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            forged, inputs, sources, references, inventory, out var result).IsValid);
        Assert.Null(result);
    }

    [Fact]
    public void AssetPlannerChecksAggregateAndIndividualByteBudgetsBeforeCopyOrProjection()
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        byte[] boundary = new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes];
        var sources = Enumerable.Range(1, 9).Select(index => AssetSource(index, boundary)).ToArray();
        var inventory = AssetInventory(inputs, sources);
        var result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, sources, [], inventory, out var plan);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_manifest_asset_collection_byte_budget_exceeded", result.ReasonCode);
        Assert.Null(plan);
        sources = [AssetSource(1, new byte[ArticlePackageAssetMetadataMapper.MaxCandidateAssetBytes + 1])];
        result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, sources, [], AssetInventory(inputs, sources), out plan);
        Assert.Equal("article_package_manifest_asset_collection_byte_budget_exceeded", result.ReasonCode);
        Assert.Null(plan);
    }

    [Theory]
    [InlineData("sources")]
    [InlineData("references")]
    [InlineData("inventory")]
    public void AssetPlannerBoundsAllCallerListsWithoutEnumerationOrCountRereads(string which)
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        var sources = new[] { AssetSource(1, AssetBytes()) };
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var sourceList = new AssetInputList<ArticlePackageAssetCollectionSource>(sources);
        var referenceList = new AssetInputList<ArticlePackageManifestAssetReference>(references);
        var inventoryList = new AssetInputList<ArticlePackageInventoryEntry>(inventory);
        Assert.True(ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs,
            sourceList, referenceList, inventoryList, out _).IsValid);
        Assert.Equal(1, sourceList.CountReads);
        Assert.Equal(1, referenceList.CountReads);
        Assert.Equal(1, inventoryList.CountReads);
        Assert.Equal(sources.Length, sourceList.IndexReads);
        Assert.Equal(references.Length, referenceList.IndexReads);
        Assert.Equal(inventory.Length, inventoryList.IndexReads);
        RejectAssets(inputs,
            which == "sources" ? new AssetInputList<ArticlePackageAssetCollectionSource>(sources, int.MaxValue) : sources,
            which == "references" ? new AssetInputList<ArticlePackageManifestAssetReference>(references, int.MaxValue) : references,
            which == "inventory" ? new AssetInputList<ArticlePackageInventoryEntry>(inventory, int.MaxValue) : inventory);
        RejectAssets(inputs,
            which == "sources" ? new AssetInputList<ArticlePackageAssetCollectionSource>(sources, failIndex: true) : sources,
            which == "references" ? new AssetInputList<ArticlePackageManifestAssetReference>(references, failIndex: true) : references,
            which == "inventory" ? new AssetInputList<ArticlePackageInventoryEntry>(inventory, failIndex: true) : inventory);
    }

    [Fact]
    public void AssetPlannerCancellationBeforeAndDuringFreezeExposesNoPartialPlan()
    {
        ArticlePackageManifestCandidateInput[] inputs = [Input()];
        var sources = new[] { AssetSource(1, AssetBytes()) };
        var references = AssetReferences(inputs, sources[0]);
        var inventory = AssetInventory(inputs, sources);
        var original = CreateAssets(inputs, sources, references, inventory);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        ArticlePackageManifestCandidatePlan? plan = null;
        Assert.Throws<OperationCanceledException>(() => ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(
            inputs, sources, references, inventory, out plan, cancelled.Token));
        Assert.Null(plan);
        Assert.Throws<OperationCanceledException>(() => ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            original.Manifest, inputs, sources, references, inventory, out plan, cancelled.Token));
        Assert.Null(plan);
        using var during = new CancellationTokenSource();
        var cancelling = new AssetInputList<ArticlePackageAssetCollectionSource>(sources, onRead: during.Cancel);
        Assert.Throws<OperationCanceledException>(() => ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(
            inputs, cancelling, references, inventory, out plan, during.Token));
        Assert.Null(plan);
        using var duringBind = new CancellationTokenSource();
        cancelling = new AssetInputList<ArticlePackageAssetCollectionSource>(sources, onRead: duringBind.Cancel);
        Assert.Throws<OperationCanceledException>(() => ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
            original.Manifest, inputs, cancelling, references, inventory, out plan, duringBind.Token));
        Assert.Null(plan);
        using var afterFreeze = new CancellationTokenSource();
        var ordinary = Input(tags: [1]);
        var changed = ordinary.Article with
        {
            TagIds = new AssetInputList<int>([1], onRead: afterFreeze.Cancel)
        };
        var lateInput = new ArticlePackageManifestCandidateInput(changed, ordinary.TitleBinding, ordinary.PropertySnapshot,
            ordinary.PropertyBindings, ordinary.SourceBytes);
        Assert.Throws<OperationCanceledException>(() => ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(
            [lateInput], sources, references, inventory, out plan, afterFreeze.Token));
        Assert.Null(plan);
    }

    private static ArticlePackageManifestCandidatePlan CreateAssets(IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource> sources, IReadOnlyList<ArticlePackageManifestAssetReference> references,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory)
    {
        var result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, sources, references, inventory, out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageManifestCandidatePlan>(plan);
    }

    private static void RejectAssets(IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource>? sources, IReadOnlyList<ArticlePackageManifestAssetReference>? references,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory)
    {
        var result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan(inputs, sources, references, inventory, out var plan);
        Assert.False(result.IsValid);
        Assert.NotNull(result.ReasonCode);
        Assert.Null(plan);
    }

    private static T Construct<T>(params object[] arguments)
    {
        object instance = Activator.CreateInstance(typeof(T), System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic, null, arguments, null)!;
        return (T)instance;
    }

    // Real canonical media/schema controls exercise the production mapper; these are not ledger observations.
    private static byte[] AssetBytes()
        => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZgAAAABJRU5ErkJggg==");

    private static ArticlePackageIdentity AssetIdentity(int number)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Asset,
            $"portable-asset:50000000-0000-4000-8000-{number:x12}", out var identity).IsValid);
        return identity;
    }

    private static ArticlePackageAssetCollectionSource AssetSource(int number, byte[] bytes)
        => new(AssetIdentity(number), new(AssetId.Parse($"60000000-0000-4000-8000-{number:x12}"),
            "public", AssetStorageKey.Parse("content/public/example.png"), "image/png", ".png", bytes.Length,
            Convert.ToHexStringLower(SHA256.HashData(bytes)), 1, 1, 42, ContentAssetState.Active,
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch), bytes);

    private static ArticlePackageManifestAssetReference[] AssetReferences(
        IReadOnlyList<ArticlePackageManifestCandidateInput> inputs, ArticlePackageAssetCollectionSource source)
        => inputs.Select(input => new ArticlePackageManifestAssetReference(input.TitleBinding.PortableArticle, source.PortableAsset)).ToArray();

    private static ArticlePackageInventoryEntry[] AssetInventory(IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageAssetCollectionSource> sources)
        => [InventoryEntry(ArticlePackageInventory.ManifestPath, 1), InventoryEntry(ArticlePackageInventory.ChecksumsPath, 1),
            .. inputs.Select(input => InventoryEntry("articles/" + input.TitleBinding.PortableArticle.FileNameToken + ".md", input.SourceBytes.Length)),
            .. sources.Select(source => InventoryEntry("assets/" + source.PortableAsset.FileNameToken + source.Record.Extension, source.SourceBytes.Length))];

    private static ArticlePackageInventoryEntry InventoryEntry(string path, long size)
        => new(path, ArticlePackageEntryKind.RegularFile, size, size);

    private sealed class AssetInputList<T>(T[] values, int? count = null, bool failIndex = false, Action? onRead = null) : IReadOnlyList<T>
    {
        public int CountReads
        {
            get; private set;
        }
        public int IndexReads
        {
            get; private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? count ?? values.Length : int.MaxValue;
            }
        }
        public T this[int index]
        {
            get
            {
                IndexReads++;
                onRead?.Invoke();
                return failIndex ? throw new IndexOutOfRangeException() : values[index];
            }
        }
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("Bounded indexes required.");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
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
