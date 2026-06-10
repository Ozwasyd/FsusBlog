using System.Text.Json.Nodes;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BackendTestGovernanceTests
{
    [Fact]
    public void Issue40Profiles_HaveCommandsRequirementsAndEvidence()
    {
        JsonArray profiles = ReadJson("tests/backend/Fixtures/backend-test-requirements.json")["profiles"]!.AsArray();
        var requirementIds = ReadJson("tests/backend/Fixtures/backend-test-requirements.json")["requirements"]!
            .AsArray()
            .Select(static node => node!["id"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);

        Assert.True(profiles.Count >= 10);

        foreach (JsonObject profile in profiles.Select(static node => node!.AsObject()))
        {
            Assert.StartsWith("backend-", profile["id"]!.GetValue<string>(), StringComparison.Ordinal);
            Assert.StartsWith("tools/test/", profile["command"]!.GetValue<string>(), StringComparison.Ordinal);
            Assert.False(string.IsNullOrWhiteSpace(profile["risk"]!.GetValue<string>()));

            JsonArray requirements = profile["requirements"]!.AsArray();
            Assert.NotEmpty(requirements);
            foreach (JsonNode? requirement in requirements)
            {
                Assert.Contains(requirement!.GetValue<string>(), requirementIds);
            }

            AssertEvidencePathsExist(profile["evidencePaths"]!.AsArray());
        }
    }

    [Fact]
    public void Issue40Requirements_HaveEvidenceAndRiskTraceability()
    {
        JsonArray requirements = ReadJson("tests/backend/Fixtures/backend-test-requirements.json")["requirements"]!.AsArray();
        var ids = new HashSet<string>(StringComparer.Ordinal);

        Assert.True(requirements.Count >= 30);
        foreach (JsonObject requirement in requirements.Select(static node => node!.AsObject()))
        {
            string id = requirement["id"]!.GetValue<string>();
            Assert.True(ids.Add(id), $"duplicate backend requirement {id}");
            Assert.StartsWith("BACKEND-", id, StringComparison.Ordinal);
            Assert.False(string.IsNullOrWhiteSpace(requirement["risk"]!.GetValue<string>()));
            Assert.False(string.IsNullOrWhiteSpace(requirement["coverage"]!.GetValue<string>()));
            AssertEvidencePathsExist(requirement["evidencePaths"]!.AsArray());
        }
    }

    [Fact]
    public void EndpointFamilies_CoverEveryEndpointFile()
    {
        string root = FindRepoRoot();
        var expected = Directory
            .EnumerateFiles(Path.Combine(root, "src/backend/Modules/Endpoints"), "*.cs", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(root, path).Replace('\\', '/'))
            .Where(static path => !path.EndsWith("Adapters.cs", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();

        var actual = ReadJson("tests/backend/Fixtures/backend-test-requirements.json")["endpointFamilies"]!
            .AsArray()
            .Select(static node => node!["path"]!.GetValue<string>())
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(expected, actual);
    }

    private static void AssertEvidencePathsExist(JsonArray paths)
    {
        Assert.NotEmpty(paths);
        string root = FindRepoRoot();
        foreach (JsonNode? path in paths)
        {
            string relativePath = path!.GetValue<string>();
            string fullPath = Path.Combine(root, relativePath);
            Assert.True(File.Exists(fullPath) || Directory.Exists(fullPath), $"missing evidence path {relativePath}");
        }
    }

    private static JsonObject ReadJson(string path)
        => JsonNode.Parse(File.ReadAllText(Path.Combine(FindRepoRoot(), path)))!.AsObject();

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
