using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Server.Interfaces;

public enum WritingAidPreferenceOutcome
{
    Success,
    Replayed,
    Invalid,
    RevisionConflict,
    IdempotencyConflict,
    Corrupt,
    Unavailable
}

public sealed record WritingAidPreferenceResult(
    WritingAidPreferenceOutcome Outcome,
    WritingAidPreferenceSnapshot? Snapshot = null,
    WritingAidPreferenceReceipt? Receipt = null)
{
    public bool Success => Outcome is WritingAidPreferenceOutcome.Success or WritingAidPreferenceOutcome.Replayed;
}

/// <summary>Verified request context supplies owner; client payloads cannot choose an account or site.</summary>
public interface IWritingAidPreferenceReader
{
    Task<WritingAidPreferenceResult> GetWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        CancellationToken cancellationToken = default);
}

public interface IWritingAidPreferenceCommand
{
    Task<WritingAidPreferenceResult> UpdateWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        WritingAidPreferenceUpdate update,
        CancellationToken cancellationToken = default);
}

/// <summary>One-time server defaults initialization. It cannot translate an unverified legacy key or overwrite a row.</summary>
public interface IWritingAidPreferenceInitializationCommand
{
    Task<WritingAidPreferenceResult> InitializeWritingAidPreferenceAsync(
        WritingAidPreferenceOwner owner,
        string deviceScope,
        Guid operationId,
        CancellationToken cancellationToken = default);
}
