using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Models.Moderation;

public static class ModerationGlobalStates
{
    public const string Enabled = "enabled";
    public const string ReadOnly = "read_only";
    public const string DisabledToPending = "disabled_to_pending";
    public const string DisabledPassThrough = "disabled_pass_through";
    public const string EmergencyLockdown = "emergency_lockdown";
}

public static class ModerationRegionStates
{
    public const string Enabled = "enabled";
    public const string ManualReviewOnly = "manual_review_only";
    public const string NoPublicDisplay = "no_public_display";
    public const string ReadOnly = "read_only";
    public const string Disabled = "disabled";
}

public static class ModerationRuntimeConfirmPhrases
{
    public const string MainlandChange = "CONFIRM CN-MAINLAND MODERATION CHANGE";
}

public sealed record ModerationModelRuntimeSnapshot(
    string SnapshotId,
    bool Enabled,
    string Provider,
    string ModelProfile,
    string ThresholdProfile,
    string ContractVersion,
    string ConfigChecksum,
    DateTime LoadedAtUtc,
    string LoadedBy,
    string Status,
    int TimeoutMs,
    bool FailOpen,
    string? LastError,
    string? RuntimePath,
    string RuntimeChannel,
    FsusAntiSpamModelRuntimeSnapshot? BuiltInRuntime);

public sealed record ModerationRuntimeSnapshot(
    string SnapshotId,
    string GlobalState,
    IReadOnlyDictionary<string, string> RegionStates,
    IReadOnlySet<string> DisabledDictionaryIds,
    ModerationModelRuntimeSnapshot Model,
    DateTime ChangedAtUtc,
    string ChangedBy,
    string? Reason,
    DateTime? ExpiresAtUtc,
    string? LastError);
