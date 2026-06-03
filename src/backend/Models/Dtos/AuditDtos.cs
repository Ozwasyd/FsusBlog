namespace FsusBlog.Server.Models.Dtos;

public sealed record AuditLogQueryRequest(
    int Page = 1,
    int PageSize = 50,
    string? Source = null,
    string? Type = null,
    string? Actor = null,
    string? Action = null,
    string? TargetType = null,
    string? TargetId = null,
    string? Outcome = null,
    string? Severity = null,
    DateTime? FromUtc = null,
    DateTime? ToUtc = null);

public sealed record AuditLogListResponse(
    IReadOnlyList<AuditLogItemResponse> Items,
    int Total,
    int Page,
    int PageSize,
    AuditLogRuntimeResponse Runtime);

public sealed record AuditLogItemResponse(
    long Id,
    string Source,
    string Type,
    string Action,
    string Outcome,
    string Severity,
    bool IsHighValue,
    string? ActorType,
    string? ActorId,
    string? ActorRole,
    string? TargetType,
    string? TargetId,
    string? ReasonCode,
    DateTime OccurredAtUtc,
    string EventInfo,
    string? TraceId,
    string? RequestPath,
    string? RequestMethod,
    string? IpHash,
    string? UserAgentHash,
    string? SessionIdHash,
    string? DeviceFingerprintHash,
    string? ChainId,
    string? PrevHash,
    string? RecordHash,
    string? RecordMac);

public sealed record AuditLogDetailResponse(
    AuditLogItemResponse Item,
    string? ContextJson,
    bool TamperEvidenceValid);

public sealed record AuditLogSummaryResponse(
    int Total,
    IReadOnlyList<AuditFacetResponse> Sources,
    IReadOnlyList<AuditFacetResponse> Actions,
    IReadOnlyList<AuditFacetResponse> Outcomes,
    IReadOnlyList<AuditFacetResponse> Severities,
    AuditLogRuntimeResponse Runtime);

public sealed record AuditFacetResponse(string Value, int Count);

public sealed record AuditTamperVerifyResponse(
    long Id,
    bool Valid,
    string? RecordHash,
    string? RecordMac,
    string? ChainId);

public sealed record AuditLogRuntimeResponse(
    long QueuedCount,
    long DroppedCount,
    long WriteSuccessCount,
    long WriteFailureCount,
    long FallbackWriteCount,
    DateTime? LastWriteSuccessUtc,
    DateTime? LastWriteFailureUtc,
    DateTime? LastFallbackWriteUtc);
