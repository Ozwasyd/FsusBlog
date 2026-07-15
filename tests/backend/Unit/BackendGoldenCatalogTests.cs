using System.Text.Json.Nodes;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class BackendGoldenCatalogTests
{
    private const string GoldenCatalogPath = "tests/backend/Fixtures/aeds-golden-catalog.json";

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

        Assert.True(retiredValues.SetEquals([40, 43, 44, 45, 46]));
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
    public void AnonymousPrivacyContractMatrix_RegistersCircuitNativeGroth16ProductionLayout()
    {
        string matrix = BackendTestPaths.ReadAllTextFromRoot("tests/frontend/fixtures/cross-stack-contract-matrix.json");

        Assert.Contains("\"circuitId\": \"fsus.anonymous.comment.v3\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"publicInputLayoutVersion\": 4", matrix, StringComparison.Ordinal);
        Assert.Contains("\"maxCircuitNativeIssuerSignatureBytes\": 256", matrix, StringComparison.Ordinal);
        Assert.Contains("\"maxCircuitNativeCredentialRequestBytes\": 256", matrix, StringComparison.Ordinal);
        Assert.Contains("\"maxGroth16ProofBytes\": 4096", matrix, StringComparison.Ordinal);
        Assert.Contains("\"anonymousTicketPublicInputs\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"credential_root\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"revocation_root\"", matrix, StringComparison.Ordinal);
        Assert.Contains("\"nullifier_hash\"", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("\"credential_commitment\"", matrix, StringComparison.Ordinal);
    }

    private static JsonObject ReadGoldenCatalog()
        => BackendTestPaths.ReadJsonFromRoot(GoldenCatalogPath);
}
