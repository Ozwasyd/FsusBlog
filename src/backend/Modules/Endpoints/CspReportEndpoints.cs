using System.Text.Json;

using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Modules.Endpoints;

public static class CspReportEndpoints
{
    internal const string ReportPath = "/api/security/csp-report";
    internal const int MaxReportBytes = 16 * 1024;

    public static IEndpointRouteBuilder MapCspReportEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(ReportPath, HandleAsync)
            .AllowAnonymous()
            .RequireRateLimiting("fixed_ip")
            .WithMetadata(new FsusRouteKindMetadata("security-report"));
        return app;
    }

    internal static async Task<IResult> HandleAsync(
        HttpContext context,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";

        if (!IsSupportedContentType(context.Request.ContentType))
        {
            return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);
        }
        if (context.Request.ContentLength is > MaxReportBytes)
        {
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        }

        byte[] payload;
        using (var buffer = new MemoryStream())
        {
            byte[] chunk = new byte[4096];
            while (true)
            {
                int read = await context.Request.Body.ReadAsync(chunk, cancellationToken);
                if (read == 0)
                {
                    break;
                }
                if (buffer.Length + read > MaxReportBytes)
                {
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                }
                buffer.Write(chunk, 0, read);
            }
            payload = buffer.ToArray();
        }

        if (!TrySummarize(payload, out CspReportSummary summary))
        {
            return Results.BadRequest();
        }

        ILogger logger = loggerFactory.CreateLogger("FsusBlog.CspReport");
        logger.LogWarning(
            "CSP violation reported: directive={Directive} disposition={Disposition} blockedKind={BlockedKind}",
            summary.Directive,
            summary.Disposition,
            summary.BlockedKind);
        return Results.NoContent();
    }

    internal static bool TrySummarize(ReadOnlySpan<byte> payload, out CspReportSummary summary)
    {
        summary = default;
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload.ToArray());
            JsonElement report = document.RootElement;
            if (report.ValueKind == JsonValueKind.Array)
            {
                if (report.GetArrayLength() == 0 || !report[0].TryGetProperty("body", out report))
                {
                    return false;
                }
            }
            else if (report.ValueKind == JsonValueKind.Object
                && report.TryGetProperty("csp-report", out JsonElement legacyReport))
            {
                report = legacyReport;
            }

            if (report.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            string directive = ReadString(report, "effective-directive")
                ?? ReadString(report, "effectiveDirective")
                ?? ReadString(report, "violated-directive")
                ?? "unknown";
            summary = new CspReportSummary(
                NormalizeToken(directive, "unknown"),
                NormalizeToken(ReadString(report, "disposition") ?? "enforce", "unknown"),
                ClassifyBlockedResource(ReadString(report, "blocked-uri") ?? ReadString(report, "blockedURL")));
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsSupportedContentType(string? value)
    {
        string mediaType = value?.Split(';', 2)[0].Trim() ?? string.Empty;
        return mediaType.Equals("application/csp-report", StringComparison.OrdinalIgnoreCase)
            || mediaType.Equals("application/reports+json", StringComparison.OrdinalIgnoreCase)
            || mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ReadString(JsonElement report, string name)
        => report.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string NormalizeToken(string value, string fallback)
    {
        string normalized = value.Trim().ToLowerInvariant();
        return normalized.Length is > 0 and <= 64 && normalized.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '-')
            ? normalized
            : fallback;
    }

    private static string ClassifyBlockedResource(string? value)
    {
        string normalized = value?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalized is "inline" or "eval" or "wasm-eval" or "self")
        {
            return normalized;
        }
        if (Uri.TryCreate(normalized, UriKind.Absolute, out Uri? uri))
        {
            return NormalizeToken(uri.Scheme, "absolute-uri");
        }
        return normalized.Length == 0 ? "unknown" : "relative-uri";
    }

    internal readonly record struct CspReportSummary(
        string Directive,
        string Disposition,
        string BlockedKind);
}
