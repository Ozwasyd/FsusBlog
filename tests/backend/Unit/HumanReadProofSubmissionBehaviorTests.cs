using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HumanReadProofSubmissionBehaviorTests
{
    [Fact]
    public async Task SubmitAsync_ValidArticleProofWritesExactlyOneEventAndUsesBoundedLeases()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9000));

        Assert.True(submit.Counted);
        Assert.Equal("counted", submit.Status);
        Assert.True(harness.Channel.Reader.TryRead(out VisitLogMessage message));
        Assert.Equal(HumanReadEventTypes.ArticleRead, message.EventType);
        Assert.Equal(42, message.ArticleId);
        Assert.Equal(64, Assert.IsType<string>(message.ViewerKeyHash).Length);
        Assert.Equal(64, Assert.IsType<string>(message.ProofId).Length);
        Assert.False(harness.Channel.Reader.TryRead(out _));
        Assert.Contains(
            harness.Cache.Acquisitions,
            item => item.Acquired && item.Identity.StartsWith("proof:", StringComparison.Ordinal) && item.Ttl == TimeSpan.FromMinutes(10));
        Assert.Contains(
            harness.Cache.Acquisitions,
            item => item.Acquired && item.Identity.StartsWith("viewer:", StringComparison.Ordinal) && item.Ttl == TimeSpan.FromHours(24));
    }

    [Fact]
    public async Task SubmitAsync_ReplayedProofDoesNotWriteSecondEvent()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));
        var request = new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 9000);

        HumanReadSubmitResponse first = await harness.Service.SubmitAsync(harness.CreateBrowserContext(), request);
        HumanReadSubmitResponse second = await harness.Service.SubmitAsync(harness.CreateBrowserContext(), request);

        Assert.True(first.Counted);
        Assert.False(second.Counted);
        Assert.Equal("proof_replayed", second.Status);
        Assert.True(harness.Channel.Reader.TryRead(out _));
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_TamperedRouteDoesNotWriteEvent()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:43", 43, 9000));

        Assert.False(submit.Counted);
        Assert.Equal("proof_invalid", submit.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_DwellShorterThanChallengeMinimumIsRejected()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromSeconds(3));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 3000));

        Assert.False(submit.Counted);
        Assert.Equal("dwell_too_short", submit.Status);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_ExpiredChallengeIsRejectedBeforeReplayLease()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("site", "home", null)));
        harness.Time.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromMilliseconds(1));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(challenge.Token, "site", "home", null, 300001));

        Assert.False(submit.Counted);
        Assert.Equal("proof_expired", submit.Status);
        Assert.Empty(harness.Cache.Acquisitions);
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }

    [Fact]
    public async Task SubmitAsync_DifferentProofForSameViewerIsDeduplicated()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse firstChallenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        HumanReadChallengeResponse secondChallenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateBrowserContext(),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse first = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(firstChallenge.Token, "article", "article:42", 42, 9000));
        HumanReadSubmitResponse second = await harness.Service.SubmitAsync(
            harness.CreateBrowserContext(),
            new HumanReadSubmitRequest(secondChallenge.Token, "article", "article:42", 42, 9000));

        Assert.True(first.Counted);
        Assert.False(second.Counted);
        Assert.Equal("duplicate_viewer", second.Status);
        Assert.True(harness.Channel.Reader.TryRead(out _));
        Assert.False(harness.Channel.Reader.TryRead(out _));
    }
}
