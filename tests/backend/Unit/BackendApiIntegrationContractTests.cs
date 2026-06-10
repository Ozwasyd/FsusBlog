using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "ApiIntegration")]
public sealed partial class BackendApiIntegrationContractTests
{
    [Fact]
    public void BinaryEndpointFrameTypes_AreCoveredByAedsGoldenCatalog()
    {
        string root = FindRepoRoot();
        var goldenFrames = ReadJson("tests/backend/Fixtures/aeds-golden-catalog.json")["frames"]!
            .AsArray()
            .Select(static node => node!["name"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);

        foreach (string path in Directory.EnumerateFiles(Path.Combine(root, "src/backend/Modules/Endpoints/Binary"), "*.cs"))
        {
            string source = File.ReadAllText(path);
            foreach (Match match in AedsFrameTypeRegex().Matches(source))
            {
                string frameName = match.Groups[1].Value;
                Assert.Contains(frameName, goldenFrames);
            }
        }
    }

    [Fact]
    public void EndpointFamilies_ReferenceKnownIssue40Requirements()
    {
        JsonObject catalog = ReadJson("tests/backend/Fixtures/backend-test-requirements.json");
        var knownRequirements = catalog["requirements"]!
            .AsArray()
            .Select(static node => node!["id"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);

        foreach (JsonObject endpoint in catalog["endpointFamilies"]!.AsArray().Select(static node => node!.AsObject()))
        {
            Assert.True(File.Exists(Path.Combine(FindRepoRoot(), endpoint["path"]!.GetValue<string>())));
            JsonArray requirements = endpoint["requirements"]!.AsArray();
            Assert.NotEmpty(requirements);
            foreach (JsonNode? requirement in requirements)
            {
                Assert.Contains(requirement!.GetValue<string>(), knownRequirements);
            }
        }
    }

    [Fact]
    public void BackendProfiles_AreRepresentedInTestMatrix()
    {
        string matrix = File.ReadAllText(Path.Combine(FindRepoRoot(), "tests/matrix.yml"));
        JsonArray profiles = ReadJson("tests/backend/Fixtures/backend-test-requirements.json")["profiles"]!.AsArray();

        foreach (JsonObject profile in profiles.Select(static node => node!.AsObject()))
        {
            string id = profile["id"]!.GetValue<string>();
            string command = profile["command"]!.GetValue<string>();

            Assert.Contains($"id: {id}", matrix, StringComparison.Ordinal);
            Assert.Contains($"command: {command}", matrix, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void BinaryAdminMutationFiles_RetainAuthorizationAndPowBoundaries()
    {
        string root = FindRepoRoot();
        string articles = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs"));
        string auth = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs"));
        string users = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AdminUsers.cs"));

        Assert.Contains(".RequireAuthorization(policy => policy.RequireRole(\"admin\"))", articles, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RequiresPowFilter>()", articles, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RequiresPowFilter>()", auth, StringComparison.Ordinal);
        Assert.Contains(".RequireAuthorization(policy => policy.RequireRole(\"admin\"))", users, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RequiresPowFilter>()", users, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicRelatedReadingBinaryEndpoint_RetainsPublicReadBoundariesAndApiError()
    {
        string root = FindRepoRoot();
        string articles = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs"));

        Assert.Contains("\"/article/{articleId:int}/related.aeds\"", articles, StringComparison.Ordinal);
        Assert.Contains("RelatedReadingService service", articles, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.ArticleRelatedReading", articles, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteRelatedReading", articles, StringComparison.Ordinal);
        Assert.Contains("ErrorCode.NotFound, \"article_not_found\"", articles, StringComparison.Ordinal);
        Assert.Contains(".AllowAnonymous()", articles, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"public_read\")", articles, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RiskAwarePublicReadFilter>()", articles, StringComparison.Ordinal);
        Assert.Contains("CacheTag.ArticleList.ToOutputCacheTag()", articles, StringComparison.Ordinal);
    }

    [Fact]
    public void HumanReadProofBinaryEndpoints_RetainSecurityBoundariesAndApiError()
    {
        string root = FindRepoRoot();
        string readProof = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.ReadProof.cs"));

        Assert.Contains("\"/read-proof/challenge.aeds\"", readProof, StringComparison.Ordinal);
        Assert.Contains("\"/read-proof/submit.aeds\"", readProof, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.HumanReadChallengeRequest", readProof, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.HumanReadChallengeResponse", readProof, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.HumanReadSubmitRequest", readProof, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.HumanReadSubmitResponse", readProof, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.TryDecodeHumanReadChallengeRequest", readProof, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.TryDecodeHumanReadSubmitRequest", readProof, StringComparison.Ordinal);
        Assert.Contains("BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, \"read_proof_challenge_request_invalid\")", readProof, StringComparison.Ordinal);
        Assert.Contains("BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, \"read_proof_submit_request_invalid\")", readProof, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"read_proof\")", readProof, StringComparison.Ordinal);
        Assert.Contains("IHumanReadProofEndpointAdapter", readProof, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", readProof, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.HumanReadProof", readProof, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.ReadProofRejected", readProof, StringComparison.Ordinal);
    }

    [GeneratedRegex(@"AedsFrameType\.([A-Za-z0-9_]+)", RegexOptions.CultureInvariant)]
    private static partial Regex AedsFrameTypeRegex();

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
