using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RegionLegalModerationServiceTests
{
    private readonly RegionLegalModerationService _service = new();

    [Fact]
    public void EvaluateOnSubmit_MainlandStrictHitFromMainland_RejectsPublish()
    {
        RegionModerationDecision decision = _service.EvaluateOnSubmit(MakeRequest(
            "political_sensitive",
            RegionCodes.MainlandChina));

        Assert.False(decision.CanPublish);
        Assert.Equal("submit_region_policy_reject", decision.DecisionReason);
        Assert.Contains(RegionCodes.MainlandChina, decision.BlockedRegions);
        Assert.Contains("cn_mainland_political_sensitive", decision.RiskLabels);
    }

    [Fact]
    public void EvaluateOnSubmit_MainlandStrictHitOutsideMainland_AllowsSubmitAndBlocksMainlandOnly()
    {
        RegionModerationDecision decision = _service.EvaluateOnSubmit(MakeRequest(
            "political_sensitive",
            RegionCodes.Singapore));

        Assert.True(decision.CanPublish);
        Assert.Equal("viewer_region_geo_block", decision.DecisionReason);
        Assert.Equal([RegionCodes.MainlandChina], decision.BlockedRegions);
        Assert.True(_service.IsBlockedForViewer(RegionCodes.MainlandChina, RegionLegalModerationService.SerializeRegions(decision.BlockedRegions)));
        Assert.False(_service.IsBlockedForViewer(RegionCodes.HongKong, RegionLegalModerationService.SerializeRegions(decision.BlockedRegions)));
        Assert.False(_service.IsBlockedForViewer(RegionCodes.Taiwan, RegionLegalModerationService.SerializeRegions(decision.BlockedRegions)));
        Assert.False(_service.IsBlockedForViewer(RegionCodes.Singapore, RegionLegalModerationService.SerializeRegions(decision.BlockedRegions)));
    }

    [Fact]
    public void EvaluateOnSubmit_UnknownSubmitRegion_HidesUntilManualReview()
    {
        RegionModerationDecision decision = _service.EvaluateOnSubmit(MakeRequest(
            "ordinary comment",
            RegionCodes.Unknown));

        Assert.True(decision.CanPublish);
        Assert.True(decision.RequiresManualReview);
        Assert.True(decision.HideUntilReviewed);
        Assert.Equal("unknown_submit_region_manual_review_no_public_display", decision.DecisionReason);
    }

    [Fact]
    public void IsBlockedForViewer_UnknownViewerUsesConservativeFiltering()
    {
        string blockedRegions = RegionLegalModerationService.SerializeRegions([RegionCodes.MainlandChina]);

        Assert.True(_service.IsBlockedForViewer(RegionCodes.Unknown, blockedRegions));
        Assert.False(_service.IsBlockedForViewer(RegionCodes.Unknown, string.Empty));
    }

    [Fact]
    public void PreviewReplay_ReturnsDiffForPolicyRecompute()
    {
        var current = new CommentRegionCompliance
        {
            CommentId = 42,
            PolicyVersion = "region-policy-old",
            CanPublish = true,
            RequiresManualReview = false,
            HideUntilReviewed = false,
            BlockedRegions = string.Empty,
            RiskLabels = string.Empty
        };
        RegionModerationDecision next = _service.EvaluateOnSubmit(MakeRequest(
            "political_sensitive",
            RegionCodes.Singapore));

        RegionPolicyReplayDiff diff = _service.PreviewReplay(current, next);

        Assert.Equal(42, diff.CommentId);
        Assert.Equal("region-policy-old", diff.PreviousPolicyVersion);
        Assert.Equal(RegionLegalModerationService.CurrentPolicyVersion, diff.NextPolicyVersion);
        Assert.Contains(RegionCodes.MainlandChina, diff.AddedBlockedRegions);
        Assert.Contains("cn_mainland_political_sensitive", diff.AddedRiskLabels);
        Assert.True(diff.PublicVisibilityChanged);
    }

    [Fact]
    public void PreviewReplay_RecordsAuditEvents()
    {
        var channel = new AuditLogChannel();
        var service = new RegionLegalModerationService(auditLogChannel: channel);
        var current = new CommentRegionCompliance
        {
            CommentId = 51,
            PolicyVersion = "region-policy-old",
            CanPublish = true,
            RequiresManualReview = false,
            HideUntilReviewed = false,
            BlockedRegions = string.Empty,
            RiskLabels = string.Empty
        };
        RegionModerationDecision next = service.EvaluateOnSubmit(MakeRequest(
            "political_sensitive",
            RegionCodes.Singapore));

        _ = service.PreviewReplay(current, next);

        IReadOnlyList<AuditRecord> auditRecords = Drain(channel);
        Assert.Contains(auditRecords, static item => item.EventInfo == "region_policy_replay_started");
        Assert.Contains(auditRecords, static item => item.EventInfo == "region_policy_replay_completed");
    }

    private static RegionModerationRequest MakeRequest(string content, string submitRegion)
        => new(
            content,
            ArticleId: 1,
            UserId: 7,
            submitRegion,
            SubmitRegionConfidence: 0.95d,
            RegionProvider: "unit-test",
            SubmitIpHash: "hash",
            UserAgent: null,
            SubmittedAtUtc: DateTime.UtcNow);

    private static IReadOnlyList<AuditRecord> Drain(AuditLogChannel channel)
    {
        var records = new List<AuditRecord>();
        while (channel.Reader.TryRead(out AuditRecord? record))
        {
            records.Add(record);
        }

        return records;
    }
}
