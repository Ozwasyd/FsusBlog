using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed class AdminPasskeyStepUpV1ChallengeProvider(
    IAdminPrincipalService adminPrincipals,
    ISecurityChallengePersistenceService persistence,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "adminPasskeyStepUpV1";
    public const string Algorithm = "fsu.admin-passkey-step-up@v1";

    private const int ChallengeTtlSeconds = 300;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!TryResolveAdminSession(request.Context, out long adminPrincipalId, out string adminSessionId))
        {
            return SecurityChallengeProviderIssueResult.Failed("admin_passkey_step_up_admin_required");
        }

        var (success, message, data) = await adminPrincipals.BeginAdminStepUpAssertionAsync(adminPrincipalId, adminSessionId, cancellationToken);
        if (!success || data is null)
        {
            return SecurityChallengeProviderIssueResult.Failed(NormalizeReason(message, "admin_passkey_step_up_unavailable"));
        }

        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = issuedAt.AddSeconds(ChallengeTtlSeconds);
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = Algorithm,
            ["challengeToken"] = data.Options.ChallengeToken,
            ["optionsJson"] = JsonSerializer.Serialize(data.Options, JsonOptions)
        };
        string payloadHash = HashPayload(payload);

        await persistence.IssueAsync(
            new SecurityChallengeIssueRequest(
                challengeId,
                WireKind,
                Algorithm,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                payloadHash,
                request.Context.TraceIdentifier,
                request.Traceparent,
                issuedAt.UtcDateTime,
                expiresAt.UtcDateTime),
            cancellationToken);

        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            SecurityChallengeKind.AdminPasskeyStepUpV1,
            request.EscalationLevel,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds());
        return SecurityChallengeProviderIssueResult.Success(assignment, payload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!TryResolveAdminSession(request.Context, out long adminPrincipalId, out string adminSessionId))
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "admin_passkey_step_up_admin_required", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("admin_passkey_step_up_admin_required");
        }

        if (!TryReadAssertion(request.ProviderPayload, out PasskeyLoginCompleteCoreModel? assertion, out string? assertionJson))
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "admin_passkey_step_up_payload_invalid", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("admin_passkey_step_up_payload_invalid");
        }

        var (success, message) = await adminPrincipals.VerifyAdminStepUpAssertionAsync(
            adminPrincipalId,
            adminSessionId,
            assertion,
            AdminAuthClientContext.From(request.Context),
            cancellationToken);
        if (!success)
        {
            string reason = NormalizeReason(message, "admin_passkey_step_up_failed");
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, reason, assertionJson, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed(reason);
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", assertion.ChallengeToken, cancellationToken);
        return SecurityChallengeProviderVerifyResult.Success(timeProvider.GetUtcNow().AddSeconds(ChallengeTtlSeconds));
    }

    private static bool TryResolveAdminSession(HttpContext context, out long adminPrincipalId, out string adminSessionId)
    {
        adminPrincipalId = 0;
        adminSessionId = string.Empty;
        if (context.User.Identity?.IsAuthenticated != true ||
            !context.User.IsAdminPrincipal() ||
            !context.User.TryGetAdminPrincipalId(out long parsedId))
        {
            return false;
        }

        string? parsedSessionId = context.User.GetAdminSessionId();
        if (string.IsNullOrWhiteSpace(parsedSessionId))
        {
            return false;
        }

        adminPrincipalId = parsedId;
        adminSessionId = parsedSessionId.Trim();
        return true;
    }

    private static bool TryReadAssertion(
        IReadOnlyDictionary<string, string> payload,
        out PasskeyLoginCompleteCoreModel assertion,
        out string? assertionJson)
    {
        assertion = new PasskeyLoginCompleteCoreModel();
        assertionJson = null;
        if (!payload.TryGetValue("assertionJson", out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        if (SecurityAssertionPayloadParser.TryParse(raw, out PasskeyLoginCompleteCoreModel parsed))
        {
            assertion = parsed;
            assertionJson = raw;
            return true;
        }

        return false;
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? proofMaterial,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                string.IsNullOrWhiteSpace(proofMaterial) ? null : HashValue(proofMaterial),
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                timeProvider.GetUtcNow().UtcDateTime),
            cancellationToken);

    private static string NormalizeReason(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        Span<char> chars = stackalloc char[Math.Min(normalized.Length, 96)];
        int written = 0;
        foreach (char ch in normalized)
        {
            if (written >= chars.Length)
            {
                break;
            }

            chars[written++] = TextHelpers.IsAsciiTokenChar(ch, "_-") ? ch : '_';
        }

        return written == 0 ? fallback : new string(chars[..written]);
    }

    private static string ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values)
            ? values.ToString()
            : string.Empty;

    private static string HashPayload(IReadOnlyDictionary<string, string> payload)
    {
        var builder = new StringBuilder();
        foreach (KeyValuePair<string, string> item in payload.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            builder.Append(item.Key);
            builder.Append('\0');
            builder.Append(item.Value);
            builder.Append('\n');
        }

        return HashValue(builder.ToString());
    }

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
