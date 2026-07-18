using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IModerationRuntimeStateService
{
    ModerationRuntimeSnapshot Current
    {
        get;
    }
    bool IsModelEnabled
    {
        get;
    }
    ModerationModelRuntimeSnapshot CurrentModel
    {
        get;
    }
    bool IsDictionaryEnabled(string dictionaryId);
    string GetGlobalState();
    string GetRegionState(string region);
    bool IsRegionPolicyDisabled(string region);
    bool ShouldRejectNewComment(string submitRegion, out string publicReason);
    bool ShouldForceManualReview(string submitRegion);
    bool ShouldHideUntilReviewed(string submitRegion);
    Result<ModerationRuntimeSnapshot> SetGlobalState(string state, string? reason, DateTime? expiresAtUtc, string changedBy);
    Result<ModerationRuntimeSnapshot> SetRegionState(string region, string state, string? reason, DateTime? expiresAtUtc, string? confirmPhrase, string changedBy);
    Result<ModerationRuntimeSnapshot> SetDictionaryState(string dictionaryId, bool enabled, string? reason, string? confirmPhrase, string changedBy);
    Result<ModerationRuntimeSnapshot> ReloadModel(string changedBy);
    Result<ModerationRuntimeSnapshot> SetModelRuntime(bool? enabled, string? provider, string? modelProfile, string? thresholdProfile, string? reason, string changedBy);
    Result<ModerationRuntimeSnapshot> RollbackModel(string changedBy);
}
