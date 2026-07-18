using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class HumanReadProofRequestBindingTests
{
    [Fact]
    public async Task CreateChallengeAsync_MissingBrowserHeadersAreRejected()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        var contexts = new List<DefaultHttpContext>();

        DefaultHttpContext missingUserAgent = harness.CreateBrowserContext();
        missingUserAgent.Request.Headers.Remove("User-Agent");
        contexts.Add(missingUserAgent);

        DefaultHttpContext missingFetchMetadata = harness.CreateBrowserContext();
        missingFetchMetadata.Request.Headers.Remove("Sec-Fetch-Dest");
        contexts.Add(missingFetchMetadata);

        contexts.Add(harness.CreateBrowserContext(origin: null, referer: null));

        foreach (DefaultHttpContext context in contexts)
        {
            HumanReadChallengeResponse? challenge = await harness.Service.CreateChallengeAsync(
                context,
                new HumanReadChallengeRequest("site", "home", null));
            Assert.Null(challenge);
        }

        DefaultHttpContext noStableFingerprint = harness.CreateBrowserContext();
        noStableFingerprint.Request.Headers.Remove("X-Fsus-Device-Fp");
        Assert.NotNull(await harness.Service.CreateChallengeAsync(
            noStableFingerprint,
            new HumanReadChallengeRequest("site", "home", null)));
    }

    [Theory]
    [InlineData("http://localhost", null)]
    [InlineData(null, "http://localhost/article/42")]
    [InlineData("https://reader.example", null)]
    public async Task CreateChallengeAsync_CurrentOrConfiguredOriginAndRefererAreAccepted(
        string? origin,
        string? referer)
    {
        await using var harness = HumanReadProofTestHarness.Create(new Dictionary<string, string?>
        {
            ["CORS_ALLOWED_HOSTS"] = "https://reader.example"
        });

        HumanReadChallengeResponse? challenge = await harness.Service.CreateChallengeAsync(
            harness.CreateBrowserContext(origin: origin, referer: referer),
            new HumanReadChallengeRequest("site", "home", null));

        Assert.NotNull(challenge);
    }

    [Fact]
    public async Task CreateChallengeAsync_UntrustedOriginWithoutRefererIsRejected()
    {
        await using var harness = HumanReadProofTestHarness.Create();

        HumanReadChallengeResponse? challenge = await harness.Service.CreateChallengeAsync(
            harness.CreateBrowserContext(origin: "https://attacker.example", referer: null),
            new HumanReadChallengeRequest("site", "home", null));

        Assert.Null(challenge);
    }

    [Fact]
    public async Task SubmitAsync_DeviceFingerprintChangeDoesNotCreateCrossArticleIdentityBinding()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(deviceFingerprint: "fedcba9876543210fedcba9876543210"),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9000));

        Assert.True(submit.Counted);
        Assert.Equal("counted", submit.Status);
        Assert.True(harness.Channel.Reader.TryRead(out _));
    }

    [Theory]
    [InlineData("site", "home", 42)]
    [InlineData("article", "article:42", null)]
    [InlineData("article", "article:42", 0)]
    [InlineData("other", "home", null)]
    public async Task CreateChallengeAsync_InvalidScopeArticleCombinationsAreRejected(
        string scope,
        string routeKey,
        int? articleId)
    {
        await using var harness = HumanReadProofTestHarness.Create();

        HumanReadChallengeResponse? challenge = await harness.Service.CreateChallengeAsync(
            harness.CreateBrowserContext(),
            new HumanReadChallengeRequest(scope, routeKey, articleId));

        Assert.Null(challenge);
    }

    [Fact]
    public async Task SubmitAsync_ChangedScopeAndArticleAreRejected()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 9000));

        Assert.False(submit.Counted);
        Assert.Equal("proof_invalid", submit.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }
}
