using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure mapping controls; self-sealed fixtures establish no persistence or current permission receipt.</summary>
public sealed class ArticlePackagePropertyMapperTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly Guid s_option = Id(101);
    private static readonly Guid s_otherOption = Id(102);
    private static readonly ArticlePropertySnapshotCoordinates s_coordinates = new(42, "site-a", 7, 3, 100, 10, 5);

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public void Mapper_ProjectsEightTypesThroughExplicitPortableBindings(ArticlePropertyValueType type)
    {
        ArticlePropertyTypedValue source = Value(type);
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, source)]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        ArticlePackagePropertyMappingCandidate candidate = Map(snapshot, bindings);
        ArticlePackageMappedProperty property = Assert.Single(candidate.Properties);

        Assert.Equal(snapshot.Coordinates, candidate.SourceCoordinates);
        Assert.Equal(snapshot.ContentDigest, candidate.SourceSnapshotDigest);
        Assert.Equal(snapshot.Values[0].ValueDigest, property.SourceValueDigest);
        Assert.Equal(snapshot.Values[0].DefinitionId, property.SourceDefinitionId);
        Assert.Equal(snapshot.Values[0].DefinitionSchemaRevision, property.SourceSchemaRevision);
        Assert.Equal(snapshot.Values[0].DefinitionDigest, property.SourceDefinitionDigest);
        Assert.Equal(bindings.Definitions[0].PortableDefinition, property.PortableDefinition);
        Assert.NotEqual(property.SourceValueDigest, property.PortableValueDigest);
        Assert.True(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, bindings, candidate).IsValid);

        switch (source)
        {
            case ArticlePropertySingleSelectValue:
                Assert.Equal(bindings.Options[0].PortableOption,
                    Assert.IsType<ArticlePackageSingleOptionPropertyProjection>(property.Projection).Option);
                break;
            case ArticlePropertyMultiSelectValue:
                Assert.Equal(bindings.Options.Select(static item => item.PortableOption).OrderBy(static item => item.Value, StringComparer.Ordinal),
                    Assert.IsType<ArticlePackageMultiOptionPropertyProjection>(property.Projection).Options);
                break;
            case ArticlePropertyArticleReferenceValue:
                Assert.Equal(bindings.Articles.Select(static item => item.PortableArticle).OrderBy(static item => item.Value, StringComparer.Ordinal),
                    Assert.IsType<ArticlePackageArticleReferencePropertyProjection>(property.Projection).Articles);
                break;
            default:
                Assert.Equal(source, Assert.IsType<ArticlePackagePrimitivePropertyProjection>(property.Projection).Value);
                break;
        }
    }

    [Fact]
    public void Mapper_PreservesAbsenceFalseZeroEmptyAndDefaultProvenance()
    {
        ArticlePropertyValueEntry[] entries =
        [
            Entry(1, null, ArticlePropertyValuePresence.Missing),
            Entry(2, null, ArticlePropertyValuePresence.Null),
            Entry(3, new ArticlePropertyBooleanValue(false)),
            Entry(4, new ArticlePropertyNumberValue(0)),
            Entry(5, new ArticlePropertyTextValue(string.Empty)),
            Entry(6, new ArticlePropertyMultiSelectValue([])),
            Entry(7, new ArticlePropertyArticleReferenceValue([])),
            Entry(8, new ArticlePropertyBooleanValue(true), defaultApplied: true)
        ];
        ArticlePropertyValueSnapshot snapshot = Snapshot(entries);
        ArticlePackagePropertyMappingCandidate candidate = Map(snapshot, Bindings(snapshot));

        Assert.Equal(ArticlePropertyValuePresence.Missing, candidate.Properties[0].Presence);
        Assert.Null(candidate.Properties[0].Projection);
        Assert.Equal(ArticlePropertyValuePresence.Null, candidate.Properties[1].Presence);
        Assert.Null(candidate.Properties[1].Projection);
        Assert.NotEqual(candidate.Properties[0].PortableValueDigest, candidate.Properties[1].PortableValueDigest);
        Assert.Equal(new ArticlePropertyBooleanValue(false),
            Assert.IsType<ArticlePackagePrimitivePropertyProjection>(candidate.Properties[2].Projection).Value);
        Assert.Equal(new ArticlePropertyNumberValue(0),
            Assert.IsType<ArticlePackagePrimitivePropertyProjection>(candidate.Properties[3].Projection).Value);
        Assert.Equal(new ArticlePropertyTextValue(string.Empty),
            Assert.IsType<ArticlePackagePrimitivePropertyProjection>(candidate.Properties[4].Projection).Value);
        Assert.Empty(Assert.IsType<ArticlePackageMultiOptionPropertyProjection>(candidate.Properties[5].Projection).Options);
        Assert.Empty(Assert.IsType<ArticlePackageArticleReferencePropertyProjection>(candidate.Properties[6].Projection).Articles);
        Assert.True(candidate.Properties[7].DefaultApplied);

        ArticlePropertyValueSnapshot explicitSnapshot = Snapshot([Entry(8, new ArticlePropertyBooleanValue(true))]);
        var explicitBindings = new ArticlePackagePropertyMappingBindings(explicitSnapshot.Coordinates, explicitSnapshot.ContentDigest,
            [new(Id(8), 1, s_digest, candidate.Properties[7].PortableDefinition)], [], []);
        ArticlePackageMappedProperty explicitValue = Assert.Single(Map(explicitSnapshot, explicitBindings).Properties);
        Assert.NotEqual(candidate.Properties[7].PortableValueDigest, explicitValue.PortableValueDigest);
        ArticlePropertyValueSnapshot absent = Snapshot([Entry(1, null, ArticlePropertyValuePresence.Missing)]);
        ArticlePropertyValueSnapshot nullable = Snapshot([Entry(1, null, ArticlePropertyValuePresence.Null)]);
        Assert.NotEqual(Map(absent, Bindings(absent)).Properties[0].PortableValueDigest,
            Map(nullable, Bindings(nullable)).Properties[0].PortableValueDigest);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("revision")]
    [InlineData("digest")]
    [InlineData("wrong-source")]
    public void Mapper_RejectsIncompleteOrDriftedDefinitionClosure(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyTextValue("source"))]);
        ArticlePackagePropertyMappingBindings valid = Bindings(snapshot);
        ArticlePackagePropertyDefinitionBinding definition = valid.Definitions[0];
        ArticlePackagePropertyDefinitionBinding[] definitions = fault switch
        {
            "missing" => [],
            "extra" => [definition, new(Id(2), 1, s_digest, Portable(ArticlePackageIdentityKind.Definition, 2))],
            "revision" => [new(definition.SourceDefinitionId, definition.SourceSchemaRevision + 1,
                definition.SourceDefinitionDigest, definition.PortableDefinition)],
            "digest" => [new(definition.SourceDefinitionId, definition.SourceSchemaRevision,
                new string('b', 64), definition.PortableDefinition)],
            _ => [new(Id(2), definition.SourceSchemaRevision, definition.SourceDefinitionDigest, definition.PortableDefinition)]
        };

        Reject(snapshot, Copy(valid, definitions: definitions));
    }

    [Theory]
    [InlineData("site")]
    [InlineData("owner")]
    [InlineData("article")]
    [InlineData("property-revision")]
    [InlineData("revision")]
    [InlineData("draft")]
    [InlineData("draft-revision")]
    [InlineData("publication")]
    [InlineData("digest")]
    public void Mapper_RejectsEverySourceCoordinateAndSnapshotDigestDrift(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyTextValue("source"))]);
        ArticlePackagePropertyMappingBindings valid = Bindings(snapshot);
        ArticlePropertySnapshotCoordinates coordinates = fault switch
        {
            "site" => s_coordinates with { SiteScope = "site-b" },
            "owner" => s_coordinates with { DefinitionOwnerUserId = 43 },
            "article" => s_coordinates with { ArticleId = 8 },
            "property-revision" => s_coordinates with { PropertyRevision = 4 },
            "revision" => s_coordinates with { ArticleRevisionId = 101 },
            "draft" => s_coordinates with { DraftId = 11 },
            "draft-revision" => s_coordinates with { DraftServerRevision = 6 },
            "publication" => s_coordinates with { DraftId = null, DraftServerRevision = null, PublicationId = 12 },
            _ => s_coordinates
        };

        Reject(snapshot, Copy(valid, coordinates: coordinates,
            sourceDigest: fault == "digest" ? new string('b', 64) : valid.SourceSnapshotDigest));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("wrong-definition")]
    [InlineData("wrong-option")]
    public void Mapper_RejectsIncompleteOrMisboundOptionClosure(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertySingleSelectValue(s_option))]);
        ArticlePackagePropertyMappingBindings valid = Bindings(snapshot);
        ArticlePackagePropertyOptionBinding option = valid.Options[0];
        ArticlePackagePropertyOptionBinding[] options = fault switch
        {
            "missing" => [],
            "extra" => [option, new(option.SourceDefinitionId, s_otherOption, Portable(ArticlePackageIdentityKind.Option, 999))],
            "wrong-definition" => [new(Id(2), option.SourceOptionId, option.PortableOption)],
            _ => [new(option.SourceDefinitionId, s_otherOption, option.PortableOption)]
        };

        Reject(snapshot, Copy(valid, options: options));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("identity")]
    [InlineData("denied")]
    [InlineData("unknown-permission")]
    [InlineData("deleted")]
    [InlineData("archived")]
    [InlineData("missing-revision")]
    [InlineData("zero-revision")]
    [InlineData("draft-lifecycle")]
    [InlineData("heading")]
    public void Mapper_RejectsUnusableReferenceBindingsAndMalformedCanonicalFacts(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyArticleReferenceValue([8]))]);
        ArticlePackagePropertyMappingBindings valid = Bindings(snapshot);
        ArticlePackagePropertyArticleBinding article = valid.Articles[0];
        ArticleRelationTargetFacts facts = fault switch
        {
            "identity" => article.TargetFacts with { TargetIdentity = new(Portable(ArticlePackageIdentityKind.Article, 9).Value!, ArticleRelationTargetKind.Article, null, null) },
            "denied" => article.TargetFacts with { Permission = ArticleRelationPermissionState.Denied },
            "unknown-permission" => article.TargetFacts with { Permission = ArticleRelationPermissionState.Unknown },
            "deleted" => article.TargetFacts with { Lifecycle = ArticleRelationLifecycleState.Deleted },
            "archived" => article.TargetFacts with { Lifecycle = ArticleRelationLifecycleState.Archived },
            "missing-revision" => article.TargetFacts with { RevisionIdentity = null },
            "zero-revision" => article.TargetFacts with { RevisionNumber = 0 },
            "draft-lifecycle" => article.TargetFacts with { RevisionKind = ArticleRelationRevisionKind.Draft },
            "heading" => article.TargetFacts with { TargetIdentity = new(article.PortableArticle.Value!, ArticleRelationTargetKind.Heading, "heading:one", null) },
            _ => article.TargetFacts
        };
        ArticlePackagePropertyArticleBinding[] articles = fault switch
        {
            "missing" => [],
            "extra" => [article, ArticleBinding(9)],
            _ => [new(article.SourceArticleId, article.PortableArticle, facts)]
        };

        Reject(snapshot, Copy(valid, articles: articles));
    }

    [Fact]
    public void Mapper_BindingOrderDoesNotChangePortableOrMappingDigests()
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([
            Entry(1, new ArticlePropertyMultiSelectValue([s_option, s_otherOption])),
            Entry(2, new ArticlePropertyArticleReferenceValue([8, 9]))
        ]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        ArticlePackagePropertyMappingCandidate ordered = Map(snapshot, bindings);
        ArticlePackagePropertyMappingCandidate permuted = Map(snapshot, Copy(bindings,
            definitions: bindings.Definitions.Reverse().ToArray(),
            options: bindings.Options.Reverse().ToArray(), articles: bindings.Articles.Reverse().ToArray()));

        Assert.Equal(ordered.MappingDigest, permuted.MappingDigest);
        Assert.Equal(ordered.Properties.Select(static property => property.PortableValueDigest),
            permuted.Properties.Select(static property => property.PortableValueDigest));
    }

    [Theory]
    [InlineData("definition-duplicate")]
    [InlineData("definition-alias")]
    [InlineData("option-duplicate")]
    [InlineData("option-alias")]
    [InlineData("article-duplicate")]
    [InlineData("article-alias")]
    public void Mapper_RejectsDuplicateSourcesAndPortableAliases(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([
            Entry(1, new ArticlePropertyMultiSelectValue([s_option, s_otherOption])),
            Entry(2, new ArticlePropertyArticleReferenceValue([8, 9]))
        ]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        ArticlePackagePropertyDefinitionBinding[] definitions = bindings.Definitions.ToArray();
        ArticlePackagePropertyOptionBinding[] options = bindings.Options.ToArray();
        ArticlePackagePropertyArticleBinding[] articles = bindings.Articles.ToArray();
        switch (fault)
        {
            case "definition-duplicate":
                definitions[1] = definitions[0];
                break;
            case "definition-alias":
                definitions[1] = new(definitions[1].SourceDefinitionId, definitions[1].SourceSchemaRevision,
                    definitions[1].SourceDefinitionDigest, definitions[0].PortableDefinition);
                break;
            case "option-duplicate":
                options[1] = options[0];
                break;
            case "option-alias":
                options[1] = new(options[1].SourceDefinitionId, options[1].SourceOptionId, options[0].PortableOption);
                break;
            case "article-duplicate":
                articles[1] = articles[0];
                break;
            case "article-alias":
                articles[1] = new(articles[1].SourceArticleId, articles[0].PortableArticle, articles[0].TargetFacts);
                break;
        }

        Reject(snapshot, Copy(bindings, definitions: definitions, options: options, articles: articles));
    }

    [Theory]
    [InlineData("duplicate-options")]
    [InlineData("zero-option")]
    [InlineData("duplicate-articles")]
    [InlineData("zero-article")]
    [InlineData("negative-article")]
    public void Mapper_RejectsMalformedSourceSetsEvenWithFreshlyRecomputedSourceDigest(string fault)
    {
        ArticlePropertyTypedValue value = fault switch
        {
            "duplicate-options" => new ArticlePropertyMultiSelectValue([s_option, s_option]),
            "zero-option" => new ArticlePropertySingleSelectValue(Guid.Empty),
            "duplicate-articles" => new ArticlePropertyArticleReferenceValue([8, 8]),
            "zero-article" => new ArticlePropertyArticleReferenceValue([0]),
            _ => new ArticlePropertyArticleReferenceValue([-1])
        };
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, value)]);
        var bindings = new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest,
            [new(snapshot.Values[0].DefinitionId, 1, s_digest, Portable(ArticlePackageIdentityKind.Definition, 1))], [], []);

        Reject(snapshot, bindings);
    }

    [Fact]
    public void Mapper_DefinitionAndProjectedIdentityBudgetsAllowBoundaryAndRejectOverflow()
    {
        ArticlePropertyValueSnapshot maximumDefinitions = Snapshot(Enumerable.Range(1, 1000)
            .Select(static index => Entry(index, new ArticlePropertyNumberValue(0))));
        Assert.Equal(1000, Map(maximumDefinitions, Bindings(maximumDefinitions)).Properties.Count);
        ArticlePropertyValueSnapshot overflowDefinitions = Snapshot(Enumerable.Range(1, 1001)
            .Select(static index => Entry(index, new ArticlePropertyNumberValue(0))));
        Reject(overflowDefinitions, new ArticlePackagePropertyMappingBindings(overflowDefinitions.Coordinates,
            overflowDefinitions.ContentDigest, [], [], []));

        long[] references = Enumerable.Range(8, 1000).Select(static index => (long)index).ToArray();
        ArticlePropertyValueSnapshot maximumIdentities = Snapshot(Enumerable.Range(1, 20)
            .Select(index => Entry(index, new ArticlePropertyArticleReferenceValue(references))));
        ArticlePackagePropertyMappingCandidate maximum = Map(maximumIdentities, Bindings(maximumIdentities));
        Assert.Equal(20000, maximum.Properties.Sum(static property =>
            Assert.IsType<ArticlePackageArticleReferencePropertyProjection>(property.Projection).Articles.Count));
        ArticlePropertyValueSnapshot overflowIdentities = Snapshot(Enumerable.Range(1, 21)
            .Select(index => Entry(index, new ArticlePropertyArticleReferenceValue(references))));
        Reject(overflowIdentities, Bindings(overflowIdentities));
    }

    [Theory]
    [InlineData("options")]
    [InlineData("articles")]
    public void Mapper_RejectsPerValueCollectionBudgetOverflow(string kind)
    {
        ArticlePropertyTypedValue value = kind == "options"
            ? new ArticlePropertyMultiSelectValue(Enumerable.Range(1, 1001).Select(Id))
            : new ArticlePropertyArticleReferenceValue(Enumerable.Range(8, 1001).Select(static id => (long)id));
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, value)]);

        Reject(snapshot, Bindings(snapshot));
    }

    [Fact]
    public void Contracts_RejectZeroBindingsWrongKindsAndOwnedCopyBudgetOverflow()
    {
        ArticlePackageIdentity definition = Portable(ArticlePackageIdentityKind.Definition, 1);
        ArticlePackageIdentity option = Portable(ArticlePackageIdentityKind.Option, 1);
        ArticlePackageIdentity article = Portable(ArticlePackageIdentityKind.Article, 8);
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyDefinitionBinding(Guid.Empty, 1, s_digest, definition));
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyDefinitionBinding(Id(1), 0, s_digest, definition));
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyDefinitionBinding(Id(1), 1, s_digest, option));
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyOptionBinding(Id(1), Guid.Empty, option));
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyArticleBinding(0, article, ArticleBinding(8).TargetFacts));

        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyTextValue("one"))]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        Assert.Throws<ArgumentException>(() => Copy(bindings,
            definitions: Enumerable.Repeat(bindings.Definitions[0], 1001).ToArray()));
        var optionBinding = new ArticlePackagePropertyOptionBinding(Id(1), s_option, option);
        Assert.Throws<ArgumentException>(() => Copy(bindings,
            options: Enumerable.Repeat(optionBinding, 20001).ToArray()));
        Assert.Throws<ArgumentException>(() => Copy(bindings,
            articles: Enumerable.Repeat(ArticleBinding(8), 10001).ToArray()));
        Assert.Throws<ArgumentException>(() => new ArticlePackageMultiOptionPropertyProjection(Enumerable.Repeat(option, 1001).ToArray()));
        Assert.Throws<ArgumentException>(() => new ArticlePackageArticleReferencePropertyProjection(Enumerable.Repeat(article, 1001).ToArray()));
    }

    [Fact]
    public void Contracts_HoldImmutableCopiesAgainstCallerMutation()
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyMultiSelectValue([s_option, s_otherOption]))]);
        ArticlePackagePropertyMappingBindings original = Bindings(snapshot);
        ArticlePackagePropertyDefinitionBinding[] definitions = original.Definitions.ToArray();
        ArticlePackagePropertyOptionBinding[] options = original.Options.ToArray();
        ArticlePackagePropertyArticleBinding[] articles = [ArticleBinding(8)];
        var held = new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest, definitions, options, articles);
        definitions[0] = new(Id(2), 1, s_digest, Portable(ArticlePackageIdentityKind.Definition, 2));
        options[0] = new(Id(2), s_otherOption, Portable(ArticlePackageIdentityKind.Option, 999));
        articles[0] = ArticleBinding(9);
        Assert.Equal(original.Definitions[0], held.Definitions[0]);
        Assert.Equal(original.Options[0], held.Options[0]);
        Assert.Equal(8, held.Articles[0].SourceArticleId);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackagePropertyOptionBinding>)held.Options)[0] = options[0]);

        ArticlePackageIdentity[] identities = [Portable(ArticlePackageIdentityKind.Option, 1)];
        var projection = new ArticlePackageMultiOptionPropertyProjection(identities);
        identities[0] = Portable(ArticlePackageIdentityKind.Option, 2);
        Assert.NotEqual(identities[0], projection.Options[0]);
        ArticlePackagePropertyMappingCandidate candidate = Map(snapshot, original);
        ArticlePackageMappedProperty[] rows = candidate.Properties.ToArray();
        var copy = new ArticlePackagePropertyMappingCandidate(candidate.SourceCoordinates, candidate.SourceSnapshotDigest, rows, candidate.MappingDigest);
        rows[0] = new(rows[0].SourceDefinitionId, rows[0].SourceSchemaRevision, rows[0].SourceDefinitionDigest,
            rows[0].PortableDefinition, rows[0].SourceValueDigest, rows[0].Presence, rows[0].DefaultApplied,
            new string('b', 64), rows[0].Projection);
        Assert.Equal(candidate.Properties[0], copy.Properties[0]);
        Assert.True(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, original, copy).IsValid);
    }

    [Fact]
    public void Mapper_DifferentSourceCoordinatesRetainPortableValueButChangeMappingDigest()
    {
        ArticlePropertyValueSnapshot first = Snapshot([Entry(1, new ArticlePropertyTextValue("same"))]);
        ArticlePropertyValueSnapshot second = Snapshot(first.Values, s_coordinates with
        {
            ArticleRevisionId = 101
        });
        ArticlePackagePropertyMappingCandidate left = Map(first, Bindings(first));
        ArticlePackagePropertyMappingCandidate right = Map(second, Bindings(second));

        Assert.Equal(left.Properties[0].PortableValueDigest, right.Properties[0].PortableValueDigest);
        Assert.NotEqual(left.SourceSnapshotDigest, right.SourceSnapshotDigest);
        Assert.NotEqual(left.MappingDigest, right.MappingDigest);
    }

    [Fact]
    public void Mapper_SourceSetPermutationPreservesPortableSemanticsAndRetainsSourceDigestDifference()
    {
        ArticlePropertyValueSnapshot first = Snapshot([
            Entry(1, new ArticlePropertyMultiSelectValue([s_option, s_otherOption])),
            Entry(2, new ArticlePropertyArticleReferenceValue([8, 9]))
        ]);
        ArticlePropertyValueSnapshot second = Snapshot([
            Entry(1, new ArticlePropertyMultiSelectValue([s_otherOption, s_option])),
            Entry(2, new ArticlePropertyArticleReferenceValue([9, 8]))
        ]);
        ArticlePackagePropertyMappingBindings firstBindings = Bindings(first);
        ArticlePackagePropertyMappingBindings secondBindings = Copy(firstBindings, sourceDigest: second.ContentDigest);
        ArticlePackagePropertyMappingCandidate left = Map(first, firstBindings);
        ArticlePackagePropertyMappingCandidate right = Map(second, secondBindings);

        Assert.Equal(left.Properties.Select(static row => row.PortableValueDigest), right.Properties.Select(static row => row.PortableValueDigest));
        Assert.NotEqual(left.SourceSnapshotDigest, right.SourceSnapshotDigest);
        Assert.NotEqual(left.MappingDigest, right.MappingDigest);
    }

    [Fact]
    public void Validator_BindsCanonicalReferenceFactsIncludingRevisionAndPermission()
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyArticleReferenceValue([8]))]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        ArticlePackagePropertyMappingCandidate candidate = Map(snapshot, bindings);
        ArticlePackagePropertyArticleBinding article = bindings.Articles[0];
        var nextRevision = new ArticlePackagePropertyArticleBinding(article.SourceArticleId, article.PortableArticle,
            article.TargetFacts with
            {
                RevisionIdentity = "revision:next",
                RevisionNumber = 2
            });
        ArticlePackagePropertyMappingBindings changed = Copy(bindings, articles: [nextRevision]);
        ArticlePackagePropertyMappingCandidate next = Map(snapshot, changed);

        Assert.Equal(candidate.Properties[0].PortableValueDigest, next.Properties[0].PortableValueDigest);
        Assert.NotEqual(candidate.MappingDigest, next.MappingDigest);
        Assert.False(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, changed, candidate).IsValid);
        ArticlePackagePropertyMappingBindings denied = Copy(bindings, articles: [new(article.SourceArticleId,
            article.PortableArticle, article.TargetFacts with { Permission = ArticleRelationPermissionState.Denied })]);
        Assert.False(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, denied, candidate).IsValid);
    }

    [Fact]
    public void Mapper_RejectsUnsortedOrDuplicateDefinitionSourceSnapshots()
    {
        ArticlePropertyValueEntry first = Entry(1, new ArticlePropertyTextValue("first"));
        ArticlePropertyValueEntry second = Entry(2, new ArticlePropertyTextValue("second"));
        ArticlePropertyValueSnapshot valid = Snapshot([first, second]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(valid);
        ArticlePropertyValueEntry[] reversed = [second, first];
        var unsorted = new ArticlePropertyValueSnapshot(1, valid.Coordinates, reversed,
            ArticlePropertyValueDigest.ComputeSnapshot(valid.Coordinates, reversed));
        Reject(unsorted, Copy(bindings, sourceDigest: unsorted.ContentDigest));
        ArticlePropertyValueEntry[] duplicates = [first, first];
        var duplicate = new ArticlePropertyValueSnapshot(1, valid.Coordinates, duplicates,
            ArticlePropertyValueDigest.ComputeSnapshot(valid.Coordinates, duplicates));
        Reject(duplicate, Copy(bindings, sourceDigest: duplicate.ContentDigest));
    }

    [Fact]
    public void Mapper_SelfConsistentUnobservedInputRemainsOnlyACandidate()
    {
        ArticlePropertyValueSnapshot unobserved = Snapshot([Entry(1, new ArticlePropertyTextValue("self-sealed input"))]);
        ArticlePackagePropertyMappingCandidate candidate = Map(unobserved, Bindings(unobserved));

        Assert.Equal(unobserved.ContentDigest, candidate.SourceSnapshotDigest);
        Assert.Equal(unobserved.Coordinates, candidate.SourceCoordinates);
        Assert.NotEqual(unobserved.ContentDigest, candidate.MappingDigest);
        // This synchronous pure API has no reader, writer, receipt issuer or authorization provider.
        Assert.True(ArticlePackagePropertyMapper.ValidateCandidate(unobserved, Bindings(unobserved), candidate).IsValid);
    }

    [Theory]
    [InlineData("portable-definition")]
    [InlineData("source-value-digest")]
    [InlineData("portable-value-digest")]
    [InlineData("payload")]
    [InlineData("default-origin")]
    [InlineData("mapping-digest")]
    public void Validator_RecomputesCandidateInsteadOfTrustingTamperedRowsOrDigests(string fault)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyBooleanValue(false))]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        ArticlePackagePropertyMappingCandidate candidate = Map(snapshot, bindings);
        ArticlePackageMappedProperty row = candidate.Properties[0];
        var tampered = new ArticlePackageMappedProperty(row.SourceDefinitionId, row.SourceSchemaRevision,
            row.SourceDefinitionDigest,
            fault == "portable-definition" ? Portable(ArticlePackageIdentityKind.Definition, 999) : row.PortableDefinition,
            fault == "source-value-digest" ? new string('b', 64) : row.SourceValueDigest,
            row.Presence, fault == "default-origin" || row.DefaultApplied,
            fault == "portable-value-digest" ? new string('b', 64) : row.PortableValueDigest,
            fault == "payload" ? new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyBooleanValue(true)) : row.Projection);
        var altered = new ArticlePackagePropertyMappingCandidate(candidate.SourceCoordinates,
            candidate.SourceSnapshotDigest, [tampered],
            fault == "mapping-digest" ? new string('b', 64) : candidate.MappingDigest);

        Assert.False(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, bindings, altered).IsValid);
    }

    [Fact]
    public void Mapper_RejectsCorruptSnapshotAndMissingInputsWithoutCandidate()
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, new ArticlePropertyNumberValue(0))]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        var corrupt = new ArticlePropertyValueSnapshot(snapshot.SchemaVersion, snapshot.Coordinates,
            snapshot.Values, new string('b', 64));

        Reject(corrupt, bindings);
        Assert.False(ArticlePackagePropertyMapper.TryMapCandidate(null, bindings, out var missingSnapshot).IsValid);
        Assert.Null(missingSnapshot);
        Assert.False(ArticlePackagePropertyMapper.TryMapCandidate(snapshot, null, out var missingBindings).IsValid);
        Assert.Null(missingBindings);
        Assert.False(ArticlePackagePropertyMapper.ValidateCandidate(snapshot, bindings, null).IsValid);
    }

    [Theory]
    [InlineData("text")]
    [InlineData("url")]
    public void Mapper_RejectsMalformedUtf16InsteadOfDigestingReplacementBytes(string kind)
    {
        ArticlePropertyTypedValue value = kind == "text"
            ? new ArticlePropertyTextValue("\uD800")
            : new ArticlePropertyUrlValue("https://example.com/\uD800");
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, value)]);

        Reject(snapshot, Bindings(snapshot));
    }

    private static ArticlePackagePropertyMappingCandidate Map(
        ArticlePropertyValueSnapshot snapshot,
        ArticlePackagePropertyMappingBindings bindings)
    {
        ArticlePackagePropertyMappingResult result = ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackagePropertyMappingCandidate>(candidate);
    }

    private static void Reject(ArticlePropertyValueSnapshot snapshot, ArticlePackagePropertyMappingBindings bindings)
    {
        ArticlePackagePropertyMappingResult result = ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out var candidate);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        Assert.Null(candidate);
    }

    private static ArticlePropertyValueEntry Entry(int index, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present, bool defaultApplied = false)
    {
        var input = new ArticlePropertyValueInput(Id(index), 1, s_digest, presence, value);
        return new ArticlePropertyValueEntry(input.DefinitionId, input.DefinitionSchemaRevision,
            input.DefinitionDigest, input.Presence, input.Value,
            ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
    }

    private static ArticlePropertyValueSnapshot Snapshot(IEnumerable<ArticlePropertyValueEntry> values,
        ArticlePropertySnapshotCoordinates? coordinates = null)
    {
        ArticlePropertyValueEntry[] held = values.OrderBy(static value => value.DefinitionId).ToArray();
        ArticlePropertySnapshotCoordinates source = coordinates ?? s_coordinates;
        return new ArticlePropertyValueSnapshot(1, source, held, ArticlePropertyValueDigest.ComputeSnapshot(source, held));
    }

    private static ArticlePackagePropertyMappingBindings Bindings(ArticlePropertyValueSnapshot snapshot)
    {
        ArticlePackagePropertyDefinitionBinding[] definitions = snapshot.Values.Select((value, index) =>
            new ArticlePackagePropertyDefinitionBinding(value.DefinitionId, value.DefinitionSchemaRevision,
                value.DefinitionDigest, Portable(ArticlePackageIdentityKind.Definition, index + 1))).ToArray();
        ArticlePackagePropertyOptionBinding[] options = snapshot.Values.SelectMany((value, index) =>
            OptionIds(value.Value).Select((id, optionIndex) => new ArticlePackagePropertyOptionBinding(
                value.DefinitionId, id, Portable(ArticlePackageIdentityKind.Option, index * 1000 + optionIndex + 1)))).ToArray();
        ArticlePackagePropertyArticleBinding[] articles = snapshot.Values
            .SelectMany(static value => value.Value is ArticlePropertyArticleReferenceValue references ? references.ArticleIds : [])
            .Distinct().Order().Select(ArticleBinding).ToArray();
        return new ArticlePackagePropertyMappingBindings(snapshot.Coordinates, snapshot.ContentDigest, definitions, options, articles);
    }

    private static ArticlePackagePropertyMappingBindings Copy(ArticlePackagePropertyMappingBindings original,
        IReadOnlyList<ArticlePackagePropertyDefinitionBinding>? definitions = null,
        IReadOnlyList<ArticlePackagePropertyOptionBinding>? options = null,
        IReadOnlyList<ArticlePackagePropertyArticleBinding>? articles = null,
        ArticlePropertySnapshotCoordinates? coordinates = null, string? sourceDigest = null)
        => new(coordinates ?? original.SourceCoordinates, sourceDigest ?? original.SourceSnapshotDigest,
            definitions ?? original.Definitions, options ?? original.Options, articles ?? original.Articles);

    private static IEnumerable<Guid> OptionIds(ArticlePropertyTypedValue? value)
        => value switch
        {
            ArticlePropertySingleSelectValue single => [single.OptionId],
            ArticlePropertyMultiSelectValue multiple => multiple.OptionIds,
            _ => []
        };

    private static ArticlePackagePropertyArticleBinding ArticleBinding(long sourceId)
        => new(sourceId, Portable(ArticlePackageIdentityKind.Article, checked((int)sourceId)),
            new ArticleRelationTargetFacts(new ArticleRelationTargetIdentity(Portable(ArticlePackageIdentityKind.Article, checked((int)sourceId)).Value!,
                ArticleRelationTargetKind.Article, null, null), $"revision:{sourceId}", 1,
                ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published,
                ArticleRelationPermissionState.Allowed));

    private static ArticlePackageIdentity Portable(ArticlePackageIdentityKind kind, int index)
    {
        string prefix = kind switch
        {
            ArticlePackageIdentityKind.Article => "article:",
            ArticlePackageIdentityKind.Definition => "portable-definition:",
            ArticlePackageIdentityKind.Option => "portable-option:",
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
        Assert.True(ArticlePackageIdentity.TryCreate(kind, prefix + Id(index).ToString("D"), out var identity).IsValid);
        return identity;
    }

    private static Guid Id(int index)
        => Guid.Parse($"20000000-0000-4000-8000-{index:x12}");

    private static ArticlePropertyTypedValue Value(ArticlePropertyValueType type)
        => type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue("正文 e\u0301 😀"),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(new DateTime(2026, 10, 8, 12, 0, 0, DateTimeKind.Utc)),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(s_option),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([s_option, s_otherOption]),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([8, 9]),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/exact?x=1"),
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };
}
