using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Intake/coordinate tests only; fixture IDs are not persisted or signed audit evidence.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchPropertySourceAdapterTests
{
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.User(42, "primary");
    private static readonly DateTime s_now = new(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc);
    private static readonly Guid s_option = Guid.Parse("10000000-0000-0000-0000-000000000001");

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task Reads_One_Real_Port_And_Preserves_All_Typed_And_Persisted_Coordinates(ArticlePropertyValueType type)
    {
        ArticlePropertyValueReadModel model = Model(type);
        var authority = new Authority(model);
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(authority);
        using var cancellation = new CancellationTokenSource();
        AuthorSearchCurrentPropertySource result = await adapter.ReadCurrentAsync(42, s_owner, 7, 19, 3, cancellation.Token);
        Assert.Equal(1, authority.Reads);
        Assert.Equal((42L, s_owner, 7, cancellation.Token), authority.Last);
        Assert.Equal(model.Current!.SnapshotId, result.Persisted.SnapshotId);
        Assert.Equal(model.Current.FactsetId, result.Persisted.FactsetId);
        Assert.Equal(model.Current.AuditReference, result.Persisted.AuditReference);
        Assert.Equal(model.Current.AuditChainId, result.Persisted.AuditChainId);
        Assert.Equal(model.Current.AuditRecordHash, result.Persisted.AuditRecordHash);
        Assert.Equal(model.Current.Snapshot.ContentDigest, result.Persisted.Snapshot.ContentDigest);
        Assert.Equal(model.Current.Snapshot.Coordinates, result.Persisted.Snapshot.Coordinates);
        ArticlePropertyValueEntry entry = Assert.Single(result.EligibleValues).Value;
        Assert.Equal(model.Current.Snapshot.Values[0].ValueDigest, entry.ValueDigest);
        Assert.Equal(model.Current.Snapshot.Values[0].Value!.GetType(), entry.Value!.GetType());
        if (type == ArticlePropertyValueType.Number)
        {
            Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(entry.Value).Number);
        }
        if (type == ArticlePropertyValueType.Boolean)
        {
            Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(entry.Value).Boolean);
        }
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(result.Persisted.Snapshot);
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    public async Task Presence_And_Search_Eligibility_Are_Not_Inferred_From_Empty_Or_Falsy_Values(ArticlePropertyValuePresence presence)
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text, presence, eligible: false);
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        AuthorSearchCurrentPropertySource result = await adapter.ReadCurrentAsync(42, s_owner, 7, 19);
        Assert.Empty(result.EligibleValues);
        ArticlePropertyValueEntry entry = Assert.Single(result.Persisted.Snapshot.Values);
        Assert.Equal(presence, entry.Presence);
        Assert.Null(entry.Value);
        Assert.Single(result.Definitions);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("property")]
    [InlineData("owner")]
    [InlineData("audit")]
    [InlineData("digest")]
    [InlineData("schema")]
    [InlineData("missing")]
    public async Task Rejects_Missing_Stale_Or_Tampered_Snapshot_Instead_Of_Supplying_An_Empty_Property_Fallback(string mutation)
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text);
        ArticlePropertyValuePersistedSnapshot persisted = model.Current!;
        if (mutation == "article")
        {
            model = model with
            {
                ArticleId = 8
            };
        }
        if (mutation == "revision")
        {
            model = model with
            {
                ArticleRevisionId = 20
            };
        }
        if (mutation == "property")
        {
            model = model with
            {
                PropertyRevision = 4
            };
        }
        if (mutation == "owner")
        {
            ArticlePropertyValueSnapshot changed = ArticlePropertyValueValidator.BindSnapshot(
                persisted.Snapshot.Coordinates with
                {
                    SiteScope = "other"
                }, persisted.Snapshot.Values);
            model = model with
            {
                Current = persisted with
                {
                    Snapshot = changed
                }
            };
        }
        if (mutation == "audit")
        {
            model = model with
            {
                Current = persisted with
                {
                    AuditReference = Guid.CreateVersion7()
                }
            };
        }
        if (mutation is "digest" or "schema")
        {
            var changed = new ArticlePropertyValueSnapshot(mutation == "schema" ? 2 : 1,
                persisted.Snapshot.Coordinates, persisted.Snapshot.Values,
                mutation == "digest" ? new string('0', 64) : persisted.Snapshot.ContentDigest);
            model = model with
            {
                Current = persisted with
                {
                    Snapshot = changed
                }
            };
        }
        if (mutation == "missing")
        {
            model = model with
            {
                Current = null
            };
        }
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        if (mutation is "digest" or "schema")
        {
            await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19, 3));
        }
        else
        {
            await Assert.ThrowsAsync<AuthorSearchContractException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19, 3));
        }
    }

    [Theory]
    [InlineData(ArticlePropertyValueReconciliationStatus.DefinitionUnavailable)]
    [InlineData(ArticlePropertyValueReconciliationStatus.DefinitionInactive)]
    [InlineData(ArticlePropertyValueReconciliationStatus.DefinitionChanged)]
    [InlineData(ArticlePropertyValueReconciliationStatus.ValueRejected)]
    [InlineData(ArticlePropertyValueReconciliationStatus.ReferenceAuthorityUnavailable)]
    [InlineData(ArticlePropertyValueReconciliationStatus.RequiredValueMissing)]
    [InlineData(ArticlePropertyValueReconciliationStatus.DefaultPending)]
    public async Task Refuses_All_Unresolved_Reconciliation_Without_Normalizing_Or_Defaulting_It_Locally(ArticlePropertyValueReconciliationStatus status)
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text);
        model = model with
        {
            Reconciliation = [model.Reconciliation[0] with { Status = status }]
        };
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        AuthorSearchContractException exception = await Assert.ThrowsAsync<AuthorSearchContractException>(
            () => adapter.ReadCurrentAsync(42, s_owner, 7, 19));
        Assert.Equal("author_search_property_reconciliation_required", exception.Message);
    }

    [Fact]
    public async Task Nonempty_Reference_Does_Not_Become_Accepted_Through_A_Forged_Current_Reconciliation_Status()
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.ArticleReference,
            value: new ArticlePropertyArticleReferenceValue([8]));
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        AuthorSearchContractException exception = await Assert.ThrowsAsync<AuthorSearchContractException>(
            () => adapter.ReadCurrentAsync(42, s_owner, 7, 19));
        Assert.Equal("author_search_property_reference_authority_unavailable", exception.Message);
    }

    [Fact]
    public async Task Bounds_Input_And_Preserves_Cancellation_And_Authority_Refusal()
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text);
        var authority = new Authority(model);
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(authority);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19, cancellationToken: cancellation.Token));
        Assert.Equal(0, authority.Reads);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19, 0));
        Assert.Equal(0, authority.Reads);
        authority.Model = model with
        {
            Definitions = Enumerable.Repeat(model.Definitions[0], 1_001).ToArray()
        };
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19));
        authority.Failure = new ArticlePropertyDefinitionAccessDeniedException();
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19));
    }

    [Fact]
    public async Task Holds_Definition_Collections_Without_Changing_Their_Authority_Digest()
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Url);
        var schemes = new List<string> { "https" };
        ArticlePropertyDefinition definition = model.Definitions[0] with
        {
            UrlPolicy = model.Definitions[0].UrlPolicy! with
            {
                AllowedSchemes = schemes
            }
        };
        model = model with
        {
            Definitions = [definition]
        };
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        AuthorSearchCurrentPropertySource result = await adapter.ReadCurrentAsync(42, s_owner, 7, 19);
        schemes.Clear();
        ArticlePropertyDefinition held = result.Definitions[definition.DefinitionId];
        Assert.Equal("https", Assert.Single(held.UrlPolicy!.AllowedSchemes));
        Assert.Equal(definition.ContentDigest, held.ContentDigest);
        Assert.Equal(held.ContentDigest, ArticlePropertyDefinitionContract.ComputeDefinitionDigest(held));
    }

    [Fact]
    public async Task Cancellation_After_The_Original_Read_Does_Not_Return_Current_Source_Facts()
    {
        using var cancellation = new CancellationTokenSource();
        var authority = new Authority(Model(ArticlePropertyValueType.Text)) { AfterRead = cancellation.Cancel };
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(authority);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => adapter.ReadCurrentAsync(42, s_owner, 7, 19,
            cancellationToken: cancellation.Token));
        Assert.Equal(1, authority.Reads);
    }

    [Fact]
    public async Task Rejects_A_Resealed_Value_With_Another_Definition_Owned_Type()
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text);
        ArticlePropertyValueEntry original = model.Current!.Snapshot.Values[0];
        var input = new ArticlePropertyValueInput(original.DefinitionId, original.DefinitionSchemaRevision,
            original.DefinitionDigest, original.Presence, new ArticlePropertyNumberValue(0));
        ArticlePropertyValueEntry changed = original with
        {
            Value = input.Value,
            ValueDigest = ArticlePropertyValueDigest.ComputeValue(input)
        };
        model = model with
        {
            Current = model.Current with
            {
                Snapshot = ArticlePropertyValueValidator.BindSnapshot(model.Current.Snapshot.Coordinates, [changed])
            }
        };
        var adapter = new AuthorFullTextSearchPropertySourceAdapter(new Authority(model));
        AuthorSearchContractException exception = await Assert.ThrowsAsync<AuthorSearchContractException>(
            () => adapter.ReadCurrentAsync(42, s_owner, 7, 19));
        Assert.Equal("author_search_property_typed_shape_mismatch", exception.Message);
    }

    private static ArticlePropertyValueReadModel Model(ArticlePropertyValueType type,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present,
        bool eligible = true, ArticlePropertyTypedValue? value = null)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        var cardinality = multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        var definition = new ArticlePropertyDefinition(1, Guid.CreateVersion7(), s_owner, "field", [new("en", "Field")],
            type, cardinality, false, new(ArticlePropertyMissingBehavior.PreserveMissing,
                ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty), null, new(),
            type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_option, "One", 0, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference ? new(cardinality,
                ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2_048,
                ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            eligible, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_now, s_now, string.Empty);
        definition = definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };
        ArticlePropertyTypedValue? payload = presence != ArticlePropertyValuePresence.Present ? null : value ?? type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue("中文 CAFÉ"),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(s_now),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(s_option),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([]),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([]),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/path"),
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };
        var input = new ArticlePropertyValueInput(definition.DefinitionId, 1, definition.ContentDigest, presence, payload);
        var entry = new ArticlePropertyValueEntry(input.DefinitionId, input.DefinitionSchemaRevision,
            input.DefinitionDigest, presence, payload, ArticlePropertyValueDigest.ComputeValue(input));
        ArticlePropertyValueSnapshot snapshot = ArticlePropertyValueValidator.BindSnapshot(new(42, "primary", 7, 3, 19), [entry]);
        Guid snapshotId = Guid.CreateVersion7();
        return new(7, 19, 3, new(snapshotId, Guid.CreateVersion7(), snapshot, snapshotId, "fixture-audit-chain",
            new string('a', 64)), [definition], [new(definition.DefinitionId, ArticlePropertyValueReconciliationStatus.Current,
                "article_property_value_current")]);
    }

    private sealed class Authority(ArticlePropertyValueReadModel model) : IArticlePropertyValueAuthority
    {
        public ArticlePropertyValueReadModel Model { get; set; } = model;
        public int Reads
        {
            get; private set;
        }
        public (long, ArticlePropertyDefinitionOwner, int, CancellationToken) Last
        {
            get; private set;
        }
        public Exception? Failure
        {
            get; set;
        }
        public Action? AfterRead
        {
            get; set;
        }

        public Task<ArticlePropertyValueReadModel> ReadAsync(long actorAdminPrincipalId,
            ArticlePropertyDefinitionOwner owner, int articleId, CancellationToken cancellationToken = default)
        {
            Reads++;
            Last = (actorAdminPrincipalId, owner, articleId, cancellationToken);
            AfterRead?.Invoke();
            return Failure is not null ? Task.FromException<ArticlePropertyValueReadModel>(Failure) : Task.FromResult(Model);
        }

        public Task<ArticlePropertyValueMutationReceipt> MutateAsync(long actorAdminPrincipalId,
            ArticlePropertyValueMutationCommand command, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("intake-must-not-write");
    }
}
