using System.Text.Json.Nodes;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BackendTestGovernanceTests
{
    private const string RequirementsFixturePath = "tests/backend/Fixtures/backend-test-requirements.json";

    [Fact]
    public void Issue40Profiles_HaveCommandsRequirementsAndEvidence()
    {
        JsonArray profiles = ReadRequirementsFixture()["profiles"]!.AsArray();
        var requirementIds = ReadRequirementsFixture()["requirements"]!
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
        JsonArray requirements = ReadRequirementsFixture()["requirements"]!.AsArray();
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
        string root = BackendTestPaths.RepositoryRoot;
        var expected = Directory
            .EnumerateFiles(BackendTestPaths.FromRoot("src", "backend", "Modules", "Endpoints"), "*.cs", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(root, path).Replace('\\', '/'))
            .Where(static path => !path.EndsWith("Adapters.cs", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();

        var actual = ReadRequirementsFixture()["endpointFamilies"]!
            .AsArray()
            .Select(static node => node!["path"]!.GetValue<string>())
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(expected, actual);
    }

    private static void AssertEvidencePathsExist(JsonArray paths)
    {
        Assert.NotEmpty(paths);
        foreach (JsonNode? path in paths)
        {
            string relativePath = path!.GetValue<string>();
            string fullPath = BackendTestPaths.FromRoot(relativePath);
            Assert.True(File.Exists(fullPath) || Directory.Exists(fullPath), $"missing evidence path {relativePath}");
        }
    }

    private static JsonObject ReadRequirementsFixture()
        => BackendTestPaths.ReadJsonFromRoot(RequirementsFixturePath);
}
