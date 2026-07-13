using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Isolated migration-qualification bridge. The routes are absent unless the
/// application is explicitly running as Test with the qualification switch on.
/// They are never a production migration or deployment entry.
/// </summary>
public static class ReleaseSchemaQualificationEndpoints
{
    internal const string EnabledConfigurationKey = "SchemaMigration:QualificationEnabled";
    internal const string BridgePath = "/api/release-evidence/schema-bridge/write";
    internal const string ReadinessPath = "/api/release-evidence/schema-qualification/readiness";
    internal const string BridgeTable = "__fsus_schema_qualification_bridge";

    public static WebApplication MapReleaseSchemaQualificationEndpoints(this WebApplication app)
    {
        if (!IsEnabled(app.Environment.EnvironmentName, app.Configuration.GetValue<bool>(EnabledConfigurationKey)))
        {
            return app;
        }

        app.MapPost(BridgePath, WriteBridgeAsync)
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        app.MapGet(ReadinessPath, ReadQualificationReadinessAsync)
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        return app;
    }

    private static async Task<IResult> WriteBridgeAsync(
        HttpContext context,
        [FromBody] ReleaseSchemaBridgeWriteRequest request,
        [FromServices] ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        if (!TryNormalizeWrite(request, out string operationId, out int sequence))
        {
            return Results.BadRequest(new { code = "schema_qualification_write_invalid" });
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync($"""
            CREATE TABLE IF NOT EXISTS {QuoteIdentifier(BridgeTable)} (
                operation_id varchar(96) PRIMARY KEY,
                sequence integer NOT NULL,
                writer_release varchar(128) NOT NULL,
                writer_slot varchar(16) NOT NULL,
                updated_at_utc timestamp NOT NULL
            );

            INSERT INTO {QuoteIdentifier(BridgeTable)}(
                operation_id,
                sequence,
                writer_release,
                writer_slot,
                updated_at_utc
            )
            VALUES (
                @operation_id,
                @sequence,
                @writer_release,
                @writer_slot,
                @updated_at_utc
            )
            ON CONFLICT (operation_id) DO UPDATE
            SET sequence = EXCLUDED.sequence,
                writer_release = EXCLUDED.writer_release,
                writer_slot = EXCLUDED.writer_slot,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@operation_id", operationId),
            new SugarParameter("@sequence", sequence),
            new SugarParameter("@writer_release", ReleaseId()),
            new SugarParameter("@writer_slot", ReleaseSlot()),
            new SugarParameter("@updated_at_utc", DateTime.UtcNow)).ConfigureAwait(false);

        ApplyReleaseHeaders(context.Response);
        return Results.Json(new
        {
            bridgeWrite = true,
            operationId,
            sequence,
            releaseId = ReleaseId(),
            slot = ReleaseSlot()
        });
    }

    private static async Task<IResult> ReadQualificationReadinessAsync(
        HttpContext context,
        [FromServices] IOnlineSchemaMigrationCoordinator coordinator,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OnlineSchemaCompatibilityReport report = await coordinator
            .CheckAsync(ReleaseId(), cancellationToken)
            .ConfigureAwait(false);
        ApplyReleaseHeaders(context.Response);
        return Results.Json(
            new
            {
                status = report.Status,
                code = report.PublicErrorCode ?? "ok",
                schemaRelease = report.SchemaRelease,
                issues = report.Issues.Select(static issue => new
                {
                    code = issue.Code,
                    severity = issue.Severity.ToString().ToLowerInvariant(),
                    migrationId = issue.MigrationId
                })
            },
            statusCode: report.Ready
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable);
    }

    internal static bool IsEnabled(string environmentName, bool configured)
        => configured && string.Equals(environmentName, "Test", StringComparison.Ordinal);

    internal static bool TryNormalizeWrite(
        ReleaseSchemaBridgeWriteRequest? request,
        out string operationId,
        out int sequence)
    {
        operationId = request?.OperationId?.Trim() ?? string.Empty;
        sequence = request?.Sequence ?? 0;
        return operationId.Length is >= 3 and <= 96
            && operationId.All(static value => char.IsAsciiLetterOrDigit(value) || value is '-' or '_' or '.')
            && sequence is >= 1 and <= 1_000_000;
    }

    private static void ApplyReleaseHeaders(HttpResponse response)
    {
        response.Headers["X-Fsus-Release-Id"] = ReleaseId();
        response.Headers["X-Fsus-Release-Slot"] = ReleaseSlot();
        response.Headers.CacheControl = "no-store";
    }

    private static string ReleaseId()
        => Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID") ?? "qualification-unknown-release";

    private static string ReleaseSlot()
        => Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_SLOT") ?? "qualification-unknown-slot";

    private static string QuoteIdentifier(string value)
        => $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
}

public sealed record ReleaseSchemaBridgeWriteRequest(string? OperationId, int Sequence);
