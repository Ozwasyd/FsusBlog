using System.Globalization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Audit;

public enum AuditDisclosureMode
{
    PiiRedacted,
    Investigation
}

public sealed class AuditQueryService(
    ISqlSugarClient db,
    AuditLogRuntimeState runtimeState,
    IConfiguration configuration)
{
    private readonly ISqlSugarClient _db = db;
    private readonly AuditLogRuntimeState _runtimeState = runtimeState;
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    public async Task<AuditLogListResponse> ListAsync(
        AuditLogQueryRequest request,
        CancellationToken cancellationToken,
        AuditDisclosureMode disclosureMode = AuditDisclosureMode.PiiRedacted)
    {
        int page = Math.Max(request.Page, 1);
        int pageSize = Math.Clamp(request.PageSize, 1, 200);
        Task<int> totalTask = QueryWithNewClientAsync(queryDb =>
            ApplyFilters(queryDb.Queryable<AuditLog>(), request)
                .CountAsync(cancellationToken));
        Task<List<AuditLog>> rowsTask = QueryWithNewClientAsync(queryDb =>
            ApplyFilters(queryDb.Queryable<AuditLog>(), request)
                .OrderByDescending(static it => it.OccurredAtUtc)
                .Skip((page - 1) * pageSize)
                .Take(pageSize)
                .ToListAsync(cancellationToken));
        int total = await totalTask;
        List<AuditLog> rows = await rowsTask;

        return new AuditLogListResponse(
            [.. rows.Select(row => ToItemResponse(row, disclosureMode))],
            total,
            page,
            pageSize,
            ToRuntimeResponse(_runtimeState.Snapshot()));
    }

    public async Task<AuditLogDetailResponse?> GetAsync(
        long id,
        CancellationToken cancellationToken,
        AuditDisclosureMode disclosureMode = AuditDisclosureMode.PiiRedacted)
    {
        AuditLog? row = await _db.Queryable<AuditLog>()
            .Where(it => it.Id == id)
            .FirstAsync(cancellationToken);

        return row is null
            ? null
            : new AuditLogDetailResponse(ToItemResponse(row, disclosureMode), row.ContextJson, await VerifyWithChainAsync(row, cancellationToken));
    }

    public async Task<AuditTamperVerifyResponse?> VerifyAsync(long id, CancellationToken cancellationToken)
    {
        AuditLog? row = await _db.Queryable<AuditLog>()
            .Where(it => it.Id == id)
            .FirstAsync(cancellationToken);

        return row is null
            ? null
            : new AuditTamperVerifyResponse(row.Id.ToString(CultureInfo.InvariantCulture), await VerifyWithChainAsync(row, cancellationToken), row.RecordHash, row.RecordMac, row.ChainId);
    }

    public async Task<AuditLogSummaryResponse> GetSummaryAsync(AuditLogQueryRequest request, CancellationToken cancellationToken)
    {
        Task<int> totalTask = QueryWithNewClientAsync(queryDb =>
            ApplyFilters(queryDb.Queryable<AuditLog>(), request).CountAsync(cancellationToken));
        Task<IReadOnlyList<AuditFacetResponse>> sourceTask = QueryWithNewClientAsync(queryDb => BuildSourceFacetAsync(queryDb, request, cancellationToken));
        Task<IReadOnlyList<AuditFacetResponse>> actionTask = QueryWithNewClientAsync(queryDb => BuildActionFacetAsync(queryDb, request, cancellationToken));
        Task<IReadOnlyList<AuditFacetResponse>> outcomeTask = QueryWithNewClientAsync(queryDb => BuildOutcomeFacetAsync(queryDb, request, cancellationToken));
        Task<IReadOnlyList<AuditFacetResponse>> severityTask = QueryWithNewClientAsync(queryDb => BuildSeverityFacetAsync(queryDb, request, cancellationToken));
        int total = await totalTask;
        IReadOnlyList<AuditFacetResponse> source = await sourceTask;
        IReadOnlyList<AuditFacetResponse> action = await actionTask;
        IReadOnlyList<AuditFacetResponse> outcome = await outcomeTask;
        IReadOnlyList<AuditFacetResponse> severity = await severityTask;

        return new AuditLogSummaryResponse(
            total,
            source,
            action,
            outcome,
            severity,
            ToRuntimeResponse(_runtimeState.Snapshot()));
    }

    private ISugarQueryable<AuditLog> ApplyFilters(ISugarQueryable<AuditLog> query, AuditLogQueryRequest request)
    {
        string? source = NormalizeFilter(request.Source);
        string? type = NormalizeFilter(request.Type);
        string? actor = NormalizeFilter(request.Actor);
        string? action = NormalizeFilter(request.Action);
        string? targetType = NormalizeFilter(request.TargetType);
        string? targetId = NormalizeFilter(request.TargetId);
        string? outcome = NormalizeFilter(request.Outcome);
        string? severity = NormalizeFilter(request.Severity);
        DateTime? fromUtc = request.FromUtc?.ToUniversalTime();
        DateTime? toUtc = request.ToUtc?.ToUniversalTime();

        query = query.WhereIF(source is not null, it => it.Source == source);
        query = query.WhereIF(type is not null, it => it.Type == type);
        query = query.WhereIF(actor is not null, it => it.ActorId == actor || it.ActorRole == actor || it.ActorType == actor);
        query = query.WhereIF(action is not null, it => it.Action == action);
        query = query.WhereIF(targetType is not null, it => it.TargetType == targetType);
        query = query.WhereIF(targetId is not null, it => it.TargetId == targetId);
        query = query.WhereIF(outcome is not null, it => it.Outcome == outcome);
        query = query.WhereIF(severity is not null, it => it.Severity == severity);
        query = query.WhereIF(fromUtc.HasValue, it => it.OccurredAtUtc >= fromUtc!.Value);
        query = query.WhereIF(toUtc.HasValue, it => it.OccurredAtUtc <= toUtc!.Value);
        return query;
    }

    private async Task<IReadOnlyList<AuditFacetResponse>> BuildSourceFacetAsync(ISqlSugarClient queryDb, AuditLogQueryRequest request, CancellationToken cancellationToken)
        => [.. (await ApplyFilters(queryDb.Queryable<AuditLog>(), request)
            .GroupBy(static it => it.Source)
            .Select(static it => new AuditFacetRow { Value = it.Source, Count = SqlFunc.AggregateCount(it.Id) })
            .MergeTable()
            .OrderByDescending(static it => it.Count)
            .Take(12)
            .ToListAsync(cancellationToken))
            .Select(static it => new AuditFacetResponse(it.Value, it.Count))];

    private async Task<IReadOnlyList<AuditFacetResponse>> BuildActionFacetAsync(ISqlSugarClient queryDb, AuditLogQueryRequest request, CancellationToken cancellationToken)
        => [.. (await ApplyFilters(queryDb.Queryable<AuditLog>(), request)
            .GroupBy(static it => it.Action)
            .Select(static it => new AuditFacetRow { Value = it.Action, Count = SqlFunc.AggregateCount(it.Id) })
            .MergeTable()
            .OrderByDescending(static it => it.Count)
            .Take(12)
            .ToListAsync(cancellationToken))
            .Select(static it => new AuditFacetResponse(it.Value, it.Count))];

    private async Task<IReadOnlyList<AuditFacetResponse>> BuildOutcomeFacetAsync(ISqlSugarClient queryDb, AuditLogQueryRequest request, CancellationToken cancellationToken)
        => [.. (await ApplyFilters(queryDb.Queryable<AuditLog>(), request)
            .GroupBy(static it => it.Outcome)
            .Select(static it => new AuditFacetRow { Value = it.Outcome, Count = SqlFunc.AggregateCount(it.Id) })
            .MergeTable()
            .OrderByDescending(static it => it.Count)
            .Take(12)
            .ToListAsync(cancellationToken))
            .Select(static it => new AuditFacetResponse(it.Value, it.Count))];

    private async Task<IReadOnlyList<AuditFacetResponse>> BuildSeverityFacetAsync(ISqlSugarClient queryDb, AuditLogQueryRequest request, CancellationToken cancellationToken)
        => [.. (await ApplyFilters(queryDb.Queryable<AuditLog>(), request)
            .GroupBy(static it => it.Severity)
            .Select(static it => new AuditFacetRow { Value = it.Severity, Count = SqlFunc.AggregateCount(it.Id) })
            .MergeTable()
            .OrderByDescending(static it => it.Count)
            .Take(12)
            .ToListAsync(cancellationToken))
            .Select(static it => new AuditFacetResponse(it.Value, it.Count))];

    internal static AuditLogItemResponse ToItemResponse(AuditLog row, AuditDisclosureMode disclosureMode)
    {
        AuditLogPublicItemResponse publicItem = ToPublicItemResponse(row);
        AuditLogInvestigationFieldsResponse investigation = ToInvestigationFieldsResponse(row);
        bool revealSensitive = disclosureMode == AuditDisclosureMode.Investigation;
        string piiMode = revealSensitive ? "investigation" : "pii-redacted";

        return new AuditLogItemResponse(
            publicItem.Id,
            publicItem.Source,
            publicItem.Type,
            publicItem.Action,
            publicItem.Outcome,
            publicItem.Severity,
            publicItem.IsHighValue,
            publicItem.ActorType,
            publicItem.ActorId,
            publicItem.ActorRole,
            publicItem.TargetType,
            publicItem.TargetId,
            publicItem.ReasonCode,
            publicItem.OccurredAtUtc,
            publicItem.EventInfo,
            publicItem.TraceId,
            publicItem.RequestPath,
            publicItem.RequestMethod,
            revealSensitive ? investigation.IpHash : RedactSensitiveHash(investigation.IpHash),
            revealSensitive ? investigation.UserAgentHash : RedactSensitiveHash(investigation.UserAgentHash),
            revealSensitive ? investigation.SessionIdHash : RedactSensitiveHash(investigation.SessionIdHash),
            revealSensitive ? investigation.DeviceFingerprintHash : RedactSensitiveHash(investigation.DeviceFingerprintHash),
            publicItem.ChainId,
            publicItem.PrevHash,
            publicItem.RecordHash,
            publicItem.RecordMac,
            piiMode);
    }

    private static AuditLogPublicItemResponse ToPublicItemResponse(AuditLog row)
        => new(
            row.Id.ToString(CultureInfo.InvariantCulture),
            row.Source,
            row.Type,
            row.Action,
            row.Outcome,
            row.Severity,
            row.IsHighValue,
            row.ActorType,
            row.ActorId,
            row.ActorRole,
            row.TargetType,
            row.TargetId,
            row.ReasonCode,
            row.OccurredAtUtc,
            row.EventInfo,
            row.TraceId,
            row.RequestPath,
            row.RequestMethod,
            row.ChainId,
            row.PrevHash,
            row.RecordHash,
            row.RecordMac);

    private static AuditLogInvestigationFieldsResponse ToInvestigationFieldsResponse(AuditLog row)
        => new(row.IpHash, row.UserAgentHash, row.SessionIdHash, row.DeviceFingerprintHash);

    private static string? RedactSensitiveHash(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : "pii-redacted";

    private static AuditLogRuntimeResponse ToRuntimeResponse(AuditLogRuntimeSnapshot snapshot)
        => new(
            snapshot.QueuedCount,
            snapshot.DroppedCount,
            snapshot.WriteSuccessCount,
            snapshot.WriteFailureCount,
            snapshot.FallbackWriteCount,
            snapshot.LastWriteSuccessUtc,
            snapshot.LastWriteFailureUtc,
            snapshot.LastFallbackWriteUtc);

    private async Task<bool> VerifyWithChainAsync(AuditLog row, CancellationToken cancellationToken)
    {
        if (!AuditTamperEvidence.Verify(row, _tamperKey))
        {
            return false;
        }

        string? expectedPrevHash = await ResolvePreviousHashAsync(row, cancellationToken);
        return string.IsNullOrWhiteSpace(row.PrevHash)
            ? expectedPrevHash is null
            : AuditTamperEvidence.FixedTimeEqualsHexSha256(row.PrevHash, expectedPrevHash);
    }

    private async Task<string?> ResolvePreviousHashAsync(AuditLog row, CancellationToken cancellationToken)
    {
        if (row.Id <= 0 || string.IsNullOrWhiteSpace(row.ChainId))
        {
            return null;
        }

        return await _db.Queryable<AuditLog>()
            .Where(it => it.ChainId == row.ChainId && it.Id < row.Id && it.RecordHash != null)
            .OrderByDescending(it => it.Id)
            .Select(it => it.RecordHash)
            .FirstAsync(cancellationToken);
    }

    private static string? NormalizeFilter(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private async Task<T> QueryWithNewClientAsync<T>(Func<ISqlSugarClient, Task<T>> query)
    {
        using SqlSugarClient queryDb = _db.CopyNew();
        return await query(queryDb);
    }

    private sealed class AuditFacetRow
    {
        public string Value { get; set; } = string.Empty;
        public int Count { get; set; }
    }
}
