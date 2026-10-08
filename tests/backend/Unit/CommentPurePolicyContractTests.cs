using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentPurePolicyContractTests
{
    [Theory]
    [InlineData("anonymous", true, "anonymous_author_mode_retired")]
    [InlineData("legacy_server_visible_pseudonymous", true, "anonymous_author_mode_retired")]
    [InlineData("unknown", true, "author_mode_invalid")]
    [InlineData("public", false, "public_opt_in_required")]
    [InlineData("zk_anonymous", true, "zk_anonymous_disabled")]
    public void ExplicitPolicyInput_PreservesAuthorModeRefusals(string mode, bool optIn, string expected)
    {
        var policy = new AnonymousCommentPolicySnapshot(true, true, false, CommentAuthorModes.ZkAnonymous, ["en"]);

        CommentAuthorModeDecision decision = AnonymousCommentPolicyService.EvaluateAuthorMode(policy, mode, optIn);

        Assert.False(decision.Allowed);
        Assert.Equal(expected, decision.Status);
    }

    [Theory]
    [InlineData(true, true, true, true, true, CommentModerationStatus.Hidden, "hidden_region_review")]
    [InlineData(false, true, true, true, true, CommentModerationStatus.Pending, "pending_region_review")]
    [InlineData(false, false, true, true, true, CommentModerationStatus.Pending, "pending_anonymous_policy")]
    [InlineData(false, false, false, true, false, CommentModerationStatus.Pending, "pending_model_provider_unavailable")]
    [InlineData(false, false, false, true, true, CommentModerationStatus.Pending, "pending_model_review")]
    [InlineData(false, false, false, false, true, CommentModerationStatus.Approved, "approved_deterministic_low_risk")]
    public void ExplicitModelInputs_PreserveInitialModerationPrecedence(
        bool hidden,
        bool manual,
        bool actorReview,
        bool modelEnabled,
        bool providerAvailable,
        CommentModerationStatus expectedStatus,
        string expectedReason)
    {
        var actor = new CommentActor(7, CommentAuthorModes.Public, "handle", null, "handle", "en", null, null, "subject", "common", actorReview);
        var region = new RegionModerationDecision(true, "GLOBAL", 1d, "unit", null, [], [], [], "v1", "allowed", "allowed", manual, hidden);

        CommentInitialModerationDecision decision = CommentModerationService.ResolveInitialState(actor, region, modelEnabled, providerAvailable);

        Assert.Equal(expectedStatus, decision.Status);
        Assert.Equal(expectedReason, decision.ReasonCode);
    }

    [Theory]
    [InlineData(7, 7, null)]
    [InlineData(7, 8, 7)]
    [InlineData(7, null, 7)]
    [InlineData(null, 8, null)]
    [InlineData(0, 8, null)]
    public void ReplyRecipient_UsesObservedTargetAndSuppressesSelfReply(int? target, int? actor, int? expected)
        => Assert.Equal(expected, CommentCommandService.ResolveReplyRecipientId(target, actor));

    [Fact]
    public void ArticleWriteDecision_UsesTheExplicitClockAtTheExactClosureBoundary()
    {
        DateTime closedAt = DateTime.UnixEpoch.AddTicks(1);
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"]);
        var article = new ArticleCommentPolicy { ArticleId = 42, Enabled = true, ClosedAtUtc = closedAt };
        EffectiveArticleCommentPolicy policy = ArticleCommentPolicyService.Compose(42, site, article, null);

        Assert.True(ArticleCommentPolicyService.EvaluateWrite(policy, CommentAuthorModes.Public, closedAt.AddTicks(-1)).Allowed);
        CommentPolicyWriteDecision atBoundary = ArticleCommentPolicyService.EvaluateWrite(policy, CommentAuthorModes.Public, closedAt);

        Assert.False(atBoundary.Allowed);
        Assert.Equal("comment_policy_closed", atBoundary.Status);
    }

    [Fact]
    public void PurePolicyInputs_ArePublicWithoutFriendAssemblyOrServiceConstruction()
    {
        Assert.NotNull(typeof(ArticleCommentPolicyService).GetMethod("Compose", BindingFlags.Public | BindingFlags.Static));
        Assert.NotNull(typeof(ArticleCommentPolicyService).GetMethod("EvaluateWrite", BindingFlags.Public | BindingFlags.Static));
        Assert.NotNull(typeof(AnonymousCommentPolicyService).GetMethod("EvaluateAuthorMode", BindingFlags.Public | BindingFlags.Static));
        Assert.NotNull(typeof(CommentModerationService).GetMethod("ResolveInitialState", BindingFlags.Public | BindingFlags.Static));
        Assert.NotNull(typeof(CommentCommandService).GetMethod("ResolveReplyRecipientId", BindingFlags.Public | BindingFlags.Static));
    }
}
