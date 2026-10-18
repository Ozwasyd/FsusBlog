using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageManifestVersionRegistryTests
{
    [Fact]
    public void Registry_RegistersOnlyExplicitImplementedRootIdentities()
    {
        Assert.Equal(3, ArticlePackageManifestVersionRegistry.Registrations.Count);
        ArticlePackageManifestVersionRegistration registration = ArticlePackageManifestVersionRegistry.Registrations[0];
        var assetRoot = ArticlePackageManifestVersionRegistry.AssetCollection;
        Assert.Same(assetRoot, ArticlePackageManifestVersionRegistry.Registrations[1]);
        Assert.Equal(new(2, 1, 1), assetRoot.Versions);
        Assert.True(ArticlePackageManifestVersionRegistry.TryGetRegistration(new(2, 1, 1), out var assets));
        Assert.Same(assetRoot, assets);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Identity,
            ArticlePackageManifestVersionRegistry.GetDisposition(new(2, 1, 1), new(2, 1, 1)));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(new(1, 1, 1), new(2, 1, 1)));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(new(2, 1, 1), new(1, 1, 1)));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(new(2, 1, 1), new(2, 1, 1), requiresLossyConversion: true));
        Assert.Same(registration, ArticlePackageManifestVersionRegistry.Current);
        Assert.Equal(new(1, 1, 1), registration.Versions);
        Assert.Equal(ArticleCanonicalHashV1.HashVersion, registration.Versions.CanonicalHashVersion);
        Assert.Equal(ArticlePropertyValueSnapshot.CurrentSchemaVersion, registration.Versions.PropertySchemaVersion);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Identity, registration.Disposition);
        Assert.True(ArticlePackageManifestVersionRegistry.TryGetRegistration(new(1, 1, 1), out var found));
        Assert.Same(registration, found);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Identity,
            ArticlePackageManifestVersionRegistry.GetDisposition(new(1, 1, 1), new(1, 1, 1)));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused, default);
    }

    [Fact]
    public void Registry_PropertyPayloadIsIdentityOnlyAndNeverReinterpretsV1OrV2()
    {
        var property = ArticlePackageManifestVersionRegistry.PropertyPayload;
        Assert.Same(property, ArticlePackageManifestVersionRegistry.Registrations[2]);
        Assert.Equal(new(3, 1, 1), property.Versions);
        Assert.True(ArticlePackageManifestVersionRegistry.TryGetRegistration(property.Versions, out var registered));
        Assert.Same(property, registered);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Identity,
            ArticlePackageManifestVersionRegistry.GetDisposition(property.Versions, property.Versions));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(property.Versions, property.Versions, true));
        foreach (var old in new[] { ArticlePackageManifestVersionRegistry.Current, ArticlePackageManifestVersionRegistry.AssetCollection })
        {
            Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
                ArticlePackageManifestVersionRegistry.GetDisposition(old.Versions, property.Versions));
            Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
                ArticlePackageManifestVersionRegistry.GetDisposition(property.Versions, old.Versions));
        }
    }

    [Fact]
    public void Registry_IsImmutableAndTupleCopiesCannotRegisterVersions()
    {
        IReadOnlyList<ArticlePackageManifestVersionRegistration> registrations = ArticlePackageManifestVersionRegistry.Registrations;
        ArticlePackageManifestVersionRegistration current = ArticlePackageManifestVersionRegistry.Current;
        var list = Assert.IsAssignableFrom<IList<ArticlePackageManifestVersionRegistration>>(registrations);
        Assert.True(list.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => list[0] = current);
        Assert.Throws<NotSupportedException>(() => list.Add(current));
        Assert.Throws<NotSupportedException>(() => list.RemoveAt(0));
        Assert.Throws<NotSupportedException>(() => list.Clear());
        Assert.True(((IList)registrations).IsReadOnly);
        Assert.Empty(typeof(ArticlePackageManifestVersionRegistration).GetConstructors());
        Assert.All(typeof(ArticlePackageManifestVersionRegistration).GetProperties(), property => Assert.False(property.CanWrite));
        Assert.All(typeof(ArticlePackageManifestVersionRegistry).GetProperties(), property => Assert.False(property.CanWrite));
        ArticlePackageManifestVersions copy = current.Versions with
        {
            SchemaVersion = 4
        };
        Assert.False(ArticlePackageManifestVersionRegistry.TryGetRegistration(copy, out var refused));
        Assert.Null(refused);
        Assert.Equal(new(1, 1, 1), registrations[0].Versions);
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(0, 1, 1)]
    [InlineData(1, 0, 1)]
    [InlineData(1, 1, 0)]
    [InlineData(2, 2, 2)]
    [InlineData(4, 1, 1)]
    [InlineData(1, 2, 1)]
    [InlineData(1, 1, 2)]
    [InlineData(-1, 1, 1)]
    [InlineData(1, -1, 1)]
    [InlineData(1, 1, -1)]
    [InlineData(int.MaxValue, int.MaxValue, int.MaxValue)]
    [InlineData(int.MinValue, int.MinValue, int.MinValue)]
    public void RegistryAndParser_RefuseEveryUnregisteredSourceAndTarget(int schema, int canonical, int property)
    {
        var unknown = new ArticlePackageManifestVersions(schema, canonical, property);
        var implemented = new ArticlePackageManifestVersions(1, 1, 1);
        Assert.False(ArticlePackageManifestVersionRegistry.TryGetRegistration(unknown, out var registration));
        Assert.Null(registration);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(unknown, implemented));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(implemented, unknown));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(unknown, unknown));
        JsonObject document = Document();
        document["schemaVersion"] = schema;
        document["canonicalHashVersion"] = canonical;
        document["propertySchemaVersion"] = property;
        AssertRefused(JsonSerializer.SerializeToUtf8Bytes(document), "article_package_manifest_version_unsupported");
    }

    [Fact]
    public void Registry_RefusesLossyRequestsEvenForImplementedIdentity()
    {
        var implemented = new ArticlePackageManifestVersions(1, 1, 1);
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(implemented, implemented, requiresLossyConversion: true));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(default, implemented, requiresLossyConversion: true));
        Assert.Equal(ArticlePackageManifestMigrationDisposition.Refused,
            ArticlePackageManifestVersionRegistry.GetDisposition(implemented, default, requiresLossyConversion: true));
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("canonicalHashVersion")]
    [InlineData("propertySchemaVersion")]
    public void Parser_RequiresEveryVersionField(string field)
    {
        JsonObject document = Document();
        Assert.True(document.Remove(field));
        AssertRefused(JsonSerializer.SerializeToUtf8Bytes(document), "article_package_manifest_missing_field");
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("canonicalHashVersion")]
    [InlineData("propertySchemaVersion")]
    public void Parser_RejectsLiteralAndEscapedDuplicateVersionFields(string field)
    {
        string json = Encoding.UTF8.GetString(ArticlePackageManifestCandidateCodec.WriteCandidate(Create()));
        foreach (string name in new[] { field, "\\u" + ((int)field[0]).ToString("x4") + field[1..] })
        {
            AssertRefused(Encoding.UTF8.GetBytes(json.Insert(1, $"\"{name}\":1,")), "article_package_manifest_duplicate_field");
        }
    }

    [Theory]
    [InlineData("schemaVersion")]
    [InlineData("canonicalHashVersion")]
    [InlineData("propertySchemaVersion")]
    public void Parser_RejectsOverflowFractionalAndMistypedVersions(string field)
    {
        string[] values = ["2147483648", "-2147483649", "99999999999999999999999999", "1.0", "1e0", "1.5", "null", "\"1\"", "true", "[]", "{}"];
        foreach (string value in values)
        {
            JsonObject document = Document();
            document[field] = JsonNode.Parse(value);
            AssertRefused(JsonSerializer.SerializeToUtf8Bytes(document), "article_package_manifest_version_unsupported");
        }
    }

    [Fact]
    public void Codec_UsesRegisteredVersionsAndPreservesExactMetadataAcrossRepeatedIdentityRoundTrips()
    {
        byte[] markdown = Encoding.UTF8.GetBytes("\ufeff# café  \r\nline\t\nlast\rend \t");
        Assert.True(ArticlePackageSourceBytes.Inspect(markdown, out var metadata).IsValid);
        var expected = new ArticlePackageByteMetadata(markdown.Length, Convert.ToHexStringLower(SHA256.HashData(markdown)),
            true, 1, 1, 1, ArticlePackageFinalNewline.None, 3, 2);
        Assert.Equal(expected, metadata);
        ArticlePackageManifestCandidate candidate = Create(metadata);
        byte[] original = ArticlePackageManifestCandidateCodec.WriteCandidate(candidate);
        string digest = candidate.SemanticDigest;
        ArticlePackageManifestVersions registered = ArticlePackageManifestVersionRegistry.Current.Versions;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Assert.Equal(registered, new(candidate.SchemaVersion, candidate.CanonicalHashVersion, candidate.PropertySchemaVersion));
            using JsonDocument document = JsonDocument.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(candidate));
            Assert.Equal(registered.SchemaVersion, document.RootElement.GetProperty("schemaVersion").GetInt32());
            Assert.Equal(registered.CanonicalHashVersion, document.RootElement.GetProperty("canonicalHashVersion").GetInt32());
            Assert.Equal(registered.PropertySchemaVersion, document.RootElement.GetProperty("propertySchemaVersion").GetInt32());
            Assert.True(ArticlePackageManifestCandidateCodec.TryParseCandidate(original, out var parsed).IsValid);
            Assert.Equal(candidate.Articles[0], parsed!.Articles[0]);
            Assert.Equal(expected, parsed.Articles[0].SourceBytes);
            Assert.True(ArticlePackageSourceBytes.Verify(markdown, parsed.Articles[0].SourceBytes).IsValid);
            Assert.Equal(digest, parsed.SemanticDigest);
            Assert.Equal(original, ArticlePackageManifestCandidateCodec.WriteCandidate(parsed));
            candidate = parsed;
        }
    }

    [Theory]
    [InlineData("byteLength", "7")]
    [InlineData("sha256", "\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"")]
    [InlineData("hasUtf8Bom", "true")]
    [InlineData("lfCount", "1")]
    [InlineData("crLfCount", "0")]
    [InlineData("bareCrCount", "1")]
    [InlineData("finalNewline", "0")]
    [InlineData("trailingSpaceCount", "1")]
    [InlineData("trailingTabCount", "1")]
    public void Parser_RejectsModifiedByteMetadataWithOriginalSemanticDigest(string field, string value)
    {
        JsonObject document = Document();
        document["articles"]![0]!["sourceBytes"]![field] = JsonNode.Parse(value);
        AssertRefused(JsonSerializer.SerializeToUtf8Bytes(document), "article_package_manifest_semantic_digest_mismatch");
    }

    [Theory]
    [InlineData("root")]
    [InlineData("article")]
    public void Parser_RefusesUnknownFieldsInsteadOfDowngrading(string level)
    {
        JsonObject document = Document();
        JsonObject target = level == "root" ? document : document["articles"]![0]!.AsObject();
        target["futureVersionData"] = null;
        AssertRefused(JsonSerializer.SerializeToUtf8Bytes(document), "article_package_manifest_unknown_field");
    }

    [Theory]
    [InlineData("")]
    [InlineData("{\"schemaVersion\":")]
    [InlineData("/*comment*/{}")]
    [InlineData("{\"schemaVersion\":1,}")]
    [InlineData("{\"schemaVersion\":01}")]
    public void Parser_RefusesMalformedJson(string json)
    {
        AssertRefused(Encoding.UTF8.GetBytes(json), "article_package_manifest_json_invalid");
    }

    [Fact]
    public void Serializer_RechecksNullMalformedAndModifiedCandidates()
    {
        Assert.Equal("article_package_manifest_candidate_invalid",
            Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(null!)).Message);
        ArticlePackageManifestCandidate valid = Create();
        ConstructorInfo constructor = Assert.Single(typeof(ArticlePackageManifestCandidate).GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance));
        ArticlePackageManifestArticle article = valid.Articles[0];
        var invalidDigest = (ArticlePackageManifestCandidate)constructor.Invoke([new[] { article }, new string('0', 64)]);
        Assert.Equal("article_package_manifest_candidate_invalid",
            Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(invalidDigest)).Message);
        ArticlePackageManifestArticle[][] inputs = [[article with { Title = "modified" }], [article with { SourceBytes = null! }]];
        foreach (ArticlePackageManifestArticle[] articles in inputs)
        {
            var invalid = (ArticlePackageManifestCandidate)constructor.Invoke([articles, valid.SemanticDigest]);
            Assert.Equal("article_package_manifest_candidate_invalid",
                Assert.Throws<ArgumentException>(() => ArticlePackageManifestCandidateCodec.WriteCandidate(invalid)).Message);
        }
    }

    private static ArticlePackageManifestCandidate Create(ArticlePackageByteMetadata? metadata = null)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            "article:01991e72-9a2c-7b60-8f47-b339f58e4a11", out var identity).IsValid);
        if (metadata is null)
        {
            Assert.True(ArticlePackageSourceBytes.Inspect("line\r\n"u8, out metadata).IsValid);
        }
        var article = new ArticlePackageManifestArticle(identity,
            new(1, 11, 2, new string('a', 64), "site", 4, null, null, null),
            "Title", null, new string('b', 64), new string('c', 64), new string('d', 64), metadata!, new(0, null, null));
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryCreateCandidate([article], out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return candidate!;
    }

    private static JsonObject Document()
        => JsonNode.Parse(ArticlePackageManifestCandidateCodec.WriteCandidate(Create()))!.AsObject();

    private static void AssertRefused(byte[] json, string reason)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidateCodec.TryParseCandidate(json, out var candidate);
        Assert.False(result.IsValid);
        Assert.Null(candidate);
        Assert.Equal(reason, result.ReasonCode);
    }
}
