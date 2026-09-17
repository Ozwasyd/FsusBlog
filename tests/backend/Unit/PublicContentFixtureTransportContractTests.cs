using System.Text.Json;

using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicContentFixtureTransportContractTests
{
    [Fact]
    public void PublicContentRequest_IsNarrowAndDoesNotInterpretFixtureVariants()
    {
        string[] propertyNames = typeof(PublicContentFixtureRequest)
            .GetProperties()
            .Select(static property => property.Name)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            ["Capabilities", "Namespace", "RunId", "SecurityMatrix", "TemporalContext"],
            propertyNames);
        Assert.DoesNotContain(propertyNames, static name =>
            name.Contains("Variant", StringComparison.Ordinal)
            || name.Contains("Digest", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("""{"capabilities":["public.article.published"],"variantIds":["unregistered.fixture.variant"]}""")]
    [InlineData("""{"capabilities":["public.article.published"],"variantPlanDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}""")]
    public void PublicContentRequest_RejectsVariantFieldsOwnedByTheTypedPlanAuthority(string json)
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<PublicContentFixtureRequest>(
                json,
                LocalPublicContentFixtureEndpoints.s_requestJsonOptions));
    }

    [Fact]
    public void PublicContentRequest_AcceptsBoundedSecurityMatrixSeed()
    {
        const string Json = """
            {
              "capabilities": ["public.article.published"],
              "namespace": "xss-run",
              "runId": "run-1",
              "securityMatrix": {
                "cases": [{"id":"mxss-raw-event","category":"raw-event","markdown":"<img src=x>"}],
                "aboutMarkdown": "# About",
                "metadataText": "<img src=x>"
              }
            }
            """;

        PublicContentFixtureRequest? request = JsonSerializer.Deserialize<PublicContentFixtureRequest>(
            Json,
            LocalPublicContentFixtureEndpoints.s_requestJsonOptions);

        Assert.NotNull(request?.SecurityMatrix);
        Assert.Single(request.SecurityMatrix.Cases);
    }
}
