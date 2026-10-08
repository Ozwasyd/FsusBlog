using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests;

/// <summary>Component controls use explicit test admission; no production grant or database receipt is issued.</summary>
public sealed class AuthoringPropertyContributionTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
    private static readonly ArticlePropertyDefinitionOwner s_owner = new(73, "site-a");
    private static readonly Guid s_definitionId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    [Fact]
    public async Task Read_UsesExplicitOwnerAndReturnsOnlyRegisteredTypedValueWithoutWriting()
    {
        Fixture f = Create();
        AuthoringPropertyReadProjection result = await f.Adapter.ReadAsync(f.Binding);
        Assert.Equal(42, f.Values.Actor);
        Assert.Equal(s_owner, f.Values.Owner);
        Assert.Equal(8, f.Values.Article);
        Assert.Equal(new ArticlePropertyTextValue("value"), result.Value!.Value);
        Assert.Equal(f.Read.Current!.SnapshotId, result.SnapshotId);
        Assert.Equal(f.Read.Current.FactsetId, result.FactsetId);
        Assert.True(result.CoreValueCurrent);
        Assert.Equal(0, f.Values.Writes);
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    public async Task Read_PreservesMissingAndNullWithoutStringFallback(ArticlePropertyValuePresence presence)
    {
        Fixture f = Create(presence: presence);
        AuthoringPropertyReadProjection result = await f.Adapter.ReadAsync(f.Binding);
        Assert.Equal(presence, result.Value!.Presence);
        Assert.Null(result.Value.Value);
    }

    [Fact]
    public async Task Read_DefinitionInactiveRetainsTypedValueWithoutEnablingEditor()
    {
        Fixture f = Create(inactive: true);
        AuthoringPropertyReadProjection result = await f.Adapter.ReadAsync(f.Binding);
        Assert.False(result.CoreValueCurrent);
        Assert.Equal(ArticlePropertyValueReconciliationStatus.DefinitionInactive, result.Status);
        Assert.IsType<ArticlePropertyTextValue>(result.Value!.Value);
        Assert.Equal(0, f.Values.Writes);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("property-revision")]
    [InlineData("owner")]
    [InlineData("schema")]
    [InlineData("definition-digest")]
    [InlineData("snapshot-digest")]
    [InlineData("audit")]
    [InlineData("payload-type")]
    [InlineData("duplicate-definition")]
    [InlineData("unknown-status")]
    public async Task Read_RejectsAuthorityCoordinateAndTypedIntegrityDrift(string drift)
    {
        Fixture f = Create();
        ArticlePropertyValueReadModel read = f.Read;
        ArticlePropertyDefinition definition = read.Definitions[0];
        ArticlePropertyValuePersistedSnapshot current = read.Current!;
        read = drift switch
        {
            "article" => read with { ArticleId = 9 },
            "revision" => read with { ArticleRevisionId = 12 },
            "property-revision" => read with { PropertyRevision = 2 },
            "owner" => read with { Definitions = [definition with { Owner = new(42, "site-a") }] },
            "schema" => read with { Definitions = [definition with { SchemaRevision = 2 }] },
            "definition-digest" => read with { Definitions = [definition with { ContentDigest = new string('d', 64) }] },
            "snapshot-digest" => read with { Current = current with { Snapshot = new(1, current.Snapshot.Coordinates, current.Snapshot.Values, new string('f', 64)) } },
            "audit" => read with { Current = current with { AuditReference = Guid.Empty } },
            "payload-type" => Read(definition, new ArticlePropertyBooleanValue(false)),
            "duplicate-definition" => read with { Definitions = [definition, definition] },
            "unknown-status" => read with { Reconciliation = [new(s_definitionId, (ArticlePropertyValueReconciliationStatus)255, "unknown")] },
            _ => throw new ArgumentOutOfRangeException(nameof(drift))
        };
        f.Values.Result = _ => Task.FromResult(read);
        if (drift == "snapshot-digest")
        {
            ArticlePropertyDefinitionValidationException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => f.Adapter.ReadAsync(f.Binding));
            Assert.Equal("article_property_snapshot_digest_invalid", error.Message);
        }
        else
        {
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() => f.Adapter.ReadAsync(f.Binding));
        }
        Assert.Equal(0, f.Values.Writes);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task Read_RevokedAdmissionDoesNotPublish(int rejectAt)
    {
        Fixture f = Create();
        int calls = 0;
        f.Admission.Check = (_, _) => ++calls != rejectAt;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => f.Adapter.ReadAsync(f.Binding));
        Assert.Equal(rejectAt == 1 ? 0 : 1, f.Values.Reads);
    }

    [Fact]
    public async Task Read_CancellationAfterAuthorityReturnsDoesNotPublish()
    {
        Fixture f = Create();
        using var cancel = new CancellationTokenSource();
        f.Values.Result = _ =>
        {
            cancel.Cancel();
            return Task.FromResult(f.Read);
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => f.Adapter.ReadAsync(f.Binding, cancel.Token));
    }

    [Fact]
    public async Task Read_ExpiredRequestNeverReachesAuthority()
    {
        Fixture f = Create();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => f.Adapter.ReadAsync(f.Binding with { Deadline = s_now }));
        Assert.Equal(0, f.Values.Reads);
    }

    [Fact]
    public async Task Read_DeadlineCancelsCooperativeAuthority()
    {
        Fixture f = Create();
        f.Values.Result = async token =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return f.Read;
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => f.Adapter.ReadAsync(f.Binding with { Deadline = s_now.AddMilliseconds(50) }));
    }

    [Theory]
    [InlineData("unknown-storage")]
    [InlineData("editor-mismatch")]
    [InlineData("schema")]
    [InlineData("package")]
    [InlineData("core-conflict")]
    [InlineData("duplicate")]
    public void Registry_RejectsUnmappedOrUnownedTypes(string drift)
    {
        Fixture f = Create();
        AuthoringPropertyTypeContribution type = drift switch
        {
            "unknown-storage" => f.Type with { StorageKind = (ArticlePropertyValueType)255 },
            "editor-mismatch" => f.Type with { EditorRole = AuthoringPropertyEditorRole.Number },
            "schema" => f.Type with { SchemaVersion = 2 },
            "package" => f.Type with { PackageSha256 = new string('e', 64) },
            _ => f.Type
        };
        AuthoringExtensionRegistrySnapshot registry = Extensions(drift == "core-conflict" ? [type.TypeId] : []);
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringPropertyTypeRegistry(registry,
            drift == "duplicate" ? [type, type] : [type]));
    }

    [Fact]
    public void Schema_RejectsGenericUiFieldsAndMissingAdmission()
    {
        Fixture f = Create();
        string json = JsonSerializer.Serialize(f.Type);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringPropertyTypeContribution>(json[..^1] + ",\"ComponentName\":\"arbitrary\"}"));
        Assert.Throws<ArgumentNullException>(() => new AuthoringPropertyTypeAdapter(f.Values, f.Registry, null!));
    }

    [Theory]
    [InlineData(ArticlePropertyValueReconciliationStatus.ValueRejected)]
    [InlineData(ArticlePropertyValueReconciliationStatus.ReferenceAuthorityUnavailable)]
    public async Task Read_RejectedCanonicalValueDoesNotExposePrivatePayload(ArticlePropertyValueReconciliationStatus status)
    {
        Fixture f = Create();
        f.Values.Result = _ => Task.FromResult(f.Read with { Reconciliation = [new(s_definitionId, status, "canonical-refusal")] });
        AuthoringPropertyReadProjection result = await f.Adapter.ReadAsync(f.Binding);
        Assert.Null(result.Value);
        Assert.Equal(status, result.Status);
        Assert.False(result.CoreValueCurrent);
        Assert.Equal(0, f.Values.Writes);
    }

    [Theory]
    [InlineData("SchemaVersion")]
    [InlineData("TypeId")]
    [InlineData("ExtensionId")]
    [InlineData("ExtensionVersion")]
    [InlineData("PackageSha256")]
    [InlineData("ContributionId")]
    [InlineData("DefinitionId")]
    [InlineData("DefinitionSchemaRevision")]
    [InlineData("DefinitionDigest")]
    [InlineData("StorageKind")]
    [InlineData("EditorRole")]
    [InlineData("NormalizationVersion")]
    [InlineData("MigrationPolicy")]
    public void Schema_RejectsEveryMissingFieldBeforeRegistry(string field)
    {
        Fixture f = Create();
        JsonObject json = JsonNode.Parse(JsonSerializer.Serialize(f.Type))!.AsObject();
        json.Remove(field);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringPropertyTypeContribution>(json.ToJsonString()));
    }

    [Theory]
    [InlineData("SchemaVersion")]
    [InlineData("TypeId")]
    [InlineData("ExtensionId")]
    [InlineData("ExtensionVersion")]
    [InlineData("PackageSha256")]
    [InlineData("ContributionId")]
    [InlineData("DefinitionId")]
    [InlineData("DefinitionSchemaRevision")]
    [InlineData("DefinitionDigest")]
    [InlineData("StorageKind")]
    [InlineData("EditorRole")]
    [InlineData("NormalizationVersion")]
    [InlineData("MigrationPolicy")]
    public void Schema_RejectsRepeatedFieldEvenWhenValuesMatch(string field)
    {
        Fixture f = Create();
        string json = JsonSerializer.Serialize(f.Type);
        string value = JsonNode.Parse(json)![field]!.ToJsonString();
        string duplicate = "{\"" + field + "\":" + value + "," + json[1..];
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringPropertyTypeContribution>(duplicate));
    }

    [Theory]
    [InlineData("StorageKind")]
    [InlineData("EditorRole")]
    [InlineData("MigrationPolicy")]
    public void Schema_RejectsConflictingFirstFieldInsteadOfAcceptingLastValidValue(string field)
    {
        Fixture f = Create();
        string json = JsonSerializer.Serialize(f.Type);
        string duplicate = "{\"" + field + "\":255," + json[1..];
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthoringPropertyTypeContribution>(duplicate));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Schema_ExplicitFieldsRoundTripWithSupportedNamingPolicy(bool camelCase)
    {
        Fixture f = Create();
        var options = new JsonSerializerOptions { PropertyNamingPolicy = camelCase ? JsonNamingPolicy.CamelCase : null };
        string json = JsonSerializer.Serialize(f.Type, options);
        var type = JsonSerializer.Deserialize<AuthoringPropertyTypeContribution>(json, options);
        Assert.Equal(f.Type, type);
        Assert.Equal(type, new AuthoringPropertyTypeRegistry(Extensions([]), [type!]).Get(f.Type.TypeId));
    }

    private static Fixture Create(ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present, bool inactive = false)
    {
        var definition = new ArticlePropertyDefinition(1, s_definitionId, s_owner, "typed-field", [new("en", "Typed field")],
            ArticlePropertyValueType.Text, ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(MaxLength: 256), [], null, null, false, false, false,
            ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            inactive ? ArticlePropertyDefinitionStatus.Deprecated : ArticlePropertyDefinitionStatus.Active, 1, s_now.UtcDateTime, s_now.UtcDateTime, "");
        definition = definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };
        var type = new AuthoringPropertyTypeContribution(1, "acme.author-tools.field", "acme.author-tools", "1.0.0", new string('a', 64),
            "acme.property.field", s_definitionId, 1, definition.ContentDigest, ArticlePropertyValueType.Text,
            AuthoringPropertyEditorRole.Text, 1, AuthoringMigrationPolicy.HostDeclarativeOnly);
        var registry = new AuthoringPropertyTypeRegistry(Extensions([]), [type]);
        ArticlePropertyValueReadModel read = Read(definition, presence == ArticlePropertyValuePresence.Present ? new ArticlePropertyTextValue("value") : null, presence);
        var values = new Values { Result = _ => Task.FromResult(read) };
        var admission = new Admission();
        var binding = new AuthoringPropertyReadBinding(type.TypeId, 42, s_owner, 8, 11, 1, "request:one", "runtime:one", 3, "grant:one", s_now.AddSeconds(10));
        return new(new(values, registry, admission, new Clock()), registry, values, admission, binding, read, type);
    }

    private static ArticlePropertyValueReadModel Read(ArticlePropertyDefinition definition, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present)
    {
        var input = new ArticlePropertyValueInput(s_definitionId, 1, definition.ContentDigest, presence, value);
        var entry = new ArticlePropertyValueEntry(s_definitionId, 1, definition.ContentDigest, presence, value, ArticlePropertyValueDigest.ComputeValue(input));
        ArticlePropertyValueSnapshot snapshot = ArticlePropertyValueValidator.BindSnapshot(new(s_owner.UserId, s_owner.SiteScope, 8, 1, 11), [entry]);
        Guid snapshotId = Guid.Parse("00000000-0000-0000-0000-000000000010");
        return new(8, 11, 1, new(snapshotId, Guid.Parse("00000000-0000-0000-0000-000000000011"), snapshot, snapshotId, "audit-chain", new string('c', 64)),
            [definition], [new(s_definitionId, definition.Status == ArticlePropertyDefinitionStatus.Active
                ? ArticlePropertyValueReconciliationStatus.Current : ArticlePropertyValueReconciliationStatus.DefinitionInactive, "canonical-status")]);
    }

    private static AuthoringExtensionRegistrySnapshot Extensions(ImmutableArray<string> coreProperties)
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest();
        manifest = manifest with
        {
            Contributions = [manifest.Contributions[0] with
        {
            Id = "acme.property.field", Kind = AuthoringContributionKind.ArticlePropertyType, Capabilities = []
        }]
        };
        return AuthoringExtensionContractValidator.CreateRegistry([AuthoringExtensionContractValidator.Verify(manifest)], new([], [], coreProperties, [], []));
    }

    private sealed record Fixture(AuthoringPropertyTypeAdapter Adapter, AuthoringPropertyTypeRegistry Registry, Values Values,
        Admission Admission, AuthoringPropertyReadBinding Binding, ArticlePropertyValueReadModel Read, AuthoringPropertyTypeContribution Type);

    private sealed class Clock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_now;
    }

    private sealed class Admission : IAuthoringPropertyContributionReadAdmission
    {
        public Func<AuthoringPropertyReadBinding, AuthoringPropertyTypeContribution, bool> Check { get; set; } = (_, _) => true;
        public bool IsCurrent(AuthoringPropertyReadBinding binding, AuthoringPropertyTypeContribution contribution) => Check(binding, contribution);
    }

    private sealed class Values : IArticlePropertyValueAuthority
    {
        public Func<CancellationToken, Task<ArticlePropertyValueReadModel>> Result { get; set; } = null!;
        public long Actor
        {
            get; private set;
        }
        public ArticlePropertyDefinitionOwner Owner
        {
            get; private set;
        }
        public int Article
        {
            get; private set;
        }
        public int Reads
        {
            get; private set;
        }
        public int Writes
        {
            get; private set;
        }
        public Task<ArticlePropertyValueReadModel> ReadAsync(long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, int articleId, CancellationToken cancellationToken = default)
        {
            Reads++;
            Actor = actorAdminPrincipalId;
            Owner = owner;
            Article = articleId;
            return Result(cancellationToken);
        }
        public Task<ArticlePropertyValueMutationReceipt> MutateAsync(long actorAdminPrincipalId, ArticlePropertyValueMutationCommand command, CancellationToken cancellationToken = default)
        {
            Writes++;
            throw new NotSupportedException("Read adapter cannot mutate values.");
        }
    }
}
