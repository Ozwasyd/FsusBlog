namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotWriteSource
{
    AdminUpload = 1,
    ServerSsrBackfill = 2
}

public static class PublicAotWriteSourceExtensions
{
    public static string ToHeaderValue(this PublicAotWriteSource source)
    {
        return source switch
        {
            PublicAotWriteSource.AdminUpload => "admin-upload",
            PublicAotWriteSource.ServerSsrBackfill => "server-ssr",
            _ => "unknown"
        };
    }
}
