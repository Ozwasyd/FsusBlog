using System.Text.Json;

using FsusBlog.Server.Services.Fixtures;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticleLifecycleTemporalBridgeTests
{
    private static readonly string s_digest = "sha256:" + new string('a', 64);
    private static readonly string s_artifactDigest = "sha256:" + new string('b', 64);
    private static readonly DateTimeOffset s_created = new(2026, 9, 15, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset s_due = s_created.AddMinutes(1);

    [Theory]
    [InlineData(CanonicalArticleLifecycleVariants.Scheduled)]
    [InlineData(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate)]
    public async Task Scheduling_UsesResolvedUtcRoleAndPreservesWriterCoordinates(string variant)
    {
        ICanonicalArticleLifecycleFixturePort port = Substitute.For<ICanonicalArticleLifecycleFixturePort>();
        var bridge = Bridge(port, s_created);
        Guid requestId = Guid.NewGuid();
        CanonicalArticleLifecycleRequest request = new(Binding(), Plan(variant), requestId);
        CanonicalArticleLifecyclePlan expected = request.Plan with
        {
            ScheduledPublishAt = s_due.UtcDateTime
        };
        await bridge.ExecuteScheduledAsync(request, "article.created", "article.scheduled-due");
        await port.Received(1).ExecuteAsync(Arg.Is<CanonicalArticleLifecycleRequest>(actual =>
            actual.Binding == request.Binding && actual.RequestId == requestId
            && actual.Plan == expected), Arg.Any<CancellationToken>());
        Assert.Null(request.Plan.ScheduledPublishAt);
    }

    [Fact]
    public void Scheduling_RejectsClockRunContextAndSuppliedTimeDriftBeforeCallingPort()
    {
        ICanonicalArticleLifecycleFixturePort port = Substitute.For<ICanonicalArticleLifecycleFixturePort>();
        var request = new CanonicalArticleLifecycleRequest(Binding(), Plan(CanonicalArticleLifecycleVariants.Scheduled));
        AssertCode("temporal_role_clock_mismatch", () => Bridge(port, s_created.AddMilliseconds(1)).ExecuteScheduledAsync(request, "article.created", "article.scheduled-due"));
        AssertCode("temporal_role_binding_mismatch", () => Bridge(port, s_created).ExecuteScheduledAsync(request with { Binding = Binding() with { RunId = "other" } }, "article.created", "article.scheduled-due"));
        AssertCode("temporal_role_binding_mismatch", () => Bridge(port, s_created).ExecuteScheduledAsync(request with { Binding = Binding() with { TemporalContextDigest = s_artifactDigest } }, "article.created", "article.scheduled-due"));
        AssertCode("scheduled_role_plan_mismatch", () => Bridge(port, s_created).ExecuteScheduledAsync(request with { Plan = request.Plan with { ScheduledPublishAt = s_due.AddMilliseconds(1).UtcDateTime } }, "article.created", "article.scheduled-due"));
        AssertCode("scheduled_at_must_be_future", () => Bridge(port, s_created).ExecuteScheduledAsync(request, "article.created", "article.created"));
        Assert.Empty(port.ReceivedCalls());
    }

    [Fact]
    public async Task Publishing_PreservesOriginalReceiptAndDelegatesRealTransactionAndDueCheck()
    {
        ICanonicalArticleLifecycleFixturePort port = Substitute.For<ICanonicalArticleLifecycleFixturePort>();
        CanonicalArticleLifecycleFixtureBinding binding = Binding();
        var receipt = new CanonicalArticleLifecycleReceipt("schema", CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            s_digest, "run", "ns", "profile", "role", CanonicalArticleLifecycleVariants.Scheduled, 1, 42,
            [], [], [], 10, null, FsusBlog.Server.Entities.ArticleStatus.Scheduled, false, s_digest, s_digest, s_digest);
        var failure = new InvalidOperationException("formal transaction refused");
        port.PublishScheduledAsync(Arg.Any<CanonicalArticleLifecycleFixtureBinding>(), receipt, Arg.Any<CancellationToken>())
            .Returns(Task.FromException<CanonicalArticleLifecycleResult>(failure));
        Exception thrown = await Assert.ThrowsAsync<InvalidOperationException>(() => Bridge(port, s_due).PublishScheduledAsync(binding, receipt, "article.scheduled-due"));
        Assert.Same(failure, thrown);
        await port.Received(1).PublishScheduledAsync(binding, receipt, Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ArtifactIngress_RequiresSeparateRoleAndContextDigestsAndProducer()
    {
        ICanonicalArticleLifecycleFixturePort port = Substitute.For<ICanonicalArticleLifecycleFixturePort>();
        AssertCode("temporal_role_binding_mismatch", () => new CanonicalArticleLifecycleTemporalBridge(Artifact(), s_artifactDigest, s_digest, "other", port, new FixedClock(s_created)));
        AssertCode("temporal_role_binding_mismatch", () => new CanonicalArticleLifecycleTemporalBridge(Artifact(), s_artifactDigest, s_artifactDigest, "public-content", port, new FixedClock(s_created)));
        Assert.Throws<InvalidOperationException>(() => new CanonicalArticleLifecycleTemporalBridge(Artifact(), s_digest, s_digest, "public-content", port, new FixedClock(s_created)));
    }

    private static CanonicalArticleLifecycleTemporalBridge Bridge(ICanonicalArticleLifecycleFixturePort port, DateTimeOffset now)
        => new(Artifact(), s_artifactDigest, s_digest, "public-content", port, new FixedClock(now));

    private static string Artifact()
        => JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contentDigest = s_artifactDigest,
            contextIdentity = new
            {
                producerId = "public-content",
                schedulerRunId = "run",
                contextDigest = s_digest
            },
            roles = new[]
            {
                new { roleId = "article.created", instantUtc = "2026-09-15T12:00:00.000Z", clockKind = "business-wall", semanticEffect = "included", precision = "millisecond" },
                new { roleId = "article.scheduled-due", instantUtc = "2026-09-15T12:01:00.000Z", clockKind = "business-wall", semanticEffect = "included", precision = "millisecond" }
            }
        });

    private static CanonicalArticleLifecycleFixtureBinding Binding()
        => new("run", "ns", "profile", ["article.write"], 1, CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest, s_digest);

    private static CanonicalArticleLifecyclePlan Plan(string variant)
        => new("role", variant, "Title", "Body", null, null, 1, [1], null, null);

    private static void AssertCode(string code, Action action)
        => Assert.Equal(code, Assert.Throws<CanonicalArticleLifecycleValidationException>(action).Code);

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
