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

    private static JsonObject ReadGoldenCatalog()
        => BackendTestPaths.ReadJsonFromRoot(GoldenCatalogPath);
}
