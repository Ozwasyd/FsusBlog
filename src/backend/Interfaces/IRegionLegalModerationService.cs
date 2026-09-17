using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IRegionLegalModerationService
{
    RegionModerationDecision EvaluateOnSubmit(RegionModerationRequest request);
    RegionPolicyReplayDiff PreviewReplay(CommentRegionCompliance current, RegionModerationDecision nextDecision);
    bool IsBlockedForViewer(string viewerRegion, string blockedRegions);
    string NormalizeRegion(string? region);
}
