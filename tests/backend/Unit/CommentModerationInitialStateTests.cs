using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationInitialStateTests
{
    [Fact]
    public void ResolveInitialState_DeterministicLowRiskWithoutModel_IsApproved()
    {
        CommentInitialModerationDecision decision = CreateService(enabled: false)
            .ResolveInitialState(PublicActor(), Region());

        Assert.Equal(CommentModerationStatus.Approved, decision.Status);
        Assert.Equal("approved_deterministic_low_risk", decision.ReasonCode);
    }

    [Fact]
    public void ResolveInitialState_ModelRequired_IsPendingBeforeScoring()
    {
        CommentInitialModerationDecision decision = CreateService(enabled: true)
            .ResolveInitialState(PublicActor(), Region());

        Assert.Equal(CommentModerationStatus.Pending, decision.Status);
        Assert.Equal("pending_model_provider_unavailable", decision.ReasonCode);
    }

    [Fact]
    public void ResolveInitialState_AnonymousCredentialRequiringReview_IsPending()
    {
        CommentInitialModerationDecision decision = CreateService(enabled: false)
            .ResolveInitialState(
                PublicActor() with
                {
                    AuthorMode = CommentAuthorModes.ZkAnonymous,
                    RequiresModeration = true
                },
                Region());

        Assert.Equal(CommentModerationStatus.Pending, decision.Status);
        Assert.Equal("pending_anonymous_policy", decision.ReasonCode);
    }

    [Fact]
    public void ResolveInitialState_RegionManualReview_IsPending()
    {
        CommentInitialModerationDecision decision = CreateService(enabled: false)
            .ResolveInitialState(PublicActor(), Region(requiresManualReview: true));

        Assert.Equal(CommentModerationStatus.Pending, decision.Status);
        Assert.Equal("pending_region_review", decision.ReasonCode);
    }

    [Fact]
    public void ResolveInitialState_HideUntilReviewed_IsHidden()
    {
        CommentInitialModerationDecision decision = CreateService(enabled: false)
            .ResolveInitialState(PublicActor(), Region(requiresManualReview: true, hideUntilReviewed: true));

        Assert.Equal(CommentModerationStatus.Hidden, decision.Status);
        Assert.Equal("hidden_region_review", decision.ReasonCode);
    }

    [Fact]
    public void ResolveInitialState_RegionReviewDoesNotReadUnusableModelConfiguration()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:AntiSpamModel:Enabled"] = "invalid-boolean"
            })
            .Build();
        var service = new CommentModerationService(
            Substitute.For<SqlSugar.ISqlSugarClient>(),
            new RegionLegalModerationService(),
            Substitute.For<FsusBlog.Server.Infrastructure.Cache.ICacheInvalidationDispatcher>(),
            Substitute.For<ICommentNotificationService>(),
            NullLogger<CommentModerationService>.Instance,
            configuration: configuration);

        CommentInitialModerationDecision hidden = service.ResolveInitialState(PublicActor(), Region(hideUntilReviewed: true));
        CommentInitialModerationDecision manual = service.ResolveInitialState(PublicActor(), Region(requiresManualReview: true));
        CommentInitialModerationDecision actorReview = service.ResolveInitialState(PublicActor() with
        {
            RequiresModeration = true
        }, Region());

        Assert.Equal(CommentModerationStatus.Hidden, hidden.Status);
        Assert.Equal("pending_region_review", manual.ReasonCode);
        Assert.Equal("pending_anonymous_policy", actorReview.ReasonCode);
        Assert.Throws<InvalidOperationException>(() => service.ResolveInitialState(PublicActor(), Region()));
    }

    private static CommentModerationService CreateService(bool enabled)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:AntiSpamModel:Enabled"] = enabled.ToString()
            })
            .Build();
        return new CommentModerationService(
            Substitute.For<SqlSugar.ISqlSugarClient>(),
            new RegionLegalModerationService(),
            Substitute.For<FsusBlog.Server.Infrastructure.Cache.ICacheInvalidationDispatcher>(),
            Substitute.For<ICommentNotificationService>(),
            NullLogger<CommentModerationService>.Instance,
            configuration: configuration);
    }

    private static CommentActor PublicActor()
        => new(
            7,
            CommentAuthorModes.Public,
            "public-handle",
            null,
            "public-handle",
            "zh-CN",
            null,
            null,
            "subject",
            "common",
            false);

    private static RegionModerationDecision Region(
        bool requiresManualReview = false,
        bool hideUntilReviewed = false)
        => new(
            true,
            RegionCodes.Global,
            1d,
            "unit",
            null,
            [],
            [],
            [],
            "unit-policy",
            "allow",
            "allow",
            requiresManualReview,
            hideUntilReviewed);
}
