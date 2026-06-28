using System.Collections.Frozen;
using System.Security.Claims;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamHandshakeService
{
    Task<NotificationStreamHandshakeResult> ValidateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool requireWebSocket = true);
}

internal sealed record NotificationStreamHandshake(string Protocol, string? UserId, IReadOnlySet<string> Groups);

internal sealed record NotificationStreamHandshakeResult
{
    private NotificationStreamHandshakeResult(NotificationStreamHandshake? handshake, int statusCode, string? errorCode)
    {
        Handshake = handshake;
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }

    public NotificationStreamHandshake? Handshake { get; }

    public int StatusCode { get; }

    public string? ErrorCode { get; }

    public bool IsSuccess => Handshake is not null;

    public static NotificationStreamHandshakeResult Success(NotificationStreamHandshake handshake) => new(handshake, StatusCodes.Status200OK, null);

    public static NotificationStreamHandshakeResult Failure(int statusCode, string errorCode) => new(null, statusCode, errorCode);
}

// Design reference: docs/api/design.md "通知通道设计约定".
internal sealed class NotificationStreamHandshakeService(
    IPowService powService,
    AdaptivePowGovernor powGovernor,
    ISecurityRiskScoreReader riskScoreReader,
    ISecurityRiskPolicyProvider riskPolicyProvider,
    IRiskControlContextFactory riskContextFactory,
    IRiskDecisionService riskDecisionService,
    ISecurityChallengeProofService challengeProofService,
    ISecurityRiskSignalSink riskSignalSink,
    INotificationStreamAdmissionService admissionService,
    INotificationStreamAudienceResolver audienceResolver,
    NotificationStreamOriginSnapshotProvider originSnapshotProvider,
    IWebHostEnvironment environment,
    ILoggerFactory loggerFactory) : INotificationStreamHandshakeService
{
    private const string Protocol = "fsus-aeds.v2";
    private const string ChallengeProofHeaderName = "X-Fsus-Challenge-Proof";
    private const string ChallengeIdHeaderName = "X-Fsus-Challenge-Id";
    private const string ChallengeKindHeaderName = "X-Fsus-Challenge-Kind";
    private const string ChallengeProofQueryName = "challengeProof";
    private const string ChallengeIdQueryName = "challengeId";
    private const string ChallengeKindQueryName = "challengeKind";
    private static readonly TimeSpan RiskSignalTtl = TimeSpan.FromMinutes(10);

    public async Task<NotificationStreamHandshakeResult> ValidateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool requireWebSocket = true)
    {
        if (requireWebSocket && !context.WebSockets.IsWebSocketRequest)
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status426UpgradeRequired, "websocket_required");
        }

        NotificationStreamHandshakeResult? originFailure = ValidateOrigin(context);
        if (originFailure is not null)
        {
            return originFailure;
        }

        string requestedProtocol = context.Request.Headers.SecWebSocketProtocol.ToString();
        if (string.IsNullOrWhiteSpace(requestedProtocol))
        {
            requestedProtocol = context.Request.Headers["X-Fsus-Notification-Stream-Protocol"].ToString();
        }

        if (!ContainsRequestedProtocol(requestedProtocol))
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status409Conflict, "protocol_mismatch");
        }

        bool isAuthenticated = context.User.Identity?.IsAuthenticated == true;
        bool hasAuthHeader = context.Request.Headers.ContainsKey("Authorization");
        if (hasAuthHeader && !isAuthenticated)
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status401Unauthorized, "auth_failed");
        }

        if (!isAuthenticated)
        {
            NotificationStreamHandshakeResult? riskFailure = await ValidateAnonymousSubscribeGateAsync(
                context,
                cancellationToken,
                consumeProof: requireWebSocket);
            if (riskFailure is not null)
            {
                return riskFailure;
            }
        }

        bool isAdminPrincipal = isAuthenticated &&
            context.User.IsAdminPrincipal() &&
            context.User.TryGetAdminPrincipalId(out _);
        string? userId = isAuthenticated && !isAdminPrincipal
            ? context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            : null;

        var admission = await admissionService.ValidateAsync(userId, cancellationToken);
        if (!admission.IsAllowed)
        {
            return NotificationStreamHandshakeResult.Failure(admission.StatusCode, admission.ErrorCode ?? "admission_failed");
        }

        IReadOnlySet<string> groups = audienceResolver.ResolveGroups(context.User, userId);
        return NotificationStreamHandshakeResult.Success(new NotificationStreamHandshake(Protocol, userId, groups));
    }

    private async Task<NotificationStreamHandshakeResult?> ValidateAnonymousSubscribeGateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool consumeProof)
    {
        NotificationStreamHandshakeResult? legacyPowFailure = null;
        if (context.Request.Query.ContainsKey("pow"))
        {
            if (!consumeProof)
            {
                return null;
            }

            Microsoft.Extensions.Logging.ILogger powLogger = loggerFactory.CreateLogger("FsusBlog.NotificationStream.Pow");
            IActionResult? powFailure = await PowValidationLogic.ValidateFromQueryAsync(context, powLogger, powService, powGovernor);
            if (powFailure is null)
            {
                return null;
            }

            legacyPowFailure = NotificationStreamHandshakeResult.Failure(
                ResolveStatusCode(powFailure, StatusCodes.Status401Unauthorized),
                "pow_failed");
        }

        context.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(RiskActionNames.NotificationSubscribe);
        RiskControlContext riskContext = riskContextFactory.Create(context);
        int riskScore = await riskScoreReader.GetRiskScoreAsync(context, cancellationToken);
        SecurityRiskPolicySnapshotV2 policy = riskPolicyProvider.CurrentRiskPolicyV2;
        RiskDecision decision = riskDecisionService.Decide(riskContext, policy, riskScore);

        return decision.Kind switch
        {
            RiskDecisionKind.Allow => null,
            RiskDecisionKind.Challenge or RiskDecisionKind.StepUp => await ValidateRiskControlProofAsync(
                context,
                riskContext,
                decision,
                legacyPowFailure,
                consumeProof,
                cancellationToken),
            RiskDecisionKind.Block => await RejectRiskAsync(
                context,
                decision,
                StatusCodes.Status429TooManyRequests,
                "risk_control_blocked",
                "risk_control_blocked",
                cancellationToken),
            RiskDecisionKind.QueueForModeration or RiskDecisionKind.Throttle => await RejectRiskAsync(
                context,
                decision,
                StatusCodes.Status429TooManyRequests,
                "risk_control_throttled",
                "risk_control_throttled",
                cancellationToken),
            _ => await RejectRiskAsync(
                context,
                decision,
                StatusCodes.Status429TooManyRequests,
                "risk_control_rejected",
                "risk_control_rejected",
                cancellationToken)
        };
    }

    private async Task<NotificationStreamHandshakeResult?> ValidateRiskControlProofAsync(
        HttpContext context,
        RiskControlContext riskContext,
        RiskDecision decision,
        NotificationStreamHandshakeResult? legacyPowFailure,
        bool consumeProof,
        CancellationToken cancellationToken)
    {
        if (!TryReadChallengeProof(context, out string proofToken, out string challengeId, out string challengeKind))
        {
            await RecordRiskAsync(context, "challenge_proof_missing", decision.ActionName, cancellationToken);
            return legacyPowFailure ?? NotificationStreamHandshakeResult.Failure(StatusCodes.Status428PreconditionRequired, "risk_challenge_required");
        }

        string canonicalChallengeKind = CanonicalChallengeKind(challengeKind);
        if (decision.RequiredChallenges.Count > 0
            && !decision.RequiredChallenges.Any(required => string.Equals(CanonicalChallengeKind(required), canonicalChallengeKind, StringComparison.Ordinal)))
        {
            await RecordRiskAsync(context, $"challenge_kind_mismatch:{challengeKind}", decision.ActionName, cancellationToken);
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status428PreconditionRequired, "risk_challenge_kind_mismatch");
        }

        if (!consumeProof)
        {
            return null;
        }

        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        SecurityChallengeProofConsumeResult proof = await challengeProofService.ConsumeProofAsync(
            new SecurityChallengeProofConsumeRequest(
                proofToken,
                challengeId,
                canonicalChallengeKind,
                decision.ActionName,
                decision.RouteKey,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                decision.PolicyVersion),
            cancellationToken);
        if (proof.Accepted)
        {
            return null;
        }

        await RecordRiskAsync(context, $"challenge_proof_rejected:{proof.Reason}", decision.ActionName, cancellationToken);
        return NotificationStreamHandshakeResult.Failure(StatusCodes.Status428PreconditionRequired, "risk_challenge_rejected");
    }

    private async Task<NotificationStreamHandshakeResult> RejectRiskAsync(
        HttpContext context,
        RiskDecision decision,
        int statusCode,
        string errorCode,
        string detail,
        CancellationToken cancellationToken)
    {
        await RecordRiskAsync(context, string.Join(',', decision.Reasons.Prepend(detail)), decision.ActionName, cancellationToken);
        return NotificationStreamHandshakeResult.Failure(statusCode, errorCode);
    }

    private NotificationStreamHandshakeResult? ValidateOrigin(HttpContext context)
    {
        long started = Stopwatch.GetTimestamp();
        string originHeader = context.Request.Headers.Origin.ToString();
        if (string.IsNullOrWhiteSpace(originHeader))
        {
            return environment.IsProduction() && !IsInternalProbe(context)
                ? NotificationStreamHandshakeResult.Failure(StatusCodes.Status403Forbidden, "origin_not_allowed")
                : null;
        }

        if (!Uri.TryCreate(originHeader, UriKind.Absolute, out Uri? origin))
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        if (IsDevelopmentLocalhostOrigin(origin))
        {
            return null;
        }

        if (environment.IsProduction() && !IsProductionSafeOriginScheme(origin.Scheme))
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        NotificationStreamOriginSnapshot originSnapshot = originSnapshotProvider.Current;
        string normalizedOrigin = NormalizeOrigin(origin);
        if (!originSnapshot.AllowedOrigins.Contains(normalizedOrigin))
        {
            FsusObservability.RecordNotificationStreamOriginValidation("origin", false, Stopwatch.GetElapsedTime(started));
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        if (!originSnapshot.AllowedHosts.Contains(origin.Host))
        {
            FsusObservability.RecordNotificationStreamOriginValidation("host", false, Stopwatch.GetElapsedTime(started));
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        FsusObservability.RecordNotificationStreamOriginValidation("origin", true, Stopwatch.GetElapsedTime(started));
        return null;
    }

    private static int ResolveStatusCode(IActionResult result, int fallback)
    {
        return result switch
        {
            ObjectResult objectResult when objectResult.StatusCode.HasValue => objectResult.StatusCode.Value,
            StatusCodeResult statusCodeResult => statusCodeResult.StatusCode,
            _ => fallback
        };
    }

    private static bool TryReadChallengeProof(
        HttpContext context,
        out string proofToken,
        out string challengeId,
        out string challengeKind)
    {
        if (TryReadChallengeProofHeaders(context, out proofToken, out challengeId, out challengeKind))
        {
            return true;
        }

        return TryReadChallengeProofQuery(context, out proofToken, out challengeId, out challengeKind);
    }

    private static bool TryReadChallengeProofHeaders(
        HttpContext context,
        out string proofToken,
        out string challengeId,
        out string challengeKind)
    {
        proofToken = string.Empty;
        challengeId = string.Empty;
        challengeKind = string.Empty;
        return TryReadSingleHeader(context, ChallengeProofHeaderName, out proofToken)
            && TryReadSingleHeader(context, ChallengeIdHeaderName, out challengeId)
            && TryReadSingleHeader(context, ChallengeKindHeaderName, out challengeKind);
    }

    private static bool TryReadChallengeProofQuery(
        HttpContext context,
        out string proofToken,
        out string challengeId,
        out string challengeKind)
    {
        proofToken = string.Empty;
        challengeId = string.Empty;
        challengeKind = string.Empty;
        return TryReadSingleQuery(context, ChallengeProofQueryName, out proofToken)
            && TryReadSingleQuery(context, ChallengeIdQueryName, out challengeId)
            && TryReadSingleQuery(context, ChallengeKindQueryName, out challengeKind);
    }

    private static bool TryReadSingleHeader(HttpContext context, string headerName, out string value)
    {
        value = string.Empty;
        if (!context.Request.Headers.TryGetValue(headerName, out var values) || values.Count != 1)
        {
            return false;
        }

        value = values[0]?.Trim() ?? string.Empty;
        return value.Length > 0;
    }

    private static bool TryReadSingleQuery(HttpContext context, string queryName, out string value)
    {
        value = string.Empty;
        if (!context.Request.Query.TryGetValue(queryName, out var values) || values.Count != 1)
        {
            return false;
        }

        value = values[0]?.Trim() ?? string.Empty;
        return value.Length > 0;
    }

    private static string CanonicalChallengeKind(string kind)
        => SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsed)
            ? SecurityChallengeContracts.ToWireName(parsed)
            : kind.Trim();

    private async ValueTask RecordRiskAsync(HttpContext context, string detail, string action, CancellationToken cancellationToken)
    {
        try
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                context,
                SecurityRiskReason.SecurityChallengeRejected,
                10,
                RiskSignalTtl,
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(action) ? RiskActionNames.NotificationSubscribe : action,
                detail), cancellationToken);
        }
        catch
        {
            // Notification stream admission must not depend on risk telemetry persistence.
        }
    }

    private static bool ContainsRequestedProtocol(string requestedProtocol)
    {
        ReadOnlySpan<char> remaining = requestedProtocol.AsSpan();
        while (!remaining.IsEmpty)
        {
            int comma = remaining.IndexOf(',');
            ReadOnlySpan<char> segment = comma >= 0 ? remaining[..comma] : remaining;
            if (segment.Trim().Equals(Protocol.AsSpan(), StringComparison.Ordinal))
            {
                return true;
            }

            if (comma < 0)
            {
                break;
            }

            remaining = remaining[(comma + 1)..];
        }

        return false;
    }

    internal static HashSet<string> BuildAllowedOrigins(IConfiguration configuration)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        AddOrigin(allowed, configuration["Seo:BaseUrl"]);
        AddOriginList(allowed, configuration["CORS_ALLOWED_HOSTS"]);
        AddOriginList(allowed, configuration["Fido2:Origins"]);
        foreach (IConfigurationSection child in configuration.GetSection("Fido2:Origins").GetChildren())
        {
            AddOrigin(allowed, child.Value);
        }

        return allowed;
    }

    internal static HashSet<string> BuildAllowedHosts(IConfiguration configuration, HashSet<string> allowedOrigins)
    {
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string origin in allowedOrigins)
        {
            if (Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri))
            {
                hosts.Add(uri.Host);
            }
        }

        string? configuredHosts = configuration["AllowedHosts"];
        if (!string.IsNullOrWhiteSpace(configuredHosts))
        {
            foreach (string host in configuredHosts.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (host == "*")
                {
                    continue;
                }

                hosts.Add(host);
            }
        }

        return hosts;
    }

    private static void AddOriginList(HashSet<string> allowed, string? origins)
    {
        if (string.IsNullOrWhiteSpace(origins))
        {
            return;
        }

        foreach (string origin in origins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            AddOrigin(allowed, origin);
        }
    }

    private static void AddOrigin(HashSet<string> allowed, string? origin)
    {
        if (string.IsNullOrWhiteSpace(origin) || !Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri))
        {
            return;
        }

        allowed.Add(NormalizeOrigin(uri));
    }

    private bool IsDevelopmentLocalhostOrigin(Uri origin)
        => environment.IsDevelopment()
            && IsLocalhost(origin.Host)
            && (origin.Scheme == Uri.UriSchemeHttp ||
                origin.Scheme == Uri.UriSchemeHttps ||
                origin.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase) ||
                origin.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase));

    private static bool IsProductionSafeOriginScheme(string scheme)
        => scheme == Uri.UriSchemeHttps || scheme.Equals("wss", StringComparison.OrdinalIgnoreCase);

    private static bool IsInternalProbe(HttpContext context)
    {
        if (context.Request.Headers.ContainsKey("Sec-Fetch-Site"))
        {
            return false;
        }

        string userAgent = context.Request.Headers.UserAgent.ToString();
        if (userAgent.Contains("Mozilla", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return context.Connection.RemoteIpAddress is null || System.Net.IPAddress.IsLoopback(context.Connection.RemoteIpAddress);
    }

    private static bool IsLocalhost(string host)
        => host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || host.Equals("::1", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeOrigin(Uri origin)
    {
        string scheme = origin.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)
            ? Uri.UriSchemeHttps
            : origin.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase)
                ? Uri.UriSchemeHttp
                : origin.Scheme.ToLowerInvariant();
        string port = origin.IsDefaultPort ? string.Empty : $":{origin.Port}";
        return $"{scheme}://{origin.IdnHost.ToLowerInvariant()}{port}";
    }
}

internal sealed record NotificationStreamOriginSnapshot(
    FrozenSet<string> AllowedOrigins,
    FrozenSet<string> AllowedHosts);

internal sealed class NotificationStreamOriginSnapshotProvider
{
    private readonly IConfiguration _configuration;
    private NotificationStreamOriginSnapshot _current;
    private IDisposable? _reloadRegistration;

    public NotificationStreamOriginSnapshotProvider(IConfiguration configuration)
    {
        _configuration = configuration;
        _current = BuildSnapshot(configuration);
        _reloadRegistration = ChangeToken.OnChange(configuration.GetReloadToken, Refresh);
    }

    public NotificationStreamOriginSnapshot Current => Volatile.Read(ref _current);

    private void Refresh()
    {
        Volatile.Write(ref _current, BuildSnapshot(_configuration));
    }

    private static NotificationStreamOriginSnapshot BuildSnapshot(IConfiguration configuration)
    {
        HashSet<string> origins = NotificationStreamHandshakeService.BuildAllowedOrigins(configuration);
        HashSet<string> hosts = NotificationStreamHandshakeService.BuildAllowedHosts(configuration, origins);
        return new NotificationStreamOriginSnapshot(
            origins.ToFrozenSet(StringComparer.OrdinalIgnoreCase),
            hosts.ToFrozenSet(StringComparer.OrdinalIgnoreCase));
    }
}
