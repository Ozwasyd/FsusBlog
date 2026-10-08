using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>
/// Closed domain-result shapes for consumers and the canonical wire owner. This validates
/// content only; it creates no server authority, request identity, codec or write capability.
/// </summary>
public static class AuthorTypographyPreferenceResultValidator
{
    public static bool ValidateRead(AuthorTypographyPreferenceReadResult? result, AuthorTypographyScope? scope)
    {
        if (!AuthorTypographyContractValidator.ValidateScope(scope) || result is null)
        {
            return false;
        }
        return result.Outcome switch
        {
            AuthorTypographyPreferenceReadOutcome.Stored => ValidSnapshot(result.Snapshot, scope)
                && result.Snapshot!.Revision > 0,
            AuthorTypographyPreferenceReadOutcome.CurrentDesignDefault => ValidSnapshot(result.Snapshot, scope),
            AuthorTypographyPreferenceReadOutcome.Forbidden
                or AuthorTypographyPreferenceReadOutcome.CurrentDesignDefaultUnavailable
                or AuthorTypographyPreferenceReadOutcome.Unavailable => result.Snapshot is null,
            _ => false
        };
    }

    public static bool ValidateWrite(AuthorTypographyPreferenceWriteResult? result, AuthorTypographyScope? scope)
    {
        if (!AuthorTypographyContractValidator.ValidateScope(scope) || result is null)
        {
            return false;
        }
        return result.Outcome switch
        {
            AuthorTypographyPreferenceWriteOutcome.Committed or AuthorTypographyPreferenceWriteOutcome.Replayed
                => AuthorTypographyContractValidator.ValidateRecordedRequest(result.Record, scope)
                    && ValidSnapshot(result.CurrentSnapshot, scope)
                    && result.CurrentSnapshot == result.Record!.CommittedSnapshot,
            AuthorTypographyPreferenceWriteOutcome.RevisionConflict => result.Record is null
                && (result.CurrentSnapshot is null || ValidSnapshot(result.CurrentSnapshot, scope)),
            AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict
                or AuthorTypographyPreferenceWriteOutcome.InvalidRequest
                or AuthorTypographyPreferenceWriteOutcome.Forbidden
                or AuthorTypographyPreferenceWriteOutcome.CurrentDesignDefaultUnavailable
                or AuthorTypographyPreferenceWriteOutcome.Unavailable => result.Record is null && result.CurrentSnapshot is null,
            _ => false
        };
    }

    private static bool ValidSnapshot(AuthorTypographySnapshot? snapshot, AuthorTypographyScope? scope)
    {
        return AuthorTypographyContractValidator.ValidateSnapshot(snapshot, scope) == AuthorTypographyContractStatus.Valid
            && snapshot!.Revision <= WritingAidPreferenceContract.MaximumExactRevision;
    }
}
