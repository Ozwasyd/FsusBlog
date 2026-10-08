using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticleLifecycleFixturePortTests
{
    private static readonly string s_digest = "sha256:" + new string('a', 64);

    [Fact]
    public void Variants_CoverEveryRequiredLifecycleScenario()
    {
        Assert.Equal(
            [
                CanonicalArticleLifecycleVariants.Archived,
                CanonicalArticleLifecycleVariants.Deleted,
                CanonicalArticleLifecycleVariants.Draft,
                CanonicalArticleLifecycleVariants.MultiplePublications,
                CanonicalArticleLifecycleVariants.MultipleRevisions,
                CanonicalArticleLifecycleVariants.Published,
                CanonicalArticleLifecycleVariants.PublishedScheduledUpdate,
                CanonicalArticleLifecycleVariants.Restore,
                CanonicalArticleLifecycleVariants.Rollback,
                CanonicalArticleLifecycleVariants.Scheduled
            ],
            CanonicalArticleLifecycleVariants.All.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Binding_RejectsMissingIdentityAdminAndDigests()
    {
        Assert.Throws<CanonicalArticleLifecycleValidationException>(() =>
            new CanonicalArticleLifecycleFixtureBinding(
                "",
                "ns",
                "profile",
                ["article.write"],
                1,
                CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
                s_digest).Validate());
        Assert.Throws<CanonicalArticleLifecycleValidationException>(() =>
            new CanonicalArticleLifecycleFixtureBinding(
                "run",
                "ns",
                "profile",
                ["article.write"],
                0,
                CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
                s_digest).Validate());
        Assert.Throws<CanonicalArticleLifecycleValidationException>(() =>
            new CanonicalArticleLifecycleFixtureBinding(
                "run",
                "ns",
                "profile",
                ["article.write"],
                1,
                "not-a-digest",
                s_digest).Validate());
    }

    [Fact]
    public async Task ScheduledPast_FailsBeforeMutationFenceOrDatabase()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IArticlePublicationValidator validator = Substitute.For<IArticlePublicationValidator>();
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        var port = new CanonicalArticleLifecycleFixturePort(
            db,
            new ConfigurationBuilder().Build(),
            validator,
            fence,
            new FixedTimeProvider(new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero)));

        CanonicalArticleLifecyclePlan plan = Plan(
            CanonicalArticleLifecycleVariants.Scheduled,
            scheduledPublishAt: new DateTime(2026, 9, 15, 11, 59, 59, DateTimeKind.Utc));

        CanonicalArticleLifecycleValidationException exception = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
            () => port.ExecuteAsync(new CanonicalArticleLifecycleRequest(Binding(), plan)));
        Assert.Equal("scheduled_at_must_be_future", exception.Code);
        await fence.DidNotReceive().BeginPublicMutationFenceAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RollbackZeroTarget_FailsBeforeAnyWrite()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var port = new CanonicalArticleLifecycleFixturePort(
            db,
            new ConfigurationBuilder().Build(),
            Substitute.For<IArticlePublicationValidator>(),
            Substitute.For<IArticlePublicMutationFence>(),
            new FixedTimeProvider(new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero)));

        CanonicalArticleLifecycleValidationException exception = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
            () => port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(),
                Plan(CanonicalArticleLifecycleVariants.Rollback) with
                {
                    RollbackTargetRevisionId = 0
                })));
        Assert.Equal("rollback_target_invalid", exception.Code);
    }

    [Theory]
    [InlineData(CanonicalArticleLifecycleVariants.Scheduled, DateTimeKind.Local)]
    [InlineData(CanonicalArticleLifecycleVariants.Scheduled, DateTimeKind.Unspecified)]
    [InlineData(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate, DateTimeKind.Local)]
    [InlineData(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate, DateTimeKind.Unspecified)]
    public async Task ScheduledNonUtc_FailsBeforeMutationFenceOrDatabase(string variant, DateTimeKind kind)
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        var port = new CanonicalArticleLifecycleFixturePort(
            db,
            new ConfigurationBuilder().Build(),
            Substitute.For<IArticlePublicationValidator>(),
            fence,
            new FixedTimeProvider(new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero)));
        CanonicalArticleLifecyclePlan plan = Plan(variant,
            scheduledPublishAt: new DateTime(2026, 9, 15, 12, 1, 0, kind));

        CanonicalArticleLifecycleValidationException exception = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
            () => port.ExecuteAsync(new CanonicalArticleLifecycleRequest(Binding(), plan)));

        Assert.Equal("scheduled_at_must_be_utc", exception.Code);
        await fence.DidNotReceive().BeginPublicMutationFenceAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ReceiptDigest_IsBoundToVariantAndCoordinateLists()
    {
        var operation = new CanonicalArticleLifecycleOperationReceipt(
            "transition-1",
            "create",
            null,
            ArticleStatus.Published,
            false,
            false,
            null,
            null,
            10,
            1,
            null,
            null,
            20,
            1,
            30,
            40,
            1,
            null,
            DateTime.UtcNow,
            null,
            s_digest,
            "outbox-1",
            s_digest,
            "20260915",
            s_digest);
        string first = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            s_digest,
            "run",
            "ns",
            "profile",
            "role",
            CanonicalArticleLifecycleVariants.Published,
            1,
            42,
            [operation],
            [10],
            [20],
            10,
            20,
            ArticleStatus.Published,
            false,
            s_digest,
            s_digest);
        string changed = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            s_digest,
            "run",
            "ns",
            "profile",
            "role",
            CanonicalArticleLifecycleVariants.Rollback,
            1,
            42,
            [operation],
            [10],
            [20],
            10,
            20,
            ArticleStatus.Published,
            false,
            s_digest,
            s_digest);

        Assert.NotEqual(first, changed);
        Assert.StartsWith("sha256:", first, StringComparison.Ordinal);
    }

    private static CanonicalArticleLifecycleFixtureBinding Binding()
        => new(
            "run",
            "ns",
            "profile",
            ["article.write"],
            1,
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            s_digest);

    private static CanonicalArticleLifecyclePlan Plan(
        string variant,
        DateTime? scheduledPublishAt = null)
        => new(
            "lifecycle-role",
            variant,
            "Lifecycle title",
            "Lifecycle markdown body",
            "summary",
            null,
            1,
            [1],
            (ArticleRightsRequestCoreModel?)null,
            new ArticleResponsibilityDraft(
                true,
                [new ArticleResponsiblePerson("Fixture Author", null)],
                null,
                [],
                "fixture",
                "fixture",
                null,
                null,
                null,
                null,
                null,
                true,
                false,
                false,
                false,
                0),
            scheduledPublishAt);

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
