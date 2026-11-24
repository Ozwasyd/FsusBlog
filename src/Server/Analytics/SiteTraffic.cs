using System.Net.Sockets;

namespace FsusBlog.V2.Server.Analytics;

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

    internal void Observe(HttpContext context)
    {
        if (!Enabled || regions is null || !HttpMethods.IsGet(context.Request.Method) || context.Response.StatusCode != 200 ||
            context.RequestAborted.IsCancellationRequested || !PublicDocument(context.Request.Path) ||
            context.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) != true ||
            !SiteTrafficRegions.IsPublic(context.Connection.RemoteIpAddress)) return;
        var key = (DateOnly.FromDateTime(DateTime.UtcNow), regions.Resolve(context.Connection.RemoteIpAddress!));
        lock (gate)
        {
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
        var today = default(DateOnly);
        await SqlCommands.ReadAll(db, tx, ct, """
            select day,least(sum(views),9007199254740991)::bigint,(now() at time zone 'UTC')::date from public.site_traffic_daily
            where day>=(now() at time zone 'UTC')::date-29 and day<=(now() at time zone 'UTC')::date
            group by day order by day limit 30
            """, rows =>
        {
            today = rows.GetFieldValue<DateOnly>(2);
            days.Add(new(rows.GetFieldValue<DateOnly>(0).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), rows.GetInt64(1)));
        });
        var places = regions.Configured
            ? await SqlCommands.QueryList(db, tx, ct, """
                select region,least(sum(views),9007199254740991)::bigint total from public.site_traffic_daily
                where day>=(now() at time zone 'UTC')::date-29 and day<=(now() at time zone 'UTC')::date
                group by region order by total desc,region limit 30
                """, rows => new SiteTrafficRegion(rows.GetString(0), rows.GetInt64(1)))
            : [];
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
        await InstanceLease.RunProtected(database, lease, async (db, tx) =>
        {
            await SqlCommands.Execute(db, tx, ct, "delete from public.site_traffic_daily where day < (now() at time zone 'UTC')::date-29");
            if (batch.Length > 0)
                await SqlCommands.Execute(db, tx, ct, """
                    insert into public.site_traffic_daily as totals(day,region,views)
                    select day,region,views from unnest($1::date[],$2::text[],$3::bigint[]) incoming(day,region,views)
                    where day >= (now() at time zone 'UTC')::date-29 and day <= (now() at time zone 'UTC')::date
                    on conflict(day,region) do update
                    set views=least(totals.views::numeric+excluded.views,9223372036854775807)::bigint
                    """, batch.Select(item => item.Key.Day).ToArray(), batch.Select(item => item.Key.Region).ToArray(),
                    batch.Select(item => item.Value).ToArray());
        }, ct);
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

internal sealed class SiteTrafficRegions
{
    private static readonly IPNetwork[] ExcludedV4 = [.. new[] { "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
        "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
        "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3" }.Select(IPNetwork.Parse)];
    private static readonly IPNetwork GlobalV6 = IPNetwork.Parse("2000::/3");
    private static readonly IPNetwork[] ExcludedV6 = [IPNetwork.Parse("2001::/23"), IPNetwork.Parse("2001:db8::/32"), IPNetwork.Parse("2002::/16")];
    private readonly (IPNetwork Prefix, string Region)[] entries;
    internal bool Configured { get; }

    internal SiteTrafficRegions(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) { entries = []; return; }
        using var input = File.OpenRead(path);
        var bytes = new byte[1_048_577];
        var size = input.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
        if (size == bytes.Length) throw new InvalidOperationException("Site traffic region map exceeds 1 MiB.");
        var rows = JsonSerializer.Deserialize(bytes.AsSpan(0, size), TrafficRegionJsonContext.Default.TrafficRegionEntryArray)
            ?? throw new InvalidOperationException("Site traffic region map is empty.");
        if (rows.Length is 0 or > 4096) throw new InvalidOperationException("Site traffic region map must contain 1–4096 prefixes.");
        entries = rows.Select(row =>
        {
            if (row is null || !ValidRegion(row.Region) || !IPNetwork.TryParse(row.Cidr, out var prefix))
                throw new InvalidOperationException("Invalid site traffic region prefix or coarse region.");
            return (Prefix: prefix, row.Region);
        }).OrderByDescending(row => row.Prefix.PrefixLength).ToArray();
        if (entries.Select(row => row.Prefix).Distinct().Count() != entries.Length)
            throw new InvalidOperationException("Duplicate site traffic region prefix.");
        Configured = true;
    }

    internal static bool ValidRegion(string? value) => value is not null && value != "unknown" && FsusBlog.V2.Contracts.Wire.IsSiteTrafficRegion(value);

    internal static bool IsPublic(IPAddress? address)
    {
        if (address is null) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        return address.AddressFamily == AddressFamily.InterNetwork
            ? !ExcludedV4.Any(prefix => prefix.Contains(address))
            : address.AddressFamily == AddressFamily.InterNetworkV6 && GlobalV6.Contains(address) &&
              !ExcludedV6.Any(prefix => prefix.Contains(address));
    }

    internal string Resolve(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        foreach (var (prefix, region) in entries)
            if (prefix.Contains(address)) return region;
        return "unknown";
    }
}

internal sealed record TrafficRegionEntry(string Cidr, string Region);
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(TrafficRegionEntry[]))]
internal partial class TrafficRegionJsonContext : JsonSerializerContext;
