using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// Transports the private prepared timestamp through the existing request contract.
/// The encrypted journal, not this reference table, is the recovery authority.
/// </summary>
internal static class ChallengeV2DurableDelivery
{
    private static readonly ConditionalWeakTable<SecurityChallengeAttemptRequest, ChallengeV2PreparedAttempt> s_prepared = new();

    internal static SecurityChallengeAttemptRequest Prepare(SecurityChallengeAttemptRequest request)
    {
        ChallengeV2PreparedAttempt prepared = TryGet(request)
            ?? SecurityChallengePersistenceService.PrepareAttempt(request, DateTime.UtcNow);
        return Bind(prepared);
    }

    internal static SecurityChallengeAttemptRequest Bind(ChallengeV2PreparedAttempt prepared)
    {
        ChallengeV2PreparedAttempt normalized = SecurityChallengePersistenceService.PrepareAttempt(prepared.Request, prepared.CreatedAtUtc);
        if (normalized.Request != prepared.Request || normalized.CreatedAtUtc != prepared.CreatedAtUtc)
        {
            throw new InvalidDataException("challenge_audit_prepared_payload_invalid");
        }
        ChallengeV2PreparedAttempt bound = s_prepared.GetValue(prepared.Request, _ => prepared);
        if (bound != prepared)
        {
            throw new InvalidDataException("challenge_audit_prepared_binding_conflict");
        }
        return bound.Request;
    }

    internal static ChallengeV2PreparedAttempt? TryGet(SecurityChallengeAttemptRequest request)
        => s_prepared.TryGetValue(request, out ChallengeV2PreparedAttempt? prepared) ? prepared : null;

    internal static ChallengeV2PreparedAttempt GetRequired(SecurityChallengeAttemptRequest request)
        => TryGet(request) ?? throw new InvalidDataException("challenge_audit_prepared_identity_required");

    internal static string Reference(string attemptId)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(attemptId)));

    internal static DateTime SqlTimestamp(DateTime value)
    {
        DateTime utc = value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value.ToUniversalTime();
        return new DateTime(utc.Ticks - utc.Ticks % 10, DateTimeKind.Utc);
    }

    internal static bool MatchesStored(ChallengeV2PreparedAttempt expected, SecurityChallengeAttempt actual,
        bool includeCreatedAt = true, bool includeAttemptedAt = true)
    {
        SecurityChallengeAttemptRequest request = expected.Request;
        return actual.AttemptId == request.AttemptId
            && actual.ChallengeId == request.ChallengeId
            && actual.Outcome == request.Outcome
            && actual.Reason == request.Reason
            && actual.PayloadHash == request.PayloadHash
            && actual.ClientIpHash == request.ClientIpHash
            && actual.DeviceFpHash == request.DeviceFpHash
            && actual.TraceId == request.TraceId
            && actual.Traceparent == request.Traceparent
            && (!includeAttemptedAt || SqlTimestamp(actual.AttemptedAtUtc) == request.AttemptedAtUtc)
            && (!includeCreatedAt || SqlTimestamp(actual.CreatedAtUtc) == expected.CreatedAtUtc);
    }
}

internal sealed record ChallengeV2PreparedAttempt(SecurityChallengeAttemptRequest Request, DateTime CreatedAtUtc,
    bool SuppliedAttemptedAt = true)
{
    internal SecurityChallengeAttempt ToEntity() => new()
    {
        AttemptId = Request.AttemptId!,
        ChallengeId = Request.ChallengeId,
        Outcome = Request.Outcome,
        Reason = Request.Reason,
        PayloadHash = Request.PayloadHash,
        ClientIpHash = Request.ClientIpHash,
        DeviceFpHash = Request.DeviceFpHash,
        TraceId = Request.TraceId,
        Traceparent = Request.Traceparent,
        AttemptedAtUtc = Request.AttemptedAtUtc!.Value,
        CreatedAtUtc = CreatedAtUtc
    };
}

internal sealed record ChallengeV2DurableEntry(long PublicationTicks, string Reference,
    ChallengeV2AuditEvent Event, DateTime CreatedAtUtc, bool SuppliedAttemptedAt);

internal sealed record ChallengeV2LaneSnapshot(long QueuedCount, long InFlightCount, long DurablePendingCount,
    long DurableAcceptedCount, long CommittedCount, long RequeuedCount, long RejectedCount,
    long TerminalFailureCount, long Sequence, string? LastDisposition, string? LastItemReference, string? LastFailureReason,
    long HistoricalFailureCount = 0);
