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

    /// <summary>
    /// Atomically acquires the Development-only comment fixture state. The
    /// returned capability retains the actual prior snapshot and rollback slot;
    /// release rejects an intervening runtime owner rather than overwriting it.
    /// </summary>
    ModerationRuntimeFixtureLease AcquireCommentFixtureRuntimeState(
        string region, string owner, string runId, DateTime expiresAtUtc);
}

/// <summary>
/// Native runtime ownership, never a deserialized fixture receipt or arbitrary
/// snapshot setter. Only the runtime assembly can construct a capability.
/// </summary>
public abstract class ModerationRuntimeFixtureLease
{
    private protected ModerationRuntimeFixtureLease()
    {
    }

    public abstract string Region
    {
        get;
    }
    public abstract ModerationRuntimeSnapshot Prior
    {
        get;
    }
    public abstract ModerationRuntimeSnapshot Applied
    {
        get;
    }

    /// <summary>
    /// Returns the actual restored prior snapshot. An idempotent release still
    /// requires that this snapshot and its original rollback slot remain owned.
    /// </summary>
    public abstract ModerationRuntimeSnapshot Restore();
}
