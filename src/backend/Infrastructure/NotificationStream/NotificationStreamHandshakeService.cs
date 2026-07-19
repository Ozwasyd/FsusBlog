using System.Collections.Frozen;

using Microsoft.Extensions.Primitives;

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
    private NotificationStreamHandshakeResult(NotificationStreamHandshake? handshake, int statusCode, string? errorCode, string? preflightGrantToken)
    {
        Handshake = handshake;
        StatusCode = statusCode;
        ErrorCode = errorCode;
        PreflightGrantToken = preflightGrantToken;
    }

    public NotificationStreamHandshake? Handshake
    {
        get;
    }

    public int StatusCode
    {
        get;
    }

    public string? ErrorCode
    {
        get;
    }

    public string? PreflightGrantToken
    {
        get;
    }

    public bool IsSuccess => Handshake is not null;

    public static NotificationStreamHandshakeResult Success(NotificationStreamHandshake handshake, string? preflightGrantToken = null)
        => new(handshake, StatusCodes.Status200OK, null, preflightGrantToken);

    public static NotificationStreamHandshakeResult Failure(int statusCode, string errorCode)
        => new(null, statusCode, errorCode, null);
}

internal static class NotificationStreamHandshakeProtocol
{
    internal const string Value = "fsus-aeds.v2";
}

// Orchestrates the handshake use case. Validation, proof policy, and admission own
// their dependencies and never call back into this coordinator.
internal sealed class NotificationStreamHandshakeService(
    INotificationStreamHandshakeRequestValidator requestValidator,
    INotificationStreamRiskProofPolicy riskProofPolicy,
    INotificationStreamConnectionAdmission connectionAdmission) : INotificationStreamHandshakeService
{
    public async Task<NotificationStreamHandshakeResult> ValidateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool requireWebSocket = true)
    {
        NotificationStreamHandshakeRequestValidation request = requestValidator.Validate(context, requireWebSocket);
        if (!request.IsAllowed)
        {
            return NotificationStreamHandshakeResult.Failure(request.StatusCode, request.ErrorCode!);
        }

        NotificationStreamRiskProofResult proof = await riskProofPolicy.ValidateAsync(
            context,
            request.IsAuthenticated,
            consumeProof: requireWebSocket,
            cancellationToken);
        if (!proof.IsAllowed)
        {
            return NotificationStreamHandshakeResult.Failure(proof.StatusCode, proof.ErrorCode!);
        }

        return await connectionAdmission.AdmitAsync(
            context,
            request.IsAuthenticated,
            proof.PreflightGrantToken,
            cancellationToken);
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

    public NotificationStreamOriginSnapshot Current
    {
        get
        {
            long started = System.Diagnostics.Stopwatch.GetTimestamp();
            NotificationStreamOriginSnapshot snapshot = Volatile.Read(ref _current);
            Observability.FsusObservability.RecordNotificationStreamOriginCacheAccess(
                System.Diagnostics.Stopwatch.GetElapsedTime(started));
            return snapshot;
        }
    }

    private void Refresh()
    {
        Volatile.Write(ref _current, BuildSnapshot(_configuration));
    }

    private static NotificationStreamOriginSnapshot BuildSnapshot(IConfiguration configuration)
    {
        long started = System.Diagnostics.Stopwatch.GetTimestamp();
        HashSet<string> origins = NotificationStreamHandshakeRequestValidator.BuildAllowedOrigins(configuration);
        HashSet<string> hosts = NotificationStreamHandshakeRequestValidator.BuildAllowedHosts(configuration, origins);
        var snapshot = new NotificationStreamOriginSnapshot(
            origins.ToFrozenSet(StringComparer.OrdinalIgnoreCase),
            hosts.ToFrozenSet(StringComparer.OrdinalIgnoreCase));
        Observability.FsusObservability.RecordNotificationStreamOriginCacheRebuild(
            System.Diagnostics.Stopwatch.GetElapsedTime(started));
        return snapshot;
    }
}
