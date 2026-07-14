using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicOriginPolicyTests
{
    [Fact]
    public void Resolve_UsesConfiguredOriginWhenStoredValueIsOnlyTheProjectPlaceholder()
        => Assert.Equal(
            "https://selfhost.example",
            PublicOriginPolicy.Resolve("https://selfhost.example/", "https://fsus.blog", "https://example.com"));

    [Fact]
    public void Resolve_RejectsConflictingStoredOrArtifactOrigins()
    {
        InvalidOperationException stored = Assert.Throws<InvalidOperationException>(() =>
            PublicOriginPolicy.Resolve("https://public.example", "https://other.example"));
        Assert.StartsWith("public_origin_conflict:", stored.Message, StringComparison.Ordinal);

        InvalidOperationException artifact = Assert.Throws<InvalidOperationException>(() =>
            PublicOriginPolicy.Resolve("https://public.example", "https://fsus.blog", "https://artifact.example"));
        Assert.StartsWith("public_origin_conflict:", artifact.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://example.test/path")]
    [InlineData("https://user@example.test")]
    [InlineData("https://example.test?x=1")]
    [InlineData("ftp://example.test")]
    public void Resolve_RejectsValuesThatAreNotOrigins(string value)
        => Assert.Throws<InvalidOperationException>(() => PublicOriginPolicy.Resolve(value, null));
}
