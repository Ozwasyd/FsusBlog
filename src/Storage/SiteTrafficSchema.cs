namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SiteTrafficShape = new(
        Columns: ["site_traffic_daily day:date region:text views:int8"],
        Constraints: [
            "site_traffic_daily p day,region",
            "site_traffic_daily c day isfinite(day)",
            "site_traffic_daily c region region~'^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'::text",
            "site_traffic_daily c views views>0"
        ]);

    private const string SiteTrafficRelation = "public.site_traffic_daily";
}
