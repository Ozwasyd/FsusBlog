namespace FsusBlog.Shared.Contracts.AuthoringPreferences;

/// <summary>The account preference owner supplies defaults; clients consume its snapshot.</summary>
public static class WritingAidPreferenceContract
{
    public const int SchemaVersion = 1;
    public const long MaximumExactRevision = 9_007_199_254_740_991;
    public static WritingAidPreferenceValues Defaults { get; } = new(SchemaVersion, false, false, false);
}

/// <summary>Independent user preferences. Surface, document and runtime capability are absent.</summary>
public sealed record WritingAidPreferenceValues(
    int SchemaVersion,
    bool FocusEnabled,
    bool TypewriterEnabled,
    bool ImmersiveEnabled);

/// <summary>Both coordinates originate in verified server identity/site context, never request claims.</summary>
public sealed record WritingAidPreferenceOwner(string UserScope, string SiteScope);

/// <summary>A bounded observation of the server authority; revision zero denotes no stored preference.</summary>
public sealed record WritingAidPreferenceSnapshot(
    WritingAidPreferenceOwner Owner,
    long Revision,
    WritingAidPreferenceValues Values,
    string ContentDigest);

/// <summary>The complete closed value set is updated by CAS, retaining independent boolean changes.</summary>
public sealed record WritingAidPreferenceUpdate(
    long ExpectedRevision,
    Guid OperationId,
    WritingAidPreferenceValues Values);

/// <summary>Content identity of a command result; DB observation still establishes persistence.</summary>
public sealed record WritingAidPreferenceReceipt(
    Guid OperationId,
    string DeviceScope,
    WritingAidPreferenceSnapshot Previous,
    WritingAidPreferenceSnapshot Committed,
    string Action,
    string Status,
    string ContentDigest);

public enum WritingAidPreferenceValidation : byte
{
    Valid = 1,
    InvalidSchema = 2,
    InvalidOwner = 3,
    OwnerMismatch = 4,
    InvalidRevision = 5,
    DigestMismatch = 6,
    InvalidOperation = 7
}
