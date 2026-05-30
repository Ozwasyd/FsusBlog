namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotWriteSource
{
    ServerSsrBackfill = 2
}

public static class PublicAotWriteSourceExtensions
{
    public static string ToHeaderValue(this PublicAotWriteSource source)
    {
        return source switch
        {
            PublicAotWriteSource.ServerSsrBackfill => "server-ssr",
            _ => "unknown"
        };
    }
}
