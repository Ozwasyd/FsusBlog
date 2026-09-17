using System.Diagnostics.Metrics;

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
    public void EvaluateOnSubmit_ReusesSingleDictionaryContentMatchAcrossRegions()
    {
        var dictionary = new CountingModerationDictionaryService();
        var service = new RegionLegalModerationService(dictionary);
        var measurements = new List<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.moderation.dictionary.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        RegionModerationDecision decision = service.EvaluateOnSubmit(MakeRequest(
            "political_sensitive alias",
            RegionCodes.Singapore));

        Assert.True(decision.CanPublish);
        Assert.Equal([RegionCodes.MainlandChina], decision.BlockedRegions);
        Assert.Equal(1, dictionary.MatchAllCallCount);
        Assert.Equal(0, dictionary.MatchCallCount);
        Assert.Contains("fsus.moderation.dictionary.scanned_content_count", measurements);
        Assert.Contains("fsus.moderation.dictionary.matched_term_count", measurements);
        Assert.Contains("fsus.moderation.dictionary.match_elapsed_ms", measurements);
        Assert.Contains("fsus.moderation.dictionary.evaluated_region_count", measurements);
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

    private sealed class CountingModerationDictionaryService : FsusBlog.Server.Interfaces.IModerationDictionaryService
    {
        private readonly ModerationDictionaryMatch _match = new(
            "cn-mainland.political-sensitive",
            ModerationRiskCategories.PoliticalSensitive,
            "critical",
            "cn_mainland_political_sensitive",
            ModerationEvidencePolicies.Redact,
            null,
            RegionCodes.Global);

        public int MatchCallCount
        {
            get; private set;
        }
        public int MatchAllCallCount
        {
            get; private set;
        }

        public ModerationDictionarySnapshot CurrentSnapshot => ModerationDictionarySnapshot.Empty;
        public string? LastError => null;

        public IReadOnlyList<ModerationDictionaryMatch> Match(string content, string region)
        {
            MatchCallCount++;
            return region == RegionCodes.MainlandChina ? [_match with { MatchedRegion = region }] : [];
        }

        public IReadOnlyList<ModerationDictionaryMatch> MatchAll(string content)
        {
            MatchAllCallCount++;
            return [_match];
        }

        public IReadOnlyList<ModerationDictionaryMatch> FilterMatchesForRegion(
            IReadOnlyList<ModerationDictionaryMatch> matches,
            string region)
            => region == RegionCodes.MainlandChina
                ? matches.Select(match => match with { MatchedRegion = region }).ToArray()
                : [];

        public ModerationPolicyAction ResolveAction(string region, string category)
            => region == RegionCodes.MainlandChina && category == ModerationRiskCategories.PoliticalSensitive
                ? new ModerationPolicyAction(ModerationDictionaryActions.RejectSubmit, ModerationDictionaryActions.GeoBlock)
                : new ModerationPolicyAction(ModerationDictionaryActions.Allow, ModerationDictionaryActions.Allow);

        public IReadOnlyList<ModerationDictionaryTerm> GetGlobalHardFilterTerms() => [];
        public ModerationDictionaryRuntimeSnapshot GetRuntimeSnapshot()
            => new(string.Empty, string.Empty, string.Empty, DateTime.MinValue, [], [], null);
        public FsusBlog.Core.Common.Result Reload() => FsusBlog.Core.Common.Result.Success();
        public FsusBlog.Core.Common.Result Rollback() => FsusBlog.Core.Common.Result.Success();
    }
}
