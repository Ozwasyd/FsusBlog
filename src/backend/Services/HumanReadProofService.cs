using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class HumanReadProofService(
    IConfiguration configuration,
    IUnifiedCache cache,
    VisitLogChannel channel,
    TimeProvider timeProvider,
    ILogger<HumanReadProofService> logger) : IHumanReadProofService
{
    private const int DefaultMinDwellMs = 8000;
    private const int MaxRouteKeyLength = 200;
    private const int MaxDeviceFingerprintLength = 128;
    private const string HeaderDeviceFingerprint = "X-Fsus-Device-Fp";
    private static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan ReplayTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ViewerDedupTtl = TimeSpan.FromHours(24);
    private readonly byte[] _hmacKey = CreateHmacKey(configuration);

    public ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(
        HttpContext context,
        HumanReadChallengeRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsEnforcedMode())
        {
            return ValueTask.FromResult(CreatePausedChallenge(request));
        }

        if (!TryValidateRequestContext(context, out string? deviceFp, out _, out _)
            || !TryNormalizeScope(request.Scope, out string scope)
            || !TryNormalizeRouteKey(request.RouteKey, out string routeKey)
            || !TryNormalizeArticle(scope, request.ArticleId, out int? articleId))
        {
            return ValueTask.FromResult<HumanReadChallengeResponse?>(null);
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = now.Add(ChallengeTtl);
        string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var payload = new ChallengePayload(
            scope,
            routeKey,
            articleId,
            HashValue(deviceFp),
            HashValue(context.GetClientIp()),
            HashValue(GetUserAgent(context)),
            now.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds(),
            DefaultMinDwellMs,
            nonce);

        string token = EncodeToken(payload);
        return ValueTask.FromResult<HumanReadChallengeResponse?>(new HumanReadChallengeResponse(token, scope, routeKey, articleId, DefaultMinDwellMs, now, expiresAt));
    }

    public async ValueTask<HumanReadSubmitResponse> SubmitAsync(
        HttpContext context,
        HumanReadSubmitRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsEnforcedMode())
        {
            return new HumanReadSubmitResponse(false, "paused");
        }

        if (!TryValidateRequestContext(context, out string? deviceFp, out string? rejectReason, out bool browserContext))
        {
            LogRejected(rejectReason ?? "context_invalid", browserContext);
            return new HumanReadSubmitResponse(false, rejectReason ?? "context_invalid");
        }

        if (!TryDecodeToken(request.Token, out ChallengePayload? payload)
            || payload is null
            || !TryNormalizeScope(request.Scope, out string scope)
            || !TryNormalizeRouteKey(request.RouteKey, out string routeKey)
            || !TryNormalizeArticle(scope, request.ArticleId, out int? articleId)
            || !string.Equals(payload.Scope, scope, StringComparison.Ordinal)
            || !string.Equals(payload.RouteKey, routeKey, StringComparison.Ordinal)
            || payload.ArticleId != articleId)
        {
            return new HumanReadSubmitResponse(false, "proof_invalid");
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        long nowMs = now.ToUnixTimeMilliseconds();
        if (nowMs > payload.ExpiresAtMs)
        {
            return new HumanReadSubmitResponse(false, "proof_expired");
        }

        if (nowMs - payload.IssuedAtMs < payload.MinDwellMs || request.DwellMs < payload.MinDwellMs)
        {
            return new HumanReadSubmitResponse(false, "dwell_too_short");
        }

        if (!FixedHashEquals(payload.DeviceFpHash, HashValue(deviceFp))
            || !FixedHashEquals(payload.IpHash, HashValue(context.GetClientIp()))
            || !FixedHashEquals(payload.UserAgentHash, HashValue(GetUserAgent(context))))
        {
            return new HumanReadSubmitResponse(false, "proof_binding_mismatch");
        }

        string proofId = HashValue(request.Token);
        if (!await cache.TryAcquireLeaseAsync(CachePolicyId.HumanReadProof, $"proof:{proofId}", "1", ReplayTtl, cancellationToken))
        {
            return new HumanReadSubmitResponse(false, "proof_replayed");
        }

        string viewerKeyHash = BuildViewerKeyHash(payload);
        string lockIdentity = $"viewer:{payload.Scope}:{payload.ArticleId?.ToString() ?? "site"}:{viewerKeyHash}";
        if (!await cache.TryAcquireLeaseAsync(CachePolicyId.HumanReadProof, lockIdentity, "1", ViewerDedupTtl, cancellationToken))
        {
            return new HumanReadSubmitResponse(false, "duplicate_viewer");
        }

        int userId = context.GetUserId();
        bool accepted = channel.TryWrite(new VisitLogMessage(
            context.GetClientIp(),
            userId > 0 ? userId : null,
            now.UtcDateTime,
            payload.Scope == "article" ? HumanReadEventTypes.ArticleRead : HumanReadEventTypes.SiteRead,
            payload.RouteKey,
            payload.ArticleId,
            viewerKeyHash,
            proofId,
            Math.Max(request.DwellMs, payload.MinDwellMs)), out bool saturated);

        if (!accepted || saturated)
        {
            logger.LogWarning(
                "真人阅读事件通道出现写入压力 | Accepted: {Accepted} | Saturated: {Saturated} | Scope: {Scope}",
                accepted,
                saturated,
                payload.Scope);
        }

        return new HumanReadSubmitResponse(accepted, accepted ? "counted" : "queue_rejected");
    }

    private HumanReadChallengeResponse? CreatePausedChallenge(HumanReadChallengeRequest request)
    {
        if (!TryNormalizeScope(request.Scope, out string scope)
            || !TryNormalizeRouteKey(request.RouteKey, out string routeKey)
            || !TryNormalizeArticle(scope, request.ArticleId, out int? articleId))
        {
            return null;
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        return new HumanReadChallengeResponse(string.Empty, scope, routeKey, articleId, DefaultMinDwellMs, now, now);
    }

    private bool IsEnforcedMode()
    {
        string mode = configuration["HumanReadProof:Mode"] ?? "enforce";
        return !string.Equals(mode, "paused", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryValidateRequestContext(HttpContext context, out string deviceFp, out string? reason, out bool browserContext)
    {
        deviceFp = string.Empty;
        reason = null;
        browserContext = false;

        if (context.Items.TryGetValue("VerifiedCrawler", out object? verifiedCrawler)
            && verifiedCrawler is true)
        {
            reason = "verified_crawler";
            return false;
        }

        string userAgent = GetUserAgent(context);
        if (string.IsNullOrWhiteSpace(userAgent))
        {
            reason = "ua_missing";
            return false;
        }

        string normalizedUa = userAgent.ToLowerInvariant();
        if (normalizedUa.Contains("bot", StringComparison.Ordinal)
            || normalizedUa.Contains("spider", StringComparison.Ordinal)
            || normalizedUa.Contains("crawler", StringComparison.Ordinal)
            || normalizedUa.Contains("curl", StringComparison.Ordinal)
            || normalizedUa.Contains("wget", StringComparison.Ordinal)
            || normalizedUa.Contains("python", StringComparison.Ordinal)
            || normalizedUa.Contains("httpclient", StringComparison.Ordinal)
            || normalizedUa.Contains("axios", StringComparison.Ordinal)
            || normalizedUa.Contains("go-http-client", StringComparison.Ordinal))
        {
            reason = "ua_blocked";
            return false;
        }

        if (!context.Request.Headers.TryGetValue(HeaderDeviceFingerprint, out var rawFp)
            || rawFp.Count != 1
            || !TryNormalizeDeviceFingerprint(rawFp.ToString(), out deviceFp))
        {
            reason = "fingerprint_missing";
            return false;
        }

        if (!HasTrustedFetchMetadata(context))
        {
            reason = "fetch_metadata_invalid";
            return false;
        }

        if (!HasTrustedOriginOrReferer(context))
        {
            reason = "origin_invalid";
            return false;
        }

        browserContext = true;
        return true;
    }

    private static bool HasTrustedFetchMetadata(HttpContext context)
    {
        var headers = context.Request.Headers;
        string site = headers["Sec-Fetch-Site"].ToString();
        string mode = headers["Sec-Fetch-Mode"].ToString();
        string dest = headers["Sec-Fetch-Dest"].ToString();

        bool siteOk = site.Equals("same-origin", StringComparison.OrdinalIgnoreCase)
            || site.Equals("same-site", StringComparison.OrdinalIgnoreCase)
            || site.Equals("none", StringComparison.OrdinalIgnoreCase);
        bool modeOk = mode.Equals("cors", StringComparison.OrdinalIgnoreCase)
            || mode.Equals("same-origin", StringComparison.OrdinalIgnoreCase);
        bool destOk = dest.Equals("empty", StringComparison.OrdinalIgnoreCase);

        return siteOk && modeOk && destOk;
    }

    private static bool HasTrustedOriginOrReferer(HttpContext context)
    {
        var trusted = ResolveTrustedOrigins(context);
        string origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrWhiteSpace(origin) && trusted.Contains(NormalizeOrigin(origin)))
        {
            return true;
        }

        string referer = context.Request.Headers.Referer.ToString();
        if (Uri.TryCreate(referer, UriKind.Absolute, out Uri? refererUri)
            && trusted.Contains(refererUri.GetLeftPart(UriPartial.Authority)))
        {
            return true;
        }

        return false;
    }

    private static HashSet<string> ResolveTrustedOrigins(HttpContext context)
    {
        var trusted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        trusted.Add($"{context.Request.Scheme}://{context.Request.Host.Value}");

        IConfiguration config = context.RequestServices.GetRequiredService<IConfiguration>();
        string? configured = config["CORS_ALLOWED_HOSTS"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            foreach (string raw in configured.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                string normalized = NormalizeOrigin(raw);
                if (!string.IsNullOrWhiteSpace(normalized))
                {
                    trusted.Add(normalized);
                }
            }
        }

        if (context.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment())
        {
            trusted.Add("http://localhost:3000");
            trusted.Add("http://127.0.0.1:3000");
        }

        return trusted;
    }

    private static string NormalizeOrigin(string value)
        => Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            ? uri.GetLeftPart(UriPartial.Authority)
            : string.Empty;

    private static bool TryNormalizeScope(string? raw, out string scope)
    {
        scope = (raw ?? string.Empty).Trim().ToLowerInvariant();
        return scope is "site" or "article";
    }

    private static bool TryNormalizeRouteKey(string? raw, out string routeKey)
    {
        routeKey = (raw ?? string.Empty).Trim();
        if (routeKey.Length is 0 or > MaxRouteKeyLength)
        {
            return false;
        }

        for (int i = 0; i < routeKey.Length; i++)
        {
            char ch = routeKey[i];
            if (char.IsControl(ch) || ch == '\\')
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryNormalizeArticle(string scope, int? rawArticleId, out int? articleId)
    {
        articleId = null;
        if (scope == "site")
        {
            return rawArticleId is null or <= 0;
        }

        if (rawArticleId is not > 0)
        {
            return false;
        }

        articleId = rawArticleId.Value;
        return true;
    }

    private static bool TryNormalizeDeviceFingerprint(string? raw, out string fingerprint)
    {
        fingerprint = (raw ?? string.Empty).Trim();
        if (fingerprint.Length is < 8 or > MaxDeviceFingerprintLength)
        {
            return false;
        }

        for (int i = 0; i < fingerprint.Length; i++)
        {
            char ch = fingerprint[i];
            if (!(char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.' or ':'))
            {
                return false;
            }
        }

        return true;
    }

    private string EncodeToken(ChallengePayload payload)
    {
        string payloadText = string.Join('|',
            "v1",
            Base64UrlEncode(Encoding.UTF8.GetBytes(payload.Scope)),
            Base64UrlEncode(Encoding.UTF8.GetBytes(payload.RouteKey)),
            payload.ArticleId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            payload.DeviceFpHash,
            payload.IpHash,
            payload.UserAgentHash,
            payload.IssuedAtMs.ToString(CultureInfo.InvariantCulture),
            payload.ExpiresAtMs.ToString(CultureInfo.InvariantCulture),
            payload.MinDwellMs.ToString(CultureInfo.InvariantCulture),
            payload.Nonce);
        byte[] payloadBytes = Encoding.UTF8.GetBytes(payloadText);
        byte[] signature = HMACSHA256.HashData(_hmacKey, payloadBytes);
        return $"{Base64UrlEncode(payloadBytes)}.{Base64UrlEncode(signature)}";
    }

    private bool TryDecodeToken(string? token, out ChallengePayload? payload)
    {
        payload = null;
        string[] parts = (token ?? string.Empty).Split('.', 2);
        if (parts.Length != 2
            || !TryBase64UrlDecode(parts[0], out byte[]? payloadBytes)
            || !TryBase64UrlDecode(parts[1], out byte[]? signature))
        {
            return false;
        }

        byte[] actualPayloadBytes = payloadBytes ?? [];
        byte[] actualSignature = signature ?? [];
        byte[] expected = HMACSHA256.HashData(_hmacKey, actualPayloadBytes);
        if (actualSignature.Length != expected.Length
            || !CryptographicOperations.FixedTimeEquals(actualSignature, expected))
        {
            return false;
        }

        string payloadText = Encoding.UTF8.GetString(actualPayloadBytes);
        string[] fields = payloadText.Split('|');
        if (fields.Length != 11
            || !string.Equals(fields[0], "v1", StringComparison.Ordinal)
            || !TryBase64UrlDecodeString(fields[1], out string scope)
            || !TryBase64UrlDecodeString(fields[2], out string routeKey)
            || !TryParseNullableInt(fields[3], out int? articleId)
            || !long.TryParse(fields[7], NumberStyles.None, CultureInfo.InvariantCulture, out long issuedAtMs)
            || !long.TryParse(fields[8], NumberStyles.None, CultureInfo.InvariantCulture, out long expiresAtMs)
            || !int.TryParse(fields[9], NumberStyles.None, CultureInfo.InvariantCulture, out int minDwellMs)
            || fields[3].Length > 0 && articleId is null)
        {
            return false;
        }

        if (fields[4].Length != 64
            || fields[5].Length != 64
            || fields[6].Length != 64
            || fields[10].Length == 0)
        {
            return false;
        }

        payload = new ChallengePayload(
            scope,
            routeKey,
            articleId,
            fields[4],
            fields[5],
            fields[6],
            issuedAtMs,
            expiresAtMs,
            minDwellMs,
            fields[10]);
        return true;
    }

    private static string BuildViewerKeyHash(ChallengePayload payload)
        => HashValue(string.Join(':',
            payload.Scope,
            payload.RouteKey,
            payload.ArticleId?.ToString() ?? "0",
            payload.DeviceFpHash,
            payload.IpHash,
            payload.UserAgentHash));

    private static string GetUserAgent(HttpContext context)
        => context.Request.Headers.UserAgent.ToString();

    private static string HashValue(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool FixedHashEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.ASCII.GetBytes(left);
        byte[] rightBytes = Encoding.ASCII.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static byte[] CreateHmacKey(IConfiguration configuration)
    {
        string secret = configuration["Jwt:SecretKey"] ?? string.Empty;
        if (string.IsNullOrWhiteSpace(secret))
        {
            secret = string.Concat("FsusBlog:HumanReadProof:Fallback:", Environment.MachineName, ":", AppContext.BaseDirectory);
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(secret));
    }

    private static string Base64UrlEncode(byte[] value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryBase64UrlDecode(string value, out byte[]? bytes)
    {
        bytes = null;
        string normalized = value.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight(normalized.Length + (4 - normalized.Length % 4) % 4, '=');
        byte[] buffer = new byte[normalized.Length];
        if (!Convert.TryFromBase64String(normalized, buffer, out int bytesWritten))
        {
            return false;
        }

        bytes = buffer.AsSpan(0, bytesWritten).ToArray();
        return true;
    }

    private static bool TryBase64UrlDecodeString(string value, out string text)
    {
        text = string.Empty;
        if (!TryBase64UrlDecode(value, out byte[]? bytes) || bytes is null)
        {
            return false;
        }

        text = Encoding.UTF8.GetString(bytes);
        return true;
    }

    private static bool TryParseNullableInt(string value, out int? result)
    {
        result = null;
        if (value.Length == 0)
        {
            return true;
        }

        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed))
        {
            return false;
        }

        result = parsed;
        return true;
    }

    private void LogRejected(string reason, bool browserContext)
    {
        logger.LogInformation(
            "真人阅读 proof 已拒绝 | Reason: {Reason} | BrowserContext: {BrowserContext}",
            reason,
            browserContext);
    }

    private sealed record class ChallengePayload(
        string Scope,
        string RouteKey,
        int? ArticleId,
        string DeviceFpHash,
        string IpHash,
        string UserAgentHash,
        long IssuedAtMs,
        long ExpiresAtMs,
        int MinDwellMs,
        string Nonce);
}
