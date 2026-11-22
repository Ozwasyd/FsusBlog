using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Analytics;

// Counts requests, not people. Only day/region totals enter memory or PostgreSQL.
internal sealed class SiteTraffic : BackgroundService
{
    internal const string EnabledSetting = "FSUSBLOG_SITE_TRAFFIC";
    internal const string RegionsSetting = "FSUSBLOG_SITE_TRAFFIC_REGIONS";
    private const int PendingLimit = 8192;
    private readonly NpgsqlDataSource database;
    private readonly InstanceLease lease;
    private readonly ILogger<SiteTraffic> log;
    private readonly SiteTrafficRegions? regions;
    private readonly object gate = new();
    private readonly Dictionary<(DateOnly Day, string Region), long> pending = [];
    private DateOnly? pruned;
    internal bool Enabled { get; }

    public SiteTraffic(SiteCapabilities capabilities, NpgsqlDataSource database, InstanceLease lease, ILogger<SiteTraffic> log)
    {
        this.database = database;
        this.lease = lease;
        this.log = log;
        Enabled = capabilities.SiteTraffic;
        if (!Enabled) return;
        try { regions = new SiteTrafficRegions(capabilities.TrafficRegionsPath); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or ArgumentException)
        { log.LogWarning("Site traffic offline region configuration is unavailable; collection is suspended."); }
    }

    // Invoke only after the canonical public-origin middleware has admitted the request.
    internal void Observe(HttpContext context)
    {
        if (!Enabled || regions is null || !HttpMethods.IsGet(context.Request.Method) || context.Response.StatusCode != 200 ||
            context.RequestAborted.IsCancellationRequested || !PublicDocument(context.Request.Path) ||
            context.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) != true ||
            !SiteTrafficRegions.IsPublic(context.Connection.RemoteIpAddress)) return;
        var day = DateOnly.FromDateTime(DateTime.UtcNow);
        var region = regions.Resolve(context.Connection.RemoteIpAddress!);
        lock (gate)
        {
            var key = (day, region);
            if (pending.TryGetValue(key, out var count)) pending[key] = count == long.MaxValue ? count : count + 1;
            else if (pending.Count < PendingLimit) pending.Add(key, 1);
        }
    }

    internal static bool PublicDocument(PathString path)
    {
        var value = path.Value?.TrimEnd('/');
        if (value is "" or "/archive" or "/search" or "/about" or "/privacy" or "/guidelines" or "/copyright") return true;
        if (value is null) return false;
        var pieces = value.Split('/');
        return pieces.Length == 3 && pieces[0].Length == 0 && pieces[1] is "article" or "category" or "tag" &&
            int.TryParse(pieces[2], NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0;
    }

    internal async Task<AdminSiteTraffic> ReadAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!Enabled) return new(false, false, [], []);
        if (regions is null) throw new InvalidOperationException("Site traffic region configuration is unavailable.");
        var days = new List<SiteTrafficDay>();
        var places = new List<SiteTrafficRegion>();
        var today = default(DateOnly);
        await using (var query = SqlCommands.Create(db, tx, """
            select day,least(sum(views),9007199254740991)::bigint,(now() at time zone 'UTC')::date from public.site_traffic_daily
            where day>=(now() at time zone 'UTC')::date-29 and day<=(now() at time zone 'UTC')::date
            group by day order by day limit 30
            """))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
            {
                today = rows.GetFieldValue<DateOnly>(2);
                days.Add(new(rows.GetFieldValue<DateOnly>(0).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), rows.GetInt64(1)));
            }
        if (regions.Configured)
        {
            await using (var query = SqlCommands.Create(db, tx, """
                select region,least(sum(views),9007199254740991)::bigint total from public.site_traffic_daily
                where day>=(now() at time zone 'UTC')::date-29 and day<=(now() at time zone 'UTC')::date
                group by region order by total desc,region limit 30
                """))
            await using (var rows = await query.ExecuteReaderAsync(ct))
                while (await rows.ReadAsync(ct)) places.Add(new(rows.GetString(0), rows.GetInt64(1)));
        }
        if (days.Count > 0)
        {
            var byDate = days.ToDictionary(day => day.Date, day => day.Views);
            days = Enumerable.Range(-29, 30).Select(offset =>
            {
                var date = today.AddDays(offset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                return new SiteTrafficDay(date, byDate.GetValueOrDefault(date));
            }).ToList();
        }
        return new(true, regions.Configured, days, places);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Enabled || regions is null) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        do
        {
            try { await Flush(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { log.LogWarning("Site traffic persistence is unavailable; bounded aggregate counts remain pending."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task Flush(CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        KeyValuePair<(DateOnly Day, string Region), long>[] batch;
        lock (gate)
        {
            foreach (var key in pending.Keys.Where(key => key.Day < today.AddDays(-29)).ToArray()) pending.Remove(key);
            batch = pending.ToArray();
        }
        if (batch.Length == 0 && pruned == today) return;
        await using var db = await database.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await SqlCommands.Execute(db, tx, ct, "delete from public.site_traffic_daily where day < (now() at time zone 'UTC')::date-29");
        if (batch.Length > 0)
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.site_traffic_daily as totals(day,region,views)
                select day,region,views from unnest($1::date[],$2::text[],$3::bigint[]) incoming(day,region,views)
                where day >= (now() at time zone 'UTC')::date-29 and day <= (now() at time zone 'UTC')::date
                on conflict(day,region) do update
                set views=least(totals.views::numeric+excluded.views,9223372036854775807)::bigint
                """, batch.Select(item => item.Key.Day).ToArray(), batch.Select(item => item.Key.Region).ToArray(), batch.Select(item => item.Value).ToArray());
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
        lock (gate)
            foreach (var item in batch)
                if (pending.TryGetValue(item.Key, out var current))
                {
                    if (current <= item.Value) pending.Remove(item.Key);
                    else pending[item.Key] = current - item.Value;
                }
        pruned = today;
    }
}
