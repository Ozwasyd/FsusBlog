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

        Assert.Equal(["Capabilities", "Namespace", "RunId"], propertyNames);
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
}
