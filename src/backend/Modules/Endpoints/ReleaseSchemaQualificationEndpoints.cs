using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Temporary refusal endpoints for retired migration qualification callers.
/// Test enablement cannot authorize a bridge write or compatibility admission.
/// </summary>
public static class ReleaseSchemaQualificationEndpoints
{
    internal const string EnabledConfigurationKey = "SchemaMigration:QualificationEnabled";
    internal const string BridgePath = "/api/release-evidence/schema-bridge/write";
    internal const string ReadinessPath = "/api/release-evidence/schema-qualification/readiness";

    /// <summary>Preserves protected Test-only refusal routes without migration services or database writes.</summary>
    public static WebApplication MapReleaseSchemaQualificationEndpoints(this WebApplication app)
    {
        if (!IsEnabled(app.Environment.EnvironmentName, app.Configuration.GetValue<bool>(EnabledConfigurationKey)))
        {
            return app;
        }

        app.MapPost(BridgePath, RejectBridgeWrite)
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        app.MapGet(ReadinessPath, RejectCompatibilityReadiness)
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        return app;
    }

    internal static IResult RejectBridgeWrite(HttpContext context)
    {
        ApplyReleaseHeaders(context.Response);
        return Results.Json(new
        {
            code = "schema_qualification_retired"
        }, statusCode: StatusCodes.Status410Gone);
    }

    internal static IResult RejectCompatibilityReadiness(HttpContext context)
    {
        ApplyReleaseHeaders(context.Response);
        return Results.Json(new
        {
            status = "failed",
            code = "schema_incompatible",
            reason = "schema_qualification_retired"
        }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    internal static bool IsEnabled(string environmentName, bool configured)
        => configured && string.Equals(environmentName, "Test", StringComparison.Ordinal);

    // Historical qualification input tests retain this bounded normalization;
    // neither retired route consumes it or performs an old-shape write.
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
        response.Headers["X-Fsus-Release-Id"] =
            Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID") ?? "qualification-unknown-release";
        response.Headers["X-Fsus-Release-Slot"] =
            Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_SLOT") ?? "qualification-unknown-slot";
        response.Headers.CacheControl = "no-store";
    }
}

/// <summary>Historical bridge input shape; it no longer authorizes a Server write.</summary>
public sealed record ReleaseSchemaBridgeWriteRequest(string? OperationId, int Sequence);
