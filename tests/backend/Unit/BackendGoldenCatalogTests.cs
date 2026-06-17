using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class BackendGoldenCatalogTests
{
    [Fact]
    public void AedsGoldenCatalog_CoversEveryGeneratedFrameType()
    {
        JsonArray frames = ReadJson("tests/backend/Fixtures/aeds-golden-catalog.json")["frames"]!.AsArray();
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
        JsonArray frames = ReadJson("tests/backend/Fixtures/aeds-golden-catalog.json")["frames"]!.AsArray();
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
        JsonArray evidence = ReadJson("tests/backend/Fixtures/aeds-golden-catalog.json")["defaultEvidence"]!.AsArray();

        foreach (JsonNode? path in evidence)
        {
            Assert.True(
                File.Exists(Path.Combine(FindRepoRoot(), path!.GetValue<string>())),
                $"missing AEDS golden evidence path {path}");
        }
    }

    private static JsonObject ReadJson(string path, [CallerFilePath] string sourceFilePath = "")
        => JsonNode.Parse(File.ReadAllText(Path.Combine(FindRepoRoot(sourceFilePath), path)))!.AsObject();

    private static string FindRepoRoot([CallerFilePath] string sourceFilePath = "")
    {
        var directory = new DirectoryInfo(Path.GetDirectoryName(sourceFilePath) ?? AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "FsusBlog.slnx")) ||
                Directory.Exists(Path.Combine(directory.FullName, ".git")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
