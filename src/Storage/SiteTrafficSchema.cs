namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SiteTrafficShape = Table(
        "site_traffic_daily day:date region:text views:int8",
        "p day,region",
        "c day isfinite(day)",
        "c region region~'^([A-Z]{2}(-[A-Z0-9]{1,3})?|unknown)$'::text",
        "c views views>0");

    private const string SiteTrafficRelation = "public.site_traffic_daily";
}
