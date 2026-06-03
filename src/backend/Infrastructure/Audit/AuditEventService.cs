using System.Text.Json;
using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditEventService
{
    Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default);
    Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default);
}

public sealed record AuditEvent(
    string Source,
    string Type,
    string Action,
    string Outcome,
    string Severity,
    string EventInfo,
    string? ActorType = null,
    string? ActorId = null,
    string? ActorRole = null,
    string? TargetType = null,
    string? TargetId = null,
    string? ReasonCode = null,
    IReadOnlyDictionary<string, object?>? Context = null,
    bool IsHighValue = false,
    DateTime? OccurredAtUtc = null);

public sealed class AuditEventService(
    AuditLogChannel channel,
    IAuditLogStore store,
    IAuditFallbackWriter fallbackWriter,
    AuditLogRuntimeState runtimeState,
    IHttpContextAccessor httpContextAccessor,
    ILogger<AuditEventService> logger) : IAuditEventService
{
    private readonly AuditLogChannel _channel = channel;
    private readonly IAuditLogStore _store = store;
    private readonly IAuditFallbackWriter _fallbackWriter = fallbackWriter;
    private readonly AuditLogRuntimeState _runtimeState = runtimeState;
    private readonly IHttpContextAccessor _httpContextAccessor = httpContextAccessor;
    private readonly ILogger<AuditEventService> _logger = logger;

    public async Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        AuditRecord record = BuildRecord(auditEvent);
        if (record.RequiresDurableWrite)
        {
            await PersistCriticalAsync(record, cancellationToken);
            return;
        }

        if (!_channel.TryWrite(record))
        {
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning("audit-log degraded: structured event channel write failed. Action={Action} TargetType={TargetType} TargetId={TargetId}", record.Action, record.TargetType, record.TargetId);
        }
    }

    public Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        => PersistCriticalAsync(BuildRecord(auditEvent with { IsHighValue = true }), cancellationToken);

    private async Task PersistCriticalAsync(AuditRecord record, CancellationToken cancellationToken)
    {
        try
        {
            await _store.WriteBatchAsync([record], cancellationToken);
            _runtimeState.RecordWriteSuccess(1);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _runtimeState.RecordWriteFailure(1);
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogError(ex, "audit-log critical write failed; writing local fallback. Action={Action} TargetType={TargetType} TargetId={TargetId}", record.Action, record.TargetType, record.TargetId);
            await _fallbackWriter.WriteAsync(record, ex, cancellationToken);
        }
    }

    private AuditRecord BuildRecord(AuditEvent auditEvent)
    {
        RequestAuditContextSnapshot? request = _httpContextAccessor.HttpContext is { } context
            ? RequestAuditContextSnapshot.FromHttpContext(context)
            : null;

        Dictionary<string, object?> contextPayload = auditEvent.Context is null
            ? []
            : new Dictionary<string, object?>(auditEvent.Context, StringComparer.Ordinal);

        if (request is not null)
        {
            foreach ((string key, object? value) in request.ToProperties())
            {
                contextPayload.TryAdd(key, value);
            }
        }

        byte[]? payload = contextPayload.Count == 0
            ? null
            : PublicAotBinaryPayload.EncodeObjectFrame(contextPayload);
        string? contextJson = contextPayload.Count == 0
            ? null
            : JsonSerializer.Serialize(contextPayload);

        return new AuditRecord(
            auditEvent.Source,
            auditEvent.Type,
            (auditEvent.OccurredAtUtc ?? DateTime.UtcNow).ToUniversalTime(),
            auditEvent.EventInfo,
            payload,
            Action: auditEvent.Action,
            Outcome: auditEvent.Outcome,
            Severity: auditEvent.Severity,
            ActorType: auditEvent.ActorType ?? request?.ActorType ?? AuditActorTypeCatalog.System,
            ActorId: auditEvent.ActorId ?? request?.UserId,
            ActorRole: auditEvent.ActorRole ?? request?.UserRole,
            TargetType: auditEvent.TargetType,
            TargetId: auditEvent.TargetId,
            IsHighValue: auditEvent.IsHighValue,
            TraceId: request?.TraceId,
            RequestPath: request?.RequestPath,
            RequestMethod: request?.RequestMethod,
            IpHash: request?.IpHash,
            UserAgentHash: request?.UserAgentHash,
            SessionIdHash: request?.SessionIdHash,
            DeviceFingerprintHash: request?.DeviceFingerprintHash,
            ReasonCode: auditEvent.ReasonCode,
            ContextJson: contextJson);
    }
}
