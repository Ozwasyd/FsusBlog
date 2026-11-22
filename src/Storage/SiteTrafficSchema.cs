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
    private const string SiteTrafficRelation = "public.site_traffic_daily";
}
