using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed class HumanReadProofV1ChallengeProvider(
    IHumanReadProofService proofService,
    ISecurityChallengePersistenceService persistence,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "humanReadProofV1";
    public const string Algorithm = "fsu.human-read-proof@v1";

    private const int DefaultProofTtlSeconds = 300;

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!IsPublicRead(request.Action))
        {
            return SecurityChallengeProviderIssueResult.Failed("human_read_proof_public_read_only");
        }

        HumanReadChallengeRequest challengeRequest = CreateChallengeRequest(request.RouteKey);
        HumanReadChallengeResponse? response = await proofService.CreateChallengeAsync(request.Context, challengeRequest, cancellationToken);
        if (response is null || string.IsNullOrWhiteSpace(response.Token))
        {
            return SecurityChallengeProviderIssueResult.Failed("human_read_proof_challenge_rejected");
        }

        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = Algorithm,
            ["token"] = response.Token,
            ["scope"] = response.Scope,
            ["routeKey"] = response.RouteKey,
            ["articleId"] = response.ArticleId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            ["minDwellMs"] = response.MinDwellMs.ToString(CultureInfo.InvariantCulture),
            ["issuedAtUnixMs"] = response.IssuedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture),
            ["expiresAtUnixMs"] = response.ExpiresAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
        };

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
                HashPayload(payload),
                request.Context.TraceIdentifier,
                request.Traceparent,
                response.IssuedAt.UtcDateTime,
                response.ExpiresAt.UtcDateTime),
            cancellationToken);

        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            SecurityChallengeKind.HumanReadProofV1,
            request.EscalationLevel,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            response.IssuedAt.ToUnixTimeMilliseconds(),
            response.ExpiresAt.ToUnixTimeMilliseconds());

        return SecurityChallengeProviderIssueResult.Success(assignment, payload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!IsPublicRead(request.Action))
        {
            return SecurityChallengeProviderVerifyResult.Failed("human_read_proof_public_read_only");
        }

        if (!TryCreateSubmitRequest(request.ProviderPayload, request.RouteKey, out HumanReadSubmitRequest submitRequest))
        {
            await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Failed, "human_read_proof_payload_invalid", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("human_read_proof_payload_invalid");
        }

        HumanReadSubmitResponse response = await proofService.SubmitAsync(request.Context, submitRequest, cancellationToken);
        string payloadHash = HashPayload(request.ProviderPayload);
        if (!response.Counted)
        {
            string outcome = string.Equals(response.Status, "proof_replayed", StringComparison.OrdinalIgnoreCase)
                ? SecurityChallengeAttemptOutcomes.Replayed
                : string.Equals(response.Status, "proof_expired", StringComparison.OrdinalIgnoreCase)
                    ? SecurityChallengeAttemptOutcomes.Expired
                    : SecurityChallengeAttemptOutcomes.Failed;
            await RecordAttemptAsync(request, outcome, response.Status, payloadHash, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed($"human_read_proof_{response.Status}");
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, response.Status, payloadHash, cancellationToken);
        DateTimeOffset expiresAt = timeProvider.GetUtcNow().AddSeconds(DefaultProofTtlSeconds);
        return SecurityChallengeProviderVerifyResult.Success(expiresAt);
    }

    private static bool IsPublicRead(string action)
        => string.Equals(action, RiskActionNames.PublicRead, StringComparison.Ordinal);

    private static HumanReadChallengeRequest CreateChallengeRequest(string routeKey)
    {
        string normalizedRouteKey = string.IsNullOrWhiteSpace(routeKey) ? "site" : routeKey.Trim();
        int? articleId = TryExtractArticleId(normalizedRouteKey, out int parsed) ? parsed : null;
        return new HumanReadChallengeRequest(articleId is > 0 ? "article" : "site", normalizedRouteKey, articleId);
    }

    private static bool TryCreateSubmitRequest(
        IReadOnlyDictionary<string, string> payload,
        string expectedRouteKey,
        out HumanReadSubmitRequest request)
    {
        request = new HumanReadSubmitRequest(string.Empty, string.Empty, string.Empty, null, 0);
        if (!payload.TryGetValue("token", out string? token) || string.IsNullOrWhiteSpace(token)
            || !payload.TryGetValue("scope", out string? scope)
            || !payload.TryGetValue("routeKey", out string? routeKey)
            || string.IsNullOrWhiteSpace(routeKey)
            || !string.Equals(routeKey.Trim(), expectedRouteKey.Trim(), StringComparison.Ordinal)
            || !payload.TryGetValue("dwellMs", out string? rawDwellMs)
            || !int.TryParse(rawDwellMs, NumberStyles.None, CultureInfo.InvariantCulture, out int dwellMs)
            || dwellMs < 0)
        {
            return false;
        }

        string normalizedScope = TextHelpers.LowerTrimmed(scope) ?? string.Empty;
        if (normalizedScope is not ("site" or "article"))
        {
            return false;
        }

        int? articleId = null;
        if (payload.TryGetValue("articleId", out string? rawArticleId) && !string.IsNullOrWhiteSpace(rawArticleId))
        {
            if (!int.TryParse(rawArticleId, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) || parsed <= 0)
            {
                return false;
            }

            articleId = parsed;
        }

        if (normalizedScope == "article" && articleId is not > 0)
        {
            return false;
        }

        request = new HumanReadSubmitRequest(token.Trim(), normalizedScope, routeKey.Trim(), articleId, dwellMs);
        return true;
    }

    private static bool TryExtractArticleId(string routeKey, out int articleId)
    {
        articleId = 0;
        string normalized = routeKey.Trim();
        if (normalized.StartsWith("article:", StringComparison.OrdinalIgnoreCase))
        {
            return int.TryParse(normalized["article:".Length..], NumberStyles.None, CultureInfo.InvariantCulture, out articleId)
                && articleId > 0;
        }

        string[] segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (int i = 0; i < segments.Length - 1; i++)
        {
            if (string.Equals(segments[i], "article", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(segments[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out articleId)
                && articleId > 0)
            {
                return true;
            }
        }

        return false;
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? payloadHash,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                payloadHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                DateTime.UtcNow),
            cancellationToken);

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values)
            ? values.ToString()
            : null;

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
