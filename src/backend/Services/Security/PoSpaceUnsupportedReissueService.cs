using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

internal sealed record PoSpaceUnsupportedReissueRequest(
    HttpContext Context,
    string ChallengeId,
    string Kind,
    string Action,
    string RouteKey,
    string Reason,
    int ReissueCount,
    RiskControlProofBinding Binding);

internal sealed record PoSpaceUnsupportedReissueResult(bool Accepted, RiskDecision Decision, string Reason)
{
    public static PoSpaceUnsupportedReissueResult Success(RiskDecision decision, string reason)
        => new(true, decision, reason);

    public static PoSpaceUnsupportedReissueResult Rejected(RiskDecision decision, string reason)
        => new(false, decision, reason);
}

internal interface IPoSpaceUnsupportedReissueService
{
    Task<PoSpaceUnsupportedReissueResult> ReissueAsync(
        PoSpaceUnsupportedReissueRequest request,
        RiskDecision currentDecision,
        SecurityRiskPolicy currentPolicy,
        CancellationToken cancellationToken = default);
}

internal interface IPoSpaceUnsupportedAssignmentStore
{
    Task<SecurityChallenge?> FindAsync(string challengeId, CancellationToken cancellationToken = default);

    Task<int> CountUnsupportedAttemptsAsync(string challengeId, CancellationToken cancellationToken = default);

    Task<bool> TryRevokeIssuedAsync(string challengeId, DateTime revokedAtUtc, CancellationToken cancellationToken = default);
}

internal sealed class SqlPoSpaceUnsupportedAssignmentStore(ISqlSugarClient db) : IPoSpaceUnsupportedAssignmentStore
{
    public async Task<SecurityChallenge?> FindAsync(string challengeId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallenge? assignment = await db.Queryable<SecurityChallenge>()
            .Where(item => item.ChallengeId == challengeId)
            .FirstAsync();
        return assignment;
    }

    public Task<int> CountUnsupportedAttemptsAsync(string challengeId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return db.Queryable<SecurityChallengeAttempt>()
            .CountAsync(item => item.ChallengeId == challengeId
                && item.Reason != null
                && item.Reason.StartsWith("pospace_unsupported:"));
    }

    public async Task<bool> TryRevokeIssuedAsync(
        string challengeId,
        DateTime revokedAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Updateable<SecurityChallenge>()
            .SetColumns(item => item.Status == SecurityChallengeStatuses.Revoked)
            .SetColumns(item => item.RevokedAtUtc == revokedAtUtc)
            .SetColumns(item => item.UpdatedAtUtc == revokedAtUtc)
            .Where(item => item.ChallengeId == challengeId && item.Status == SecurityChallengeStatuses.Issued)
            .ExecuteCommandAsync();
        return updated == 1;
    }
}

internal sealed class PoSpaceUnsupportedReissueService(
    IPoSpaceUnsupportedAssignmentStore assignmentStore,
    ISecurityChallengePersistenceService persistence,
    ICacheInvalidationStore cacheInvalidation,
    ISecurityRiskSignalSink riskSignalSink,
    TimeProvider timeProvider) : IPoSpaceUnsupportedReissueService
{
    private static readonly TimeSpan s_riskSignalTtl = TimeSpan.FromMinutes(10);

    public async Task<PoSpaceUnsupportedReissueResult> ReissueAsync(
        PoSpaceUnsupportedReissueRequest request,
        RiskDecision currentDecision,
        SecurityRiskPolicy currentPolicy,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        SecurityChallenge? original = await assignmentStore.FindAsync(request.ChallengeId, cancellationToken);
        if (!IsBoundIssuedAssignment(original, request, timeProvider.GetUtcNow().UtcDateTime))
        {
            await RecordRiskAsync(request, "pospace_reissue_binding_rejected", cancellationToken);
            return PoSpaceUnsupportedReissueResult.Rejected(Block(currentDecision, "pospace_reissue_binding_rejected"), "pospace_reissue_binding_rejected");
        }

        int priorUnsupportedAttempts = await assignmentStore.CountUnsupportedAttemptsAsync(request.ChallengeId, cancellationToken);
        if (request.ReissueCount != priorUnsupportedAttempts + 1
            || request.ReissueCount > PoSpaceV1Contract.MaxUnsupportedReissues)
        {
            bool loopRevoked = await RevokeOriginalAsync(request, cancellationToken);
            if (loopRevoked)
            {
                await RecordAttemptAsync(request, "pospace_reissue_loop_blocked", cancellationToken);
            }
            await RecordRiskAsync(request, "pospace_reissue_loop_blocked", cancellationToken);
            return PoSpaceUnsupportedReissueResult.Rejected(Block(currentDecision, "pospace_reissue_loop_blocked"), "pospace_reissue_loop_blocked");
        }

        bool revoked = await RevokeOriginalAsync(
            request,
            cancellationToken);
        if (!revoked)
        {
            await RecordRiskAsync(request, "pospace_reissue_concurrent_rejected", cancellationToken);
            return PoSpaceUnsupportedReissueResult.Rejected(
                Block(currentDecision, "pospace_reissue_concurrent_rejected"),
                "pospace_reissue_concurrent_rejected");
        }

        await RecordAttemptAsync(
            request,
            $"pospace_unsupported:{request.Reason}:{request.ReissueCount}",
            cancellationToken);

        RiskDecision replacement = SelectReplacement(currentDecision, currentPolicy);
        string disposition = replacement.Kind == RiskDecisionKind.Block
            ? "pospace_unsupported_rejected"
            : "pospace_unsupported_policy_changed";
        await RecordRiskAsync(request, $"{disposition}:{request.Reason}", cancellationToken);
        return replacement.Kind == RiskDecisionKind.Block
            ? PoSpaceUnsupportedReissueResult.Rejected(replacement, disposition)
            : PoSpaceUnsupportedReissueResult.Success(replacement, disposition);
    }

    private async Task<bool> RevokeOriginalAsync(
        PoSpaceUnsupportedReissueRequest request,
        CancellationToken cancellationToken)
    {
        bool revoked = await assignmentStore.TryRevokeIssuedAsync(
            request.ChallengeId,
            timeProvider.GetUtcNow().UtcDateTime,
            cancellationToken);
        await cacheInvalidation.RemoveAsync(CachePolicyId.SecurityPoSpaceChallenge, request.ChallengeId, cancellationToken);
        return revoked;
    }

    private Task<SecurityChallengeAttempt> RecordAttemptAsync(
        PoSpaceUnsupportedReissueRequest request,
        string reason,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                SecurityChallengeAttemptOutcomes.Failed,
                reason,
                PayloadHash: null,
                ClientIpHash: request.Binding.ClientIpHash,
                DeviceFpHash: request.Binding.DeviceFpHash,
                TraceId: request.Context.TraceIdentifier,
                Traceparent: request.Context.Request.Headers["traceparent"].ToString(),
                AttemptedAtUtc: timeProvider.GetUtcNow().UtcDateTime),
            cancellationToken);

    private ValueTask RecordRiskAsync(
        PoSpaceUnsupportedReissueRequest request,
        string detail,
        CancellationToken cancellationToken)
        => riskSignalSink.AddRiskAsync(
            new SecurityRiskSignal(
                request.Context,
                SecurityRiskReason.SecurityChallengeRejected,
                5,
                s_riskSignalTtl,
                SecurityRiskSources.RiskControl,
                request.Action,
                detail),
            cancellationToken);

    private RiskDecision SelectReplacement(RiskDecision current, SecurityRiskPolicy policy)
    {
        if (current.Kind is not (RiskDecisionKind.Challenge or RiskDecisionKind.StepUp)
            || !current.RequiredChallenges.Contains(Argon2idPoSpaceV1ChallengeProvider.WireKind, StringComparer.Ordinal))
        {
            return current with
            {
                Reasons = [.. current.Reasons, "pospace_unsupported_current_policy"]
            };
        }

        string[] remaining = current.RequiredChallenges
            .Where(static kind => !string.Equals(kind, Argon2idPoSpaceV1ChallengeProvider.WireKind, StringComparison.Ordinal))
            .ToArray();
        if (remaining.Length > 0)
        {
            return current with
            {
                RequiredChallenges = remaining,
                Reasons = [.. current.Reasons, "pospace_unsupported_removed"]
            };
        }

        return Block(current, "pospace_unsupported_no_policy_fallback");
    }

    private static RiskDecision Block(RiskDecision current, string reason)
        => current with
        {
            Kind = RiskDecisionKind.Block,
            RequiredChallenges = [],
            Reasons = [.. current.Reasons, reason]
        };

    private static bool IsBoundIssuedAssignment(
        SecurityChallenge? original,
        PoSpaceUnsupportedReissueRequest request,
        DateTime now)
        => original is not null
            && string.Equals(original.Status, SecurityChallengeStatuses.Issued, StringComparison.Ordinal)
            && original.ExpiresAtUtc > now
            && string.Equals(original.Kind, Argon2idPoSpaceV1ChallengeProvider.WireKind, StringComparison.Ordinal)
            && string.Equals(request.Kind, Argon2idPoSpaceV1ChallengeProvider.WireKind, StringComparison.Ordinal)
            && string.Equals(original.Action, request.Action, StringComparison.Ordinal)
            && string.Equals(original.RouteKey, request.RouteKey, StringComparison.Ordinal)
            && string.Equals(original.SubjectHash, request.Binding.SubjectHash, StringComparison.Ordinal)
            && string.Equals(original.ClientIpHash, request.Binding.ClientIpHash, StringComparison.Ordinal)
            && string.Equals(original.DeviceFpHash, request.Binding.DeviceFpHash, StringComparison.Ordinal);
}

internal static class PoSpaceUnsupportedReissueParser
{
    private static readonly IReadOnlySet<string> s_allowedProperties = new HashSet<string>(StringComparer.Ordinal)
    {
        "challengeId",
        "kind",
        "action",
        "routeKey",
        "reason",
        "reissueCount"
    };

    public static bool TryParse(
        string attributesJson,
        string action,
        string routeKey,
        RiskControlProofBinding binding,
        HttpContext context,
        out PoSpaceUnsupportedReissueRequest? request,
        out bool malformed)
    {
        request = null;
        malformed = false;
        if (string.IsNullOrWhiteSpace(attributesJson))
        {
            return true;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(attributesJson, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 4
            });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                malformed = true;
                return false;
            }
            if (!document.RootElement.TryGetProperty("unsupportedAssignment", out JsonElement unsupported))
            {
                return true;
            }

            if (unsupported.ValueKind != JsonValueKind.Object
                || unsupported.EnumerateObject().Count() != s_allowedProperties.Count
                || unsupported.EnumerateObject().Any(static property => !s_allowedProperties.Contains(property.Name)))
            {
                malformed = true;
                return false;
            }

            string challengeId = ReadString(unsupported, "challengeId", 64);
            string kind = ReadString(unsupported, "kind", 64);
            string unsupportedAction = ReadString(unsupported, "action", 96);
            string unsupportedRouteKey = ReadString(unsupported, "routeKey", 256);
            string reason = ReadString(unsupported, "reason", 32);
            int reissueCount = unsupported.TryGetProperty("reissueCount", out JsonElement countElement)
                && countElement.TryGetInt32(out int count)
                ? count
                : 0;
            if (challengeId.Length == 0
                || !string.Equals(kind, Argon2idPoSpaceV1ChallengeProvider.WireKind, StringComparison.Ordinal)
                || !string.Equals(unsupportedAction, action, StringComparison.Ordinal)
                || !string.Equals(unsupportedRouteKey, routeKey, StringComparison.Ordinal)
                || !PoSpaceV1Contract.UnsupportedReasons.Contains(reason)
                || reissueCount is < 1 or > PoSpaceV1Contract.MaxUnsupportedReissues)
            {
                malformed = true;
                return false;
            }

            request = new PoSpaceUnsupportedReissueRequest(
                context,
                challengeId,
                kind,
                action,
                routeKey,
                reason,
                reissueCount,
                binding);
            return true;
        }
        catch (JsonException)
        {
            malformed = true;
            return false;
        }
    }

    private static string ReadString(JsonElement value, string propertyName, int maxLength)
    {
        if (!value.TryGetProperty(propertyName, out JsonElement property)
            || property.ValueKind != JsonValueKind.String)
        {
            return string.Empty;
        }

        string raw = property.GetString() ?? string.Empty;
        string normalized = raw.Trim();
        return normalized.Length > 0
            && normalized.Length <= maxLength
            && string.Equals(raw, normalized, StringComparison.Ordinal)
                ? normalized
                : string.Empty;
    }
}
