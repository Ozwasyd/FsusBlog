using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Tests.Unit;

public sealed class ArticlePackageManifestPropertyCodecTests
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
    public void EightActualTypesRoundTripAndRebindThroughExistingMapper(ArticlePropertyValueType type)
    {
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(1, Value(type))]);
        ArticlePackagePropertyMappingBindings bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        byte[] encoded = ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate);
        var result = ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(encoded, out var parsed);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(candidate.ComponentDigest, parsed!.ComponentDigest);
        Assert.Equal(encoded, ArticlePackageManifestCandidateCodec.WritePropertyCandidate(parsed));
        Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out var rebound).IsValid);
        Assert.Equal(candidate.ComponentDigest, rebound!.ComponentDigest);
        Assert.False(rebound.RequirePropertyAuthority().IsValid);
        Assert.Equal("article_package_manifest_property_persisted_definition_authority_unavailable", rebound.RequirePropertyAuthority().ReasonCode);
    }

    [Fact]
    public void MissingNullFalseZeroEmptyAndDefaultOriginStayDistinct()
    {
        var snapshot = Snapshot([
            Entry(1, null, ArticlePropertyValuePresence.Missing), Entry(2, null, ArticlePropertyValuePresence.Null),
            Entry(3, new ArticlePropertyBooleanValue(false)), Entry(4, new ArticlePropertyNumberValue(0)),
            Entry(5, new ArticlePropertyTextValue("")), Entry(6, new ArticlePropertyTextValue("default"), defaultApplied: true)
        ]);
        var bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate), out var parsed).IsValid);
        Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out _).IsValid);
        var rows = parsed!.Mapping.Properties;
        Assert.Equal(ArticlePropertyValuePresence.Missing, rows[0].Presence);
        Assert.Equal(ArticlePropertyValuePresence.Null, rows[1].Presence);
        Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(rows[2].Projection).Value).Boolean);
        Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(rows[3].Projection).Value).Number);
        Assert.Equal("", Assert.IsType<ArticlePropertyTextValue>(Assert.IsType<ArticlePackagePrimitivePropertyProjection>(rows[4].Projection).Value).Text);
        Assert.True(rows[5].DefaultApplied);
        Assert.Equal(6, rows.Select(static row => row.PortableValueDigest).Distinct().Count());
    }

    [Theory]
    [InlineData("sourceDefinitionId")]
    [InlineData("sourceSchemaRevision")]
    [InlineData("sourceDefinitionDigest")]
    [InlineData("portableDefinition")]
    [InlineData("sourceValueDigest")]
    [InlineData("defaultApplied")]
    [InlineData("portableValueDigest")]
    [InlineData("projection")]
    public void CopiedDigestRejectsEveryRowFieldAndResealingCannotBypassCanonicalBinding(string field)
    {
        var snapshot = Snapshot([Entry(1, new ArticlePropertyBooleanValue(false))]);
        var bindings = Bindings(snapshot);
        JsonObject document = Document(Component(Map(snapshot, bindings)));
        JsonObject row = document["properties"]![0]!.AsObject();
        row[field] = field switch
        {
            "sourceDefinitionId" => JsonValue.Create(Id(2).ToString("D")),
            "sourceSchemaRevision" => JsonValue.Create(2),
            "portableDefinition" => JsonValue.Create(Portable(ArticlePackageIdentityKind.Definition, 999).Value),
            "defaultApplied" => JsonValue.Create(true),
            "projection" => new JsonObject { ["kind"] = "boolean", ["value"] = true },
            _ => JsonValue.Create(new string('b', 64))
        };
        Reject(document);
        Reseal(document);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(Encode(document), out var resealed).IsValid);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(resealed, snapshot, bindings, out var rebound).IsValid);
        Assert.Null(rebound);
    }

    [Theory]
    [InlineData("definitionOwnerUserId")]
    [InlineData("siteScope")]
    [InlineData("articleId")]
    [InlineData("propertyRevision")]
    [InlineData("articleRevisionId")]
    [InlineData("draftId")]
    [InlineData("draftServerRevision")]
    public void AllSuppliedCoordinateDriftsRefuseRebinding(string field)
    {
        var snapshot = Snapshot([Entry(1, new ArticlePropertyTextValue("exact"))]);
        var bindings = Bindings(snapshot);
        JsonObject document = Document(Component(Map(snapshot, bindings)));
        JsonObject coordinate = document["sourceCoordinates"]!.AsObject();
        coordinate[field] = field == "siteScope" ? JsonValue.Create("site-b") : JsonValue.Create(999);
        Reject(document);
        Reseal(document);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(Encode(document), out var resealed).IsValid);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(resealed, snapshot, bindings, out _).IsValid);
    }

    [Fact]
    public void PublicationCoordinatesAndDefinitionTargetEpochsMustMatchExactly()
    {
        var source = s_coordinates with
        {
            DraftId = null,
            DraftServerRevision = null,
            PublicationId = 11
        };
        var snapshot = Snapshot([Entry(1, new ArticlePropertyArticleReferenceValue([8]))], source);
        var bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        JsonObject document = Document(candidate);
        document["sourceCoordinates"]!["publicationId"] = 12;
        Reseal(document);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(Encode(document), out var parsed).IsValid);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out _).IsValid);
        var reference = bindings.Articles[0];
        var next = new ArticlePackagePropertyArticleBinding(reference.SourceArticleId, reference.PortableArticle,
            reference.TargetFacts with
            {
                RevisionIdentity = "revision:next",
                RevisionNumber = 2
            });
        var changed = new ArticlePackagePropertyMappingBindings(source, snapshot.ContentDigest, bindings.Definitions, bindings.Options, [next]);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(candidate, snapshot, changed, out _).IsValid);
        var denied = new ArticlePackagePropertyMappingBindings(source, snapshot.ContentDigest, bindings.Definitions, bindings.Options,
            [new(reference.SourceArticleId, reference.PortableArticle, reference.TargetFacts with { Permission = ArticleRelationPermissionState.Denied })]);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(candidate, snapshot, denied, out _).IsValid);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("coordinate")]
    [InlineData("row")]
    [InlineData("projection")]
    public void ClosedObjectsRejectUnknownSecretAndStorageExtensions(string level)
    {
        JsonObject document = BooleanDocument();
        JsonObject target = level switch
        {
            "coordinate" => document["sourceCoordinates"]!.AsObject(),
            "row" => document["properties"]![0]!.AsObject(),
            "projection" => document["properties"]![0]!["projection"]!.AsObject(),
            _ => document
        };
        foreach (string secret in new[] { "token", "session", "auditPayload", "storageKey", "rights", "unknown" })
        {
            target[secret] = "fixture";
            Reseal(document);
            Reject(document);
            target.Remove(secret);
        }
    }

    [Fact]
    public void MissingDuplicateWrongTypedUnknownVersionAndInvalidUtf8RefuseWithoutCandidate()
    {
        JsonObject original = BooleanDocument();
        foreach (string key in original.Select(static pair => pair.Key).ToArray())
        {
            var missing = original.DeepClone().AsObject();
            missing.Remove(key);
            Reject(missing);
        }
        string json = Encoding.UTF8.GetString(Encode(original));
        RejectBytes(Encoding.UTF8.GetBytes(json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1", StringComparison.Ordinal)));
        original["schemaVersion"] = 2;
        Reseal(original);
        Reject(original);
        original = BooleanDocument();
        original["properties"]![0]!["presence"] = 256;
        Reseal(original);
        Reject(original);
        original = BooleanDocument();
        original["properties"]![0]!["projection"]!["value"] = "false";
        Reseal(original);
        Reject(original);
        original = BooleanDocument();
        original["properties"]![0]!["projection"]!["kind"] = "legacy";
        Reseal(original);
        Reject(original);
        RejectBytes([0xff]);
        RejectBytes(Encoding.UTF8.GetBytes(json.Replace("site-a", "\\uD800", StringComparison.Ordinal)));
        RejectBytes(new byte[ArticlePackageManifestCandidateCodec.MaxJsonBytes + 1]);
    }

    [Theory]
    [InlineData("1e-29")]
    [InlineData("0.123456789012345678901234567891")]
    [InlineData("79228162514264337593543950336")]
    public void DecimalDecoderNeverRoundsUnderflowsOrConvertsThroughDouble(string number)
    {
        var snapshot = Snapshot([Entry(1, new ArticlePropertyNumberValue(0))]);
        string json = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(Component(Map(snapshot, Bindings(snapshot)))));
        RejectBytes(Encoding.UTF8.GetBytes(json.Replace("\"value\":0", "\"value\":" + number, StringComparison.Ordinal)));
    }

    [Fact]
    public void CanonicalExactDecimalUtcUnicodeAndNullableOwnerArePreserved()
    {
        var snapshot = Snapshot([
            Entry(1, new ArticlePropertyNumberValue(0.1234567890123456789012345678m)),
            Entry(2, new ArticlePropertyNumberValue(decimal.MaxValue)),
            Entry(3, new ArticlePropertyNumberValue(decimal.MinValue)),
            Entry(4, new ArticlePropertyTextValue("e\u0301\r\n😀 trailing \t"))
        ], s_coordinates with
        {
            DefinitionOwnerUserId = null
        });
        var bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate), out var parsed).IsValid);
        Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out _).IsValid);
        Assert.Null(parsed!.Mapping.SourceCoordinates.DefinitionOwnerUserId);
        var dateSnapshot = Snapshot([Entry(1, Value(ArticlePropertyValueType.Date))]);
        JsonObject document = Document(Component(Map(dateSnapshot, Bindings(dateSnapshot))));
        document["properties"]![0]!["projection"]!["value"] = "2026-10-08T12:00:00+00:00";
        Reseal(document);
        Reject(document);
    }

    [Fact]
    public void DuplicateDefinitionsOptionsAndWrongPortableKindsNeverAutoMap()
    {
        JsonObject document = BooleanDocument();
        document["properties"]!.AsArray().Add(document["properties"]![0]!.DeepClone());
        Reseal(document);
        Reject(document);
        var snapshot = Snapshot([Entry(1, Value(ArticlePropertyValueType.MultiSelect))]);
        document = Document(Component(Map(snapshot, Bindings(snapshot))));
        var options = document["properties"]![0]!["projection"]!["value"]!.AsArray();
        options[1] = options[0]!.DeepClone();
        Reseal(document);
        Reject(document);
        options[1] = Portable(ArticlePackageIdentityKind.Article, 9).Value;
        Reseal(document);
        Reject(document);
    }

    [Fact]
    public void ThousandRowsAreBoundedAndAggregateOverflowRefusesWholeComponent()
    {
        var snapshot = Snapshot(Enumerable.Range(1, 1000).Select(index => Entry(index, new ArticlePropertyTextValue("exact"))));
        var bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        Assert.Equal(1000, candidate.Mapping.Properties.Count);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate), out var parsed).IsValid);
        Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out _).IsValid);
        var big = Snapshot(Enumerable.Range(1, 1000).Select(index => Entry(index, new ArticlePropertyTextValue(new string('界', 16384)))));
        var result = ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(Map(big, Bindings(big)), out var overflow);
        Assert.False(result.IsValid);
        Assert.Null(overflow);
        Assert.Equal("article_package_manifest_property_budget_exceeded", result.ReasonCode);
    }

    [Fact]
    public void RootStillRefusesPropertiesAndRepeatedBindingDoesNotIssueAuthority()
    {
        var snapshot = Snapshot([Entry(1, new ArticlePropertyBooleanValue(false))]);
        var bindings = Bindings(snapshot);
        var candidate = Component(Map(snapshot, bindings));
        byte[] first = ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate);
        first[0] = 0;
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate), out var parsed).IsValid);
        for (int index = 0; index < 3; index++)
        {
            Assert.True(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, snapshot, bindings, out var rebound).IsValid);
            Assert.False(rebound!.RequirePropertyAuthority().IsValid);
        }
        Assert.False(ArticlePackageManifestCandidateCodec.TryParseCandidate("{\"properties\":[]}"u8, out _).IsValid);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(null, snapshot, bindings, out _).IsValid);
        Assert.False(ArticlePackageManifestPropertyBinder.TryBindCandidate(parsed, null, bindings, out _).IsValid);
    }

    [Fact]
    public void ProjectedIdentityBudgetAndOwnedListsCannotBeBypassed()
    {
        ArticlePackageIdentity[] identities = Enumerable.Range(1, 1000)
            .Select(index => Portable(ArticlePackageIdentityKind.Option, index)).ToArray();
        var projection = new ArticlePackageMultiOptionPropertyProjection(identities);
        identities[0] = default;
        ArticlePackageMappedProperty[] rows = Enumerable.Range(1, 21).Select(index => new ArticlePackageMappedProperty(
            Id(index), 1, s_digest, Portable(ArticlePackageIdentityKind.Definition, index), s_digest,
            ArticlePropertyValuePresence.Present, false, s_digest, projection)).ToArray();
        var mapping = new ArticlePackagePropertyMappingCandidate(s_coordinates, s_digest, rows[..20], s_digest);
        var candidate = Component(mapping);
        Assert.Equal(20000, candidate.Mapping.Properties.Sum(static row => Assert.IsType<ArticlePackageMultiOptionPropertyProjection>(row.Projection).Options.Count));
        byte[] original = ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate);
        rows[0] = rows[20];
        Assert.Equal(original, ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate));
        rows[0] = mapping.Properties[0];
        var overflow = new ArticlePackagePropertyMappingCandidate(s_coordinates, s_digest, rows, s_digest);
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(overflow, out var refused).IsValid);
        Assert.Null(refused);
        Assert.Throws<ArgumentException>(() => new ArticlePackagePropertyMappingCandidate(s_coordinates, s_digest,
            Enumerable.Repeat(rows[0], 1001).ToArray(), s_digest));
        // This shape-only fixture has no persisted snapshot or canonical mapping proof.
        Assert.False(candidate.RequirePropertyAuthority().IsValid);
    }

    private static ArticlePackageManifestPropertyCandidate Component(ArticlePackagePropertyMappingCandidate mapping)
    {
        var result = ArticlePackageManifestCandidateCodec.TryCreatePropertyCandidate(mapping, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static JsonObject BooleanDocument()
    {
        var snapshot = Snapshot([Entry(1, new ArticlePropertyBooleanValue(false))]);
        return Document(Component(Map(snapshot, Bindings(snapshot))));
    }

    private static JsonObject Document(ArticlePackageManifestPropertyCandidate candidate)
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WritePropertyCandidate(candidate))!.AsObject();
    private static byte[] Encode(JsonObject document) => Encoding.UTF8.GetBytes(document.ToJsonString());
    private static void Reject(JsonObject document) => RejectBytes(Encode(document));
    private static void RejectBytes(byte[] bytes)
    {
        var result = ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(bytes, out var candidate);
        Assert.False(result.IsValid);
        Assert.NotNull(result.ReasonCode);
        Assert.Null(candidate);
    }

    private static void Reseal(JsonObject document)
    {
        document.Remove("componentDigest");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes(ArticlePackageManifestCandidateCodec.PropertyComponentDigestDomain + "\0"));
        hash.AppendData(Encode(document));
        document["componentDigest"] = Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    private static ArticlePackagePropertyMappingCandidate Map(
        ArticlePropertyValueSnapshot snapshot,
        ArticlePackagePropertyMappingBindings bindings)
    {
        ArticlePackagePropertyMappingResult result = ArticlePackagePropertyMapper.TryMapCandidate(snapshot, bindings, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackagePropertyMappingCandidate>(candidate);
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
