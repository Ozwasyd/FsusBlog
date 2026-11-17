using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SiteTrafficColumns = ["site_traffic_daily day:date region:text views:int8"];
    private static readonly string[] SiteTrafficConstraints =
    [
        "site_traffic_daily p day,region",
        "site_traffic_daily c day isfinite(day)",
        "site_traffic_daily c region region~'^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'::text",
        "site_traffic_daily c views views>0"
    ];
    internal static Task<bool> HasSiteTrafficAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, "public.site_traffic_daily", ct);
}
