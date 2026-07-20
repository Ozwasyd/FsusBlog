using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleCommentPolicyServiceTests
{
    private static readonly AnonymousCommentPolicySnapshot s_site = new(
        AnonymousCommentsEnabled: true,
        PublicCommentsEnabled: true,
        ZkAnonymousEnabled: true,
        DefaultAuthorMode: CommentAuthorModes.ZkAnonymous,
        SupportedDisplayLanguages: ["zh-CN", "en"])
    {
        SnapshotHash = new string('a', 64)
    };

    [Fact]
    public void Compose_InheritsSiteDefaultsAndArticleOverrideOnlyNarrowsAuthorModes()
    {
        EffectiveArticleCommentPolicy inherited = ArticleCommentPolicyService.Compose(42, s_site, null, null);
        EffectiveArticleCommentPolicy overridden = ArticleCommentPolicyService.Compose(42, s_site, new ArticleCommentPolicy
        {
            ArticleId = 42,
            Enabled = true,
            PublicCommentsEnabled = false,
            AnonymousCommentsEnabled = true,
            ModerationMode = ArticleCommentModerationModes.Premoderated,
            SlowModeSeconds = 30,
            PolicyVersion = 3
        }, null);

        Assert.True(inherited.Enabled);
        Assert.True(inherited.PublicCommentsEnabled);
        Assert.True(inherited.AnonymousCommentsEnabled);
        Assert.Equal(ArticleCommentModerationModes.RiskBased, inherited.ModerationMode);
        Assert.False(overridden.PublicCommentsEnabled);
        Assert.True(overridden.AnonymousCommentsEnabled);
        Assert.Equal(ArticleCommentModerationModes.Premoderated, overridden.ModerationMode);
        Assert.Equal(30, overridden.SlowModeSeconds);
        Assert.NotEqual(inherited.SnapshotHash, overridden.SnapshotHash);
    }

    [Fact]
    public void Compose_ThreadLockIsScopedAndVersionBoundIntoSnapshot()
    {
        var thread = new CommentThreadPolicy
        {
            ArticleId = 42,
            RootCommentId = 9001,
            LockedAtUtc = new DateTime(2026, 7, 20, 4, 0, 0, DateTimeKind.Utc),
            LockedByAdminPrincipalId = 7,
            LockReason = "off-topic",
            PolicyVersion = 2
        };

        EffectiveArticleCommentPolicy locked = ArticleCommentPolicyService.Compose(42, s_site, null, thread);
        EffectiveArticleCommentPolicy otherThread = ArticleCommentPolicyService.Compose(42, s_site, null, null);

        Assert.True(locked.ThreadLocked);
        Assert.Equal(9001, locked.RootCommentId);
        Assert.Equal(2, locked.ThreadPolicyVersion);
        Assert.False(otherThread.ThreadLocked);
        Assert.NotEqual(locked.SnapshotHash, otherThread.SnapshotHash);
    }

    [Fact]
    public void Compose_ClosedArticleKeepsReadStateButReportsWriteClosure()
    {
        var article = new ArticleCommentPolicy
        {
            ArticleId = 42,
            Enabled = true,
            ClosedAtUtc = DateTime.UtcNow.AddMinutes(-1),
            PolicyVersion = 1
        };

        EffectiveArticleCommentPolicy policy = ArticleCommentPolicyService.Compose(42, s_site, article, null);

        Assert.False(policy.IsOpen(DateTime.UtcNow));
        Assert.True(policy.PublicCommentsEnabled);
        Assert.True(policy.AnonymousCommentsEnabled);
    }

    [Theory]
    [InlineData(false, false, true, true, "public", "comment_policy_closed")]
    [InlineData(true, true, true, true, "public", "comment_thread_locked")]
    [InlineData(true, false, false, true, "public", "public_comments_disabled")]
    [InlineData(true, false, true, false, "zk_anonymous", "anonymous_comments_disabled")]
    public void EvaluateWrite_UsesOneDecisionForEveryAuthorModeAndThread(
        bool enabled,
        bool threadLocked,
        bool publicEnabled,
        bool anonymousEnabled,
        string authorMode,
        string expected)
    {
        var policy = new EffectiveArticleCommentPolicy(
            42, enabled, publicEnabled, anonymousEnabled, ArticleCommentModerationModes.RiskBased,
            0, null, 1, threadLocked ? 9001 : null, threadLocked, threadLocked ? 1 : 0, new string('b', 64));

        CommentPolicyWriteDecision decision = ArticleCommentPolicyService.EvaluateWrite(policy, authorMode, DateTime.UtcNow);

        Assert.False(decision.Allowed);
        Assert.Equal(expected, decision.Status);
    }
}
