using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class BackendGoldenCatalogTests
{
    private const string GoldenCatalogPath = "tests/backend/Fixtures/aeds-golden-catalog.json";
    private const int RetainedFrameCount = 236;
    private const string RetainedFrameOracleSha256 = "14186d7a265c139b9e45a3f631d2761654c73952de0c576507167940b8d87407";

    [Theory]
    [InlineData("AuthorArticleSelectionRevalidateRequest", 276, 267)]
    [InlineData("AuthorArticleSelectionRevalidateResponse", 277, 268)]
    public void SelectionFrames_RetainIndependentNumericFamilyAndOrder(string name, int number, int order)
    {
        JsonArray frames = ReadGoldenCatalog()["frames"]!.AsArray();
        JsonObject entry = frames[order]!.AsObject();
        Assert.Equal(name, entry["name"]!.GetValue<string>());
        Assert.Equal(number, entry["value"]!.GetValue<int>());
        Assert.Equal(number, (int)Enum.Parse<AedsFrameType>(name));
        Assert.Equal("author-article-selection", entry["family"]!.GetValue<string>());
    }

    [Fact]
    public void AedsGoldenCatalog_RetainsIndependentNumericFamilyAndOrderOracle()
    {
        JsonArray frames = ReadGoldenCatalog()["frames"]!.AsArray();

        Assert.True(frames.Count >= RetainedFrameCount);
        Assert.Equal(RetainedFrameOracleSha256, ComputeRetainedFrameOracleDigest(frames));
    }

    [Theory]
    [InlineData("FontRegistryList", 244, "font-registry-response")]
    [InlineData("FontRegistryDetail", 245, "font-registry-response")]
    [InlineData("FontActivationList", 246, "font-activation-response")]
    [InlineData("ThemeRegistryList", 247, "theme-registry-response")]
    [InlineData("ThemeRegistryDetail", 248, "theme-registry-response")]
    [InlineData("ThemeActivationList", 249, "theme-activation-response")]
    [InlineData("ThemeActivation", 250, "theme-activation-response")]
    [InlineData("ThemeActivationHistory", 252, "theme-activation-response")]
    public void AedsGoldenCatalog_FontAndThemeFramesRetainIndependentLiteralOracles(
        string frameName,
        int expectedValue,
        string expectedFamily)
    {
        JsonObject frame = ReadGoldenCatalog()["frames"]!.AsArray()
            .Select(static entry => entry!.AsObject())
            .Single(entry => entry["name"]!.GetValue<string>() == frameName);

        Assert.Equal(expectedValue, frame["value"]!.GetValue<int>());
        Assert.Equal(expectedValue, (int)Enum.Parse<AedsFrameType>(frameName));
        Assert.Equal(expectedFamily, frame["family"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("number")]
    [InlineData("family")]
    [InlineData("order")]
    public void AedsGoldenCatalog_IndependentOracleRejectsOtherwiseLegalRetainedFrameTamper(string mutation)
    {
        JsonArray frames = ReadGoldenCatalog()["frames"]!.AsArray();
        switch (mutation)
        {
            case "number":
                frames.Single(static frame => frame!["name"]!.GetValue<string>() == "ArticleHot")!["value"] = 65535;
                break;
            case "family":
                frames[0]!["family"] = "test-response";
                break;
            case "order":
                JsonNode first = frames[0]!;
                frames.RemoveAt(0);
                frames.Insert(1, first);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(mutation));
        }

        Assert.NotEqual(RetainedFrameOracleSha256, ComputeRetainedFrameOracleDigest(frames));
    }

    [Fact]
    public void AedsGoldenCatalog_CoversEveryGeneratedFrameType()
    {
        JsonArray frames = ReadGoldenCatalog()["frames"]!.AsArray();
        var byName = frames
            .Select(static node => node!.AsObject())
            .ToDictionary(
                static frame => frame["name"]!.GetValue<string>(),
                static frame => frame);

        foreach (AedsFrameType frameType in Enum.GetValues<AedsFrameType>())
        {
            string name = frameType.ToString();
            Assert.True(byName.TryGetValue(name, out JsonObject? entry), $"missing golden catalog entry for {name}");
            Assert.Equal((ushort)frameType, entry["value"]!.GetValue<int>());
            Assert.False(string.IsNullOrWhiteSpace(entry["family"]!.GetValue<string>()));
        }
    }

    [Fact]
    public void AedsGoldenCatalog_HasNoDuplicateFrameNumbersOrFamilies()
    {
        JsonArray frames = ReadGoldenCatalog()["frames"]!.AsArray();
        var values = new HashSet<int>();
        var names = new HashSet<string>(StringComparer.Ordinal);

        foreach (JsonObject frame in frames.Select(static node => node!.AsObject()))
        {
            Assert.True(names.Add(frame["name"]!.GetValue<string>()));
            Assert.True(values.Add(frame["value"]!.GetValue<int>()));
            Assert.False(string.IsNullOrWhiteSpace(frame["family"]!.GetValue<string>()));
        }
    }

    [Fact]
    public void AedsGoldenCatalog_ProtectsRetiredLegacyAuthFrameValues()
    {
        JsonObject catalog = ReadGoldenCatalog();
        JsonArray frames = catalog["frames"]!.AsArray();
        JsonArray retiredFrames = catalog["retiredFrameValues"]!.AsArray();
        var activeValues = frames
            .Select(static node => node!["value"]!.GetValue<int>())
            .ToHashSet();
        var retiredValues = retiredFrames
            .Select(static node => node!["value"]!.GetValue<int>())
            .ToHashSet();

        Assert.True(retiredValues.SetEquals([40, 43, 44, 45, 46, 180, 181]));
        foreach (int retired in retiredValues)
        {
            Assert.DoesNotContain(retired, activeValues);
        }

        foreach (JsonObject retired in retiredFrames.Select(static node => node!.AsObject()))
        {
            Assert.False(string.IsNullOrWhiteSpace(retired["reason"]!.GetValue<string>()));
        }

        Assert.Contains(
            retiredFrames.Select(static node => node!.AsObject()),
            static retired => retired["value"]!.GetValue<int>() == 40
                && retired["reason"]!.GetValue<string>() == "legacy-admin-password-reset");
    }

    [Fact]
    public void AedsGoldenCatalog_DefaultEvidencePathsExist()
    {
        JsonArray evidence = ReadGoldenCatalog()["defaultEvidence"]!.AsArray();

        foreach (JsonNode? path in evidence)
        {
            Assert.True(
                File.Exists(BackendTestPaths.FromRoot(path!.GetValue<string>())),
                $"missing AEDS golden evidence path {path}");
        }
    }

    [Fact]
    public void AnonymousPrivacyContractMatrix_RegistersBlindIssuanceAndPresentationLayout()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/frontend/fixtures/cross-stack-contract-matrix.json");

        Assert.Contains("\"circuitId\": \"fsus.anonymous.comment.v5\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"publicInputLayoutVersion\": 6", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("credential_epoch", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("credential_level", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("reputation_bucket", matrix, StringComparison.Ordinal);
        Assert.Contains("\"blindCredentialScheme\": \"rfc9474-rsabssa-sha384-pss-randomized-3072\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"blindRsaModulusBytes\": 384", matrix, StringComparison.Ordinal);
        Assert.Contains("\"maxGroth16ProofBytes\": 4096", matrix, StringComparison.Ordinal);
        Assert.Contains("\"anonymousTicketPublicInputs\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"credential_root\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"revocation_root\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"nullifier_hash\"", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("\"credential_commitment\"", matrix, StringComparison.Ordinal);
    }

    private static JsonObject ReadGoldenCatalog()
        => BackendTestPaths.ReadJsonFromRoot(GoldenCatalogPath);

    private static string ComputeRetainedFrameOracleDigest(JsonArray frames)
    {
        // This TestOwner seal is captured from the original fixture, never from a regenerated manifest.
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartArray();
            foreach (JsonNode? frame in frames.Take(RetainedFrameCount))
            {
                writer.WriteStartObject();
                writer.WriteString("name", frame!["name"]!.GetValue<string>());
                writer.WriteNumber("value", frame["value"]!.GetValue<int>());
                writer.WriteString("family", frame["family"]!.GetValue<string>());
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return Convert.ToHexStringLower(SHA256.HashData(output.ToArray()));
    }
}
