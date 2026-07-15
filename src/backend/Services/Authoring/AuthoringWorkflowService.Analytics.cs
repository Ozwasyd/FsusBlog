using System.Net;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using System.Globalization;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class AuthoringWorkflowService
{
    public async Task<AuthorAnalyticsResponse> GetAnalyticsAsync(CancellationToken cancellationToken = default)
    {
        AuthorArticleStatusCounts articleCounts = await LoadArticleStatusCountsAsync(cancellationToken).ConfigureAwait(false);
        AuthorReadRollup readRollup = await LoadAuthorReadRollupAsync(cancellationToken).ConfigureAwait(false);
        long aotMisses = await LoadAuthorAotRollupAsync(cancellationToken).ConfigureAwait(false);
        double aotHitRate = readRollup.TotalReads <= 0
            ? 0d
            : RoundingHelper.Round4(Math.Clamp((readRollup.TotalReads - aotMisses) / (double)readRollup.TotalReads, 0d, 1d));

        return new AuthorAnalyticsResponse(
            articleCounts.Published,
            articleCounts.Draft,
            articleCounts.Scheduled,
            articleCounts.Archived,
            RoundingHelper.RoundToInt(readRollup.TotalReads),
            articleCounts.Published,
            aotHitRate,
            readRollup.AverageDwellMs,
            readRollup.ReadingCompletionRate,
            [],
            [],
            [],
            await LoadAuthorRumRollupsAsync(cancellationToken).ConfigureAwait(false),
            await LoadAuthorMetricRollupsAsync("author_rum_page_type_stats", "page_type", cancellationToken).ConfigureAwait(false),
            await LoadAuthorMetricRollupsAsync("author_rum_aot_source_stats", "aot_source", cancellationToken).ConfigureAwait(false));
    }

    private async Task<AuthorArticleStatusCounts> LoadArticleStatusCountsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT
                SUM(CASE WHEN isdeleted = false AND status = @PublishedStatus THEN 1 ELSE 0 END)::integer AS published,
                SUM(CASE WHEN isdeleted = false AND status = @DraftStatus THEN 1 ELSE 0 END)::integer AS draft,
                SUM(CASE WHEN isdeleted = false AND status = @ScheduledStatus THEN 1 ELSE 0 END)::integer AS scheduled,
                SUM(CASE WHEN isdeleted = false AND status = @ArchivedStatus THEN 1 ELSE 0 END)::integer AS archived
            FROM article;
            """,
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@DraftStatus", (int)ArticleStatus.Draft),
            new SugarParameter("@ScheduledStatus", (int)ArticleStatus.Scheduled),
            new SugarParameter("@ArchivedStatus", (int)ArticleStatus.Archived));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new AuthorArticleStatusCounts(0, 0, 0, 0);
        }

        return new AuthorArticleStatusCounts(
            reader.IsNull("published") ? 0 : reader.ReadInt32("published"),
            reader.IsNull("draft") ? 0 : reader.ReadInt32("draft"),
            reader.IsNull("scheduled") ? 0 : reader.ReadInt32("scheduled"),
            reader.IsNull("archived") ? 0 : reader.ReadInt32("archived"));
    }

    private async Task<AuthorReadRollup> LoadAuthorReadRollupAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT
                COALESCE(SUM(total_reads), 0)::bigint AS total_reads,
                MAX(updated_at_utc) AS updated_at_utc
            FROM daily_read_stats;
            """);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new AuthorReadRollup(0, 0, 0);
        }

        long totalReads = reader.ReadInt64("total_reads");
        return new AuthorReadRollup(totalReads, 0, 0d);
    }

    private async Task<long> LoadAuthorAotRollupAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT COALESCE(SUM(event_count), 0)::bigint AS miss_count
            FROM author_aot_stats
            WHERE metric_kind = 'miss';
            """);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? reader.ReadInt64("miss_count")
            : 0;
    }

    private async Task<IReadOnlyList<AuthorAnalyticsMetricResponse>> LoadAuthorMetricRollupsAsync(string tableName, string labelColumn, CancellationToken cancellationToken)
    {
        string sql = $"""
            SELECT {labelColumn}, event_count
            FROM {tableName}
            WHERE event_count > 0
            ORDER BY event_count DESC, {labelColumn} ASC
            LIMIT 6;
            """;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql);
        return await ReadMetricRowsAsync(reader, cancellationToken).ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<AuthorRumMetricResponse>> LoadAuthorRumRollupsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT name, event_count, p75, average
            FROM author_rum_stats
            WHERE event_count > 0
            ORDER BY name ASC
            LIMIT 8;
            """);
        var rows = new List<AuthorRumMetricResponse>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new AuthorRumMetricResponse(
                reader.ReadString("name"),
                reader.ReadInt32("event_count"),
                reader.ReadDouble("p75"),
                reader.ReadDouble("average")));
        }

        return rows;
    }

    private static async Task<IReadOnlyList<AuthorAnalyticsMetricResponse>> ReadMetricRowsAsync(DbDataReader reader, CancellationToken cancellationToken)
    {
        var rows = new List<AuthorAnalyticsMetricResponse>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new AuthorAnalyticsMetricResponse(reader.ReadString("label"), reader.ReadInt32("event_count")));
        }

        return rows;
    }


    private static IReadOnlyList<string> ParseCommaList(string? value)
        => (value ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .ToArray();

    private static IReadOnlyList<AuthorAnalyticsMetricResponse> BuildRankedMetrics(IEnumerable<string?> values)
        => values
            .Select(static value => NormalizeAnalyticsLabel(value))
            .Where(static value => value is not null)
            .GroupBy(static value => value!, StringComparer.OrdinalIgnoreCase)
            .Select(static group => new AuthorAnalyticsMetricResponse(group.Key, group.Count()))
            .OrderByDescending(static item => item.Count)
            .ThenBy(static item => item.Label, StringComparer.Ordinal)
            .Take(6)
            .ToArray();

    private static IReadOnlyList<AuthorRumMetricResponse> BuildRumMetricSummaries(IEnumerable<RumMetricAuditContext> values)
        => values
            .Select(static value => new
            {
                value.Name,
                Value = SelectRumMetricValue(value)
            })
            .Where(static value => value.Value.HasValue)
            .GroupBy(static value => value.Name, StringComparer.Ordinal)
            .Select(static group =>
            {
                double average = RoundingHelper.Round2(group.Average(static item => item.Value!.Value));
                double[] sortedSamples = [.. group.Select(static item => item.Value!.Value).Order()];
                return new AuthorRumMetricResponse(
                    group.Key,
                    sortedSamples.Length,
                    Percentile(sortedSamples, 0.75d),
                    average);
            })
            .OrderBy(static item => item.Name, StringComparer.Ordinal)
            .Take(8)
            .ToArray();

    private static RumMetricAuditContext? TryReadRumMetric(FrontendRumMetric metric)
    {
        Dictionary<string, double>? metrics = JsonDecodeHelper.DeserializeOrNull<Dictionary<string, double>>(metric.MetricsJson);

        return new RumMetricAuditContext(
            metric.Name,
            metric.PageType,
            metric.AotSource,
            metric.Value,
            metrics ?? [],
            metric.OccurredAtUtc);
    }

    private static double? SelectRumMetricValue(RumMetricAuditContext context)
    {
        if (context.Value.HasValue)
        {
            return context.Value.Value;
        }

        return context.Metrics.TryGetValue("value", out double value)
            || context.Metrics.TryGetValue("durationMs", out value)
            || context.Metrics.TryGetValue("domInteractive", out value)
            ? value
            : null;
    }

    private static double Percentile(ReadOnlySpan<double> sortedSamples, double percentile)
    {
        if (sortedSamples.Length == 0)
        {
            return 0d;
        }

        int index = (int)Math.Ceiling(sortedSamples.Length * percentile) - 1;
        index = Math.Clamp(index, 0, sortedSamples.Length - 1);
        return RoundingHelper.Round2(sortedSamples[index]);
    }

    private static string? NormalizeAnalyticsRouteKey(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || value.StartsWith("search:", StringComparison.OrdinalIgnoreCase) || value.StartsWith("not-found:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return value switch
        {
            "home" => "/",
            "about" => "/about",
            "archive" => "/archive",
            "search" => "/search",
            var item when item.StartsWith("article:", StringComparison.OrdinalIgnoreCase) => $"/article/{item["article:".Length..]}",
            var item when item.StartsWith("category:", StringComparison.OrdinalIgnoreCase) => $"/category/{item["category:".Length..]}",
            var item when item.StartsWith("tag:", StringComparison.OrdinalIgnoreCase) => $"/tag/{item["tag:".Length..]}",
            var item when item.StartsWith("tag-name:", StringComparison.OrdinalIgnoreCase) => $"/tag/{item["tag-name:".Length..]}",
            _ => value
        };
    }

    private static string? TryExtractSearchKeyword(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || !value.StartsWith("search:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string keyword = value["search:".Length..].Trim();
        return keyword.Length == 0 ? null : keyword;
    }

    private static string? TryExtractNotFoundPath(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || !value.StartsWith("not-found:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string path = value["not-found:".Length..].Trim();
        return path.Length == 0 ? null : path;
    }

    private static string? NormalizeAnalyticsLabel(string? raw)
    {
        string value = (raw ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return null;
        }

        value = Regex.Replace(value, @"\s+", " ", RegexOptions.CultureInvariant);
        return value.Length > 96 ? value[..96] : value;
    }


    private sealed record AuthorArticleStatusCounts(
        int Published,
        int Draft,
        int Scheduled,
        int Archived);

    private sealed record AuthorReadRollup(
        long TotalReads,
        int AverageDwellMs,
        double ReadingCompletionRate);

}
