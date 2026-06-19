using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed class PasskeyStepUpV1ChallengeProvider(
    IPasskeyService passkeyService,
    ISecurityChallengePersistenceService persistence,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "passkeyStepUpV1";
    public const string Algorithm = "fsu.passkey-step-up@v1";

    private const int ChallengeTtlSeconds = 300;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static JsonSerializerOptions JsonOptionsForTests => JsonOptions;

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        int userId = ResolveOrdinaryUserId(request.Context);
        if (userId <= 0)
        {
            return SecurityChallengeProviderIssueResult.Failed("passkey_step_up_user_required");
        }

        var (success, message, data) = await passkeyService.BeginStepUpAssertionAsync(userId, cancellationToken);
        if (!success || data is null)
        {
            return SecurityChallengeProviderIssueResult.Failed(NormalizeReason(message, "passkey_step_up_unavailable"));
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
            SecurityChallengeKind.PasskeyStepUpV1,
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

        int userId = ResolveOrdinaryUserId(request.Context);
        if (userId <= 0)
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "passkey_step_up_user_required", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("passkey_step_up_user_required");
        }

        if (!TryReadAssertion(request.ProviderPayload, out PasskeyLoginCompleteCoreModel? assertion, out string? assertionJson))
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "passkey_step_up_payload_invalid", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("passkey_step_up_payload_invalid");
        }

        var (success, message) = await passkeyService.CompleteStepUpAssertionAsync(userId, assertion, cancellationToken);
        if (!success)
        {
            string reason = NormalizeReason(message, "passkey_step_up_failed");
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, reason, assertionJson, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed(reason);
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", assertion.ChallengeToken, cancellationToken);
        return SecurityChallengeProviderVerifyResult.Success(timeProvider.GetUtcNow().AddSeconds(ChallengeTtlSeconds));
    }

    private static int ResolveOrdinaryUserId(HttpContext context)
    {
        if (context.User.Identity?.IsAuthenticated != true || context.User.IsAdminPrincipal())
        {
            return 0;
        }

        return context.User.GetUserId();
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

        try
        {
            PasskeyLoginCompleteCoreModel? parsed = JsonSerializer.Deserialize<PasskeyLoginCompleteCoreModel>(raw, JsonOptions);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.ChallengeToken) || string.IsNullOrWhiteSpace(parsed.Id))
            {
                return false;
            }

            assertion = parsed;
            assertionJson = raw;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
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

            chars[written++] = char.IsAsciiLetterOrDigit(ch) || ch is '_' or '-' ? ch : '_';
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
