using System.Collections.Immutable;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual index/projection/source parity controls; these do not qualify a production adapter or query executor.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchPropertyProducerTests
{
    private static readonly Guid s_definitionId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid s_optionId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly DateTime s_instant = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task All_Canonical_Types_Reach_The_Actual_Index_And_Independent_Verifier(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        ArticlePropertyTypedValue value = Value(type);
        AuthorSearchIndexArticleSource article = Article(definition, value);
        var source = new Source(article);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await Read(index);
        AuthorSearchIndexedArticle actual = snapshot.Articles[1];
        Assert.Equal(article.PropertyValues!.ContentDigest, actual.PropertySnapshotDigest);
        Assert.Equal(article.PropertyValues.Coordinates, actual.PropertyCoordinates);
        Assert.Same(value, actual.PropertyValues[s_definitionId].Entry.Value);
        Assert.Single(actual.PropertyValues);
        AuthorSearchIndexPostingPage postings = await index.ReadPostingsAsync(42, "primary", index.IndexInstanceId,
            snapshot.IndexGeneration, "needle", 0, 10);
        Assert.Single(postings.Postings);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source);
    }

    [Fact]
    public async Task Indexed_Exact_Zero_Has_Actual_Positive_And_Negative_Canonical_Comparisons()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var source = new Source(Article(definition, new ArticlePropertyNumberValue(0)));
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchProjectedPropertyValue actual = (await Read(index)).Articles[1].PropertyValues[s_definitionId];
        Assert.True(AuthorSearchPropertyValueProjection.Matches(definition, actual,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)])));
        Assert.False(AuthorSearchPropertyValueProjection.Matches(definition, actual,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(1)])));
    }

    [Fact]
    public async Task Bound_Canonical_Text_Field_Produces_Real_Property_Postings_And_Rejects_Wrong_Text()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        AuthorSearchIndexArticleSource article = Article(definition, new ArticlePropertyTextValue("needle value"), propertyField: true);
        var source = new Source(article);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await Read(index);
        AuthorSearchIndexPostingPage page = await index.ReadPostingsAsync(42, "primary", index.IndexInstanceId,
            snapshot.IndexGeneration, "value", 0, 10);
        AuthorSearchIndexPosting hit = Assert.Single(page.Postings);
        Assert.Equal(AuthorSearchFieldKind.Property, hit.Field);
        Assert.Equal(7, hit.Source.Utf16Start);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source);
        AuthorSearchDocument document = article.Fields[0].Document;
        source.Articles = [article with
        {
            Fields = [Field("unrelated", document.Identity, document.Field with
            {
                ContentDigest = AuthorFullTextSearchContract.Digest("unrelated")
            })]
        }];
        Assert.Equal("author_search_property_field_serialization_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
    }

    [Theory]
    [InlineData("definition-digest")]
    [InlineData("value-digest")]
    [InlineData("snapshot-digest")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("duplicate")]
    [InlineData("entry-tamper")]
    public async Task Actual_Producer_Rejects_Digest_Coordinate_And_Field_Binding_Tamper(string mutation)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        AuthorSearchIndexArticleSource article = Article(definition, new ArticlePropertyTextValue("needle"), propertyField: true);
        ArticlePropertyValueSnapshot values = article.PropertyValues!;
        if (mutation is "definition-digest" or "value-digest")
        {
            AuthorSearchFieldReference field = article.Fields[0].Document.Field;
            field = mutation == "definition-digest" ? field with
            {
                DefinitionDigest = new string('a', 64)
            }
                : field with
                {
                    PropertyValueDigest = new string('a', 64)
                };
            article = article with
            {
                Fields = [Field("needle", article.Fields[0].Document.Identity, field)]
            };
        }
        else if (mutation == "snapshot-digest")
        {
            article = article with
            {
                PropertyValues = new(values.SchemaVersion, values.Coordinates, values.Values, new string('a', 64))
            };
        }
        else
        {
            ArticlePropertySnapshotCoordinates coordinates = mutation switch
            {
                "article" => values.Coordinates with { ArticleId = 2 },
                "revision" => values.Coordinates with { ArticleRevisionId = 2 },
                "owner" => values.Coordinates with { DefinitionOwnerUserId = 43 },
                "site" => values.Coordinates with { SiteScope = "other" },
                _ => values.Coordinates
            };
            ArticlePropertyValueEntry[] entries = mutation == "duplicate" ? [values.Values[0], values.Values[0]]
                : mutation == "entry-tamper" ? [values.Values[0] with { Value = new ArticlePropertyTextValue("changed") }]
                : [.. values.Values];
            article = article with
            {
                PropertyValues = Snapshot(coordinates, entries)
            };
        }
        using var index = new AuthorFullTextSearchIndex(new Source(article), 42, "primary");
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index));
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
        Assert.Throws<AuthorSearchContractException>(() => index.RequireCurrentGeneration());
    }

    [Fact]
    public async Task Typed_Only_Changes_Replace_The_Complete_Generation_And_Preserve_Old_Snapshots()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var source = new Source(Article(definition, new ArticlePropertyNumberValue(0)),
            Article(definition, new ArticlePropertyNumberValue(10), articleId: 2));
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot old = await Read(index);
        string oldDigest = index.SemanticDigest();
        source.Generation = 2;
        source.Articles = [Article(definition, new ArticlePropertyNumberValue(1), sequence: 2),
            Article(definition, new ArticlePropertyNumberValue(20), articleId: 2, sequence: 2)];
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.PropertyChange);
        AuthorSearchIndexReadSnapshot current = await Read(index);
        Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(old.Articles[1].PropertyValues[s_definitionId].Entry.Value).Number);
        Assert.Equal(1, Assert.IsType<ArticlePropertyNumberValue>(current.Articles[1].PropertyValues[s_definitionId].Entry.Value).Number);
        Assert.Equal(20, Assert.IsType<ArticlePropertyNumberValue>(current.Articles[2].PropertyValues[s_definitionId].Entry.Value).Number);
        Assert.NotEqual(oldDigest, index.SemanticDigest());
        Assert.Equal(2, current.SourceGeneration);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(current, source);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => index.ReadSnapshotAsync(42, "primary", old.IndexInstanceId, old.IndexGeneration));
        string incrementalDigest = index.SemanticDigest();
        await Rebuild(index);
        Assert.Equal(incrementalDigest, index.SemanticDigest());
    }

    [Fact]
    public async Task Verifier_Rejects_Source_And_Resealed_Indexed_Value_Tamper()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var source = new Source(Article(definition, new ArticlePropertyNumberValue(0)));
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await Read(index);
        AuthorSearchIndexedArticle article = snapshot.Articles[1];
        AuthorSearchProjectedPropertyValue value = article.PropertyValues[s_definitionId];
        AuthorSearchIndexReadSnapshot forged = snapshot with
        {
            Articles = snapshot.Articles.SetItem(1, article with
            {
                PropertyValues = article.PropertyValues.SetItem(s_definitionId, value with
                {
                    Entry = Entry(definition, new ArticlePropertyNumberValue(1))
                })
            })
        };
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => AuthorFullTextSearchIndexVerifier.VerifyAsync(forged, source));
        source.Articles = [Article(definition, new ArticlePropertyNumberValue(1))];
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source));
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    [InlineData(ArticlePropertyValuePresence.Present)]
    public async Task Canonical_Presence_Is_Preserved_And_Unavailable_Is_Not_Missing(ArticlePropertyValuePresence presence)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        AuthorSearchIndexArticleSource article = Article(definition, presence == ArticlePropertyValuePresence.Present
            ? new ArticlePropertyNumberValue(0) : null, presence: presence);
        var source = new Source(article);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        Assert.Equal(presence, (await Read(index)).Articles[1].PropertyValues[s_definitionId].Entry.Presence);
        source.Articles = [article with { PropertyValues = null }];
        await Rebuild(index);
        AuthorSearchIndexedArticle unavailable = (await Read(index)).Articles[1];
        Assert.Null(unavailable.PropertyCoordinates);
        Assert.Null(unavailable.PropertySnapshotDigest);
        Assert.Empty(unavailable.PropertyValues);
    }

    [Fact]
    public async Task Nonsearchable_Values_Are_Not_Retained_And_Nonempty_References_Stay_Unadmitted()
    {
        ArticlePropertyDefinition definition = Seal(Definition(ArticlePropertyValueType.Number) with
        {
            SearchEligible = false
        });
        var source = new Source(Article(definition, new ArticlePropertyNumberValue(0)));
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        Assert.Empty((await Read(index)).Articles[1].PropertyValues);
        definition = Definition(ArticlePropertyValueType.ArticleReference);
        source.Articles = [Article(definition, new ArticlePropertyArticleReferenceValue([7]))];
        Assert.Equal("author_search_property_reference_authority_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
    }

    [Fact]
    public async Task Undefined_Number_Field_Serialization_Is_Not_Invented()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var source = new Source(Article(definition, new ArticlePropertyNumberValue(0), propertyField: true));
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        Assert.Equal("author_search_property_field_serialization_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
    }

    [Fact]
    public async Task Property_Postings_Require_An_Actual_Canonical_Snapshot_And_Field_Binding()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        AuthorSearchIndexArticleSource article = Article(definition, new ArticlePropertyTextValue("needle"), propertyField: true);
        AuthorSearchIndexFieldSource field = article.Fields[0];
        article = article with
        {
            PropertyValues = null,
            Fields = [Field(field.RawSource, field.Document.Identity, field.Document.Field with
            {
                DefinitionDigest = null,
                PropertyValueDigest = null
            })]
        };
        using var index = new AuthorFullTextSearchIndex(new Source(article), 42, "primary");
        Assert.Equal("author_search_property_snapshot_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
    }

    [Fact]
    public async Task Typed_Character_Cost_Is_Charged_To_The_Original_Batch_Budget()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        AuthorSearchIndexArticleSource article = Article(definition,
            new ArticlePropertyTextValue(new string('a', AuthorFullTextSearchIndex.MaxBatchSourceCharacters + 1)));
        using var index = new AuthorFullTextSearchIndex(new Source(article), 42, "primary");
        Assert.Equal("author_search_source_batch_budget_exceeded",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
        Assert.Equal(AuthorSearchIndexStatus.RebuildRequired, index.Status);
    }

    [Fact]
    public async Task Producer_And_Verifier_Enforce_The_Same_Cumulative_Typed_Storage_Budget()
    {
        ArticlePropertyDefinition template = Definition(ArticlePropertyValueType.Number);
        ArticlePropertyDefinition[] definitions = [.. Enumerable.Range(1, 1_000).Select(number => Seal(template with
        {
            DefinitionId = Guid.Parse($"00000000-0000-0000-0000-{number:D12}"),
            MachineKey = $"property{number}"
        }))];
        var entries = definitions.Select(definition => Entry(definition, new ArticlePropertyNumberValue(0))).ToArray();
        var projected = definitions.Zip(entries).ToImmutableSortedDictionary(static pair => pair.First.DefinitionId,
            static pair => AuthorSearchPropertyValueProjection.Project(pair.First, pair.Second));
        var originals = new List<AuthorSearchIndexArticleSource>();
        var candidates = ImmutableSortedDictionary.CreateBuilder<int, AuthorSearchIndexedArticle>();
        for (int articleId = 1; articleId <= 100; articleId++)
        {
            AuthorSearchIndexArticleSource article = Article(template, new ArticlePropertyNumberValue(0), articleId: articleId);
            ArticlePropertyValueSnapshot values = Snapshot(new(42, "primary", articleId, 1, 1), entries);
            article = article with
            {
                Definitions = definitions.ToDictionary(static definition => definition.DefinitionId),
                PropertyValues = values
            };
            originals.Add(article);
            AuthorSearchIndexFieldSource field = article.Fields[0];
            AuthorSearchTokenizedDocument tokenized = AuthorFullTextSearchVerifier.CreateTokenDocument(field.Document,
                field.RawSource, article.Definitions, field.ParserVersion, field.DocumentEpoch);
            candidates.Add(articleId, new(articleId, 1, false, [tokenized])
            {
                PropertyCoordinates = values.Coordinates,
                PropertySnapshotDigest = values.ContentDigest,
                PropertyValues = projected
            });
        }
        var source = new Source([.. originals]);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        Assert.Equal("author_search_index_budget_exceeded",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => Rebuild(index))).Message);
        var unbounded = new AuthorSearchIndexReadSnapshot(42, "primary", index.IndexInstanceId, 1, 1,
            AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest, candidates.ToImmutable());
        Assert.Equal("author_search_index_budget_exceeded", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            AuthorFullTextSearchIndexVerifier.VerifyAsync(unbounded, source))).Message);
    }

    [Fact]
    public async Task Fresh_Canonical_Multiselect_Objects_Have_Parity_And_Indexed_Collections_Remain_Immutable()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.MultiSelect);
        AuthorSearchIndexArticleSource article = Article(definition, new ArticlePropertyMultiSelectValue([s_optionId]));
        var source = new Source(article);
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        await Rebuild(index);
        AuthorSearchIndexReadSnapshot snapshot = await Read(index);
        var actual = Assert.IsType<ArticlePropertyMultiSelectValue>(snapshot.Articles[1].PropertyValues[s_definitionId].Entry.Value);
        Assert.Throws<NotSupportedException>(() => ((IList<Guid>)actual.OptionIds)[0] = Guid.NewGuid());
        source.Articles = [Article(definition with { }, new ArticlePropertyMultiSelectValue([s_optionId]))];
        Assert.NotSame(actual, source.Articles[0].PropertyValues!.Values[0].Value);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source);
    }

    private static ArticlePropertyTypedValue Value(ArticlePropertyValueType type) => type switch
    {
        ArticlePropertyValueType.Text => new ArticlePropertyTextValue("needle"),
        ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0),
        ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
        ArticlePropertyValueType.Date => new ArticlePropertyDateValue(s_instant),
        ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(s_optionId),
        ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([s_optionId]),
        ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([]),
        ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/a"),
        _ => throw new ArgumentOutOfRangeException(nameof(type))
    };

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        return Seal(new(ArticlePropertyDefinitionContract.SchemaVersion, s_definitionId,
            ArticlePropertyDefinitionOwner.User(42, "primary"), "property", [new("en", "Property")], type,
            multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_optionId, "First", 0, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference ? new(ArticlePropertyCardinality.Multiple,
                ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 512, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            true, true, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_instant, s_instant, string.Empty));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private static ArticlePropertyValueEntry Entry(ArticlePropertyDefinition definition, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present)
    {
        var input = new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest, presence, value);
        return new(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest, presence, value,
            ArticlePropertyValueDigest.ComputeValue(input));
    }

    private static ArticlePropertyValueSnapshot Snapshot(ArticlePropertySnapshotCoordinates coordinates,
        IReadOnlyList<ArticlePropertyValueEntry> values)
        => new(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates, values,
            ArticlePropertyValueDigest.ComputeSnapshot(coordinates, values));

    private static AuthorSearchIndexArticleSource Article(ArticlePropertyDefinition definition, ArticlePropertyTypedValue? value,
        int articleId = 1, long sequence = 1, bool propertyField = false,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present)
    {
        ArticlePropertyValueEntry entry = Entry(definition, value, presence);
        ArticlePropertyValueSnapshot values = Snapshot(new(42, "primary", articleId, sequence, 1), [entry]);
        var identity = new AuthorSearchDocumentIdentity(articleId, 42, "primary", 1, 1, 1, 1, "en", ArticleStatus.Draft,
            AuthorSearchScope.CurrentArticle, AuthorSearchPermissionState.Allowed, AuthorSearchVisibilityScope.AuthorOnly,
            AuthorFullTextSearchContract.Digest("policy"));
        string raw = propertyField && value is ArticlePropertyTextValue text ? text.Text : "needle";
        var field = new AuthorSearchFieldReference(propertyField ? AuthorSearchFieldKind.Property : AuthorSearchFieldKind.Title,
            AuthorFullTextSearchContract.Digest(raw), null, propertyField ? definition.DefinitionId : null,
            propertyField ? definition.SchemaRevision : null, PropertyValueType: propertyField ? definition.ValueType : null,
            DefinitionDigest: propertyField ? definition.ContentDigest : null, PropertyValueDigest: propertyField ? entry.ValueDigest : null);
        return new(articleId, sequence, false, [Field(raw, identity, field)],
            new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition }, values);
    }

    private static AuthorSearchIndexFieldSource Field(string raw, AuthorSearchDocumentIdentity identity, AuthorSearchFieldReference field)
    {
        var range = new AuthorSearchSourceRange(AuthorFullTextSearchContract.SourceCoordinateAuthority, "parser-v1", "epoch-1",
            identity.CurrentRevision, AuthorFullTextSearchContract.Digest(raw), 0, raw.Length, 0, Encoding.UTF8.GetByteCount(raw));
        return new(AuthorFullTextSearchContract.SealDocument(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.DocumentSchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.IndexOwner, identity, field, range, string.Empty)), raw, "parser-v1", "epoch-1");
    }

    private static Task<AuthorSearchIndexReadSnapshot> Read(AuthorFullTextSearchIndex index)
        => index.ReadSnapshotAsync(42, "primary", index.IndexInstanceId, index.RequireCurrentGeneration());

    private static async Task Rebuild(AuthorFullTextSearchIndex index)
    {
        while (await index.RebuildStepAsync() is not null)
        {
        }
    }

    private sealed class Source(params AuthorSearchIndexArticleSource[] articles) : IAuthorFullTextSearchIndexSource
    {
        public long Generation { get; set; } = 1;
        public AuthorSearchIndexArticleSource[] Articles { get; set; } = articles;

        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId, int pageSize,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (expectedSourceGeneration.HasValue && expectedSourceGeneration.Value != Generation)
            {
                throw new AuthorSearchContractException("author_search_source_generation_or_page_invalid");
            }
            AuthorSearchIndexArticleSource[] selected = [.. Articles.Where(article => article.ArticleId > afterArticleId)
                .OrderBy(static article => article.ArticleId).Take(pageSize)];
            return Task.FromResult(new AuthorSearchIndexSourcePage(Generation, [.. selected],
                Articles.Any(article => article.ArticleId > (selected.LastOrDefault()?.ArticleId ?? afterArticleId))));
        }
    }
}
