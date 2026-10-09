namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Replay eligibility of an observation, never a database acceptance result.</summary>
public enum AuthorTypographyRequestReplayStatus : byte
{
    NotRecorded = 1,
    Replayable = 2,
    InvalidRequest = 3,
    InvalidRecord = 4,
    RequestIdentityConflict = 5
}

/// <summary>Only a verified matching request exposes its original committed snapshot for replay.</summary>
public sealed record AuthorTypographyRequestReplayDecision(
    AuthorTypographyRequestReplayStatus Status,
    AuthorTypographySnapshot? OriginalSnapshot);

/// <summary>
/// Verifies a record read by the sole server writer using authenticated scope and request ID.
/// This policy stores nothing and must run before fresh expected-revision CAS evaluation.
/// </summary>
public static class AuthorTypographyRequestReplayPolicy
{
    /// <summary>
    /// Matching retries replay the original observation even if current revision has advanced.
    /// A reused ID with different payload refuses; unrelated lookup results are storage refusals.
    /// </summary>
    public static AuthorTypographyRequestReplayDecision Evaluate(
        AuthorTypographyScope? authenticatedScope,
        AuthorTypographyMutationRequest? request,
        AuthorTypographyRecordedRequest? persistedRecord)
    {
        if (!AuthorTypographyContractValidator.ValidateMutationRequest(authenticatedScope, request))
        {
            return Refuse(AuthorTypographyRequestReplayStatus.InvalidRequest);
        }
        if (persistedRecord is null)
        {
            return Refuse(AuthorTypographyRequestReplayStatus.NotRecorded);
        }
        if (!AuthorTypographyContractValidator.ValidateRecordedRequest(persistedRecord, authenticatedScope)
            || persistedRecord.Request.RequestId != request!.RequestId)
        {
            return Refuse(AuthorTypographyRequestReplayStatus.InvalidRecord);
        }
        if (persistedRecord.Request != request)
        {
            return Refuse(AuthorTypographyRequestReplayStatus.RequestIdentityConflict);
        }
        return new AuthorTypographyRequestReplayDecision(
            AuthorTypographyRequestReplayStatus.Replayable,
            persistedRecord.CommittedSnapshot);
    }

    private static AuthorTypographyRequestReplayDecision Refuse(AuthorTypographyRequestReplayStatus status)
    {
        return new AuthorTypographyRequestReplayDecision(status, null);
    }
}
