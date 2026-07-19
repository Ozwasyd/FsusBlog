using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace FsusBlog.Server.Infrastructure.Observability;

public static class HttpTransportObservability
{
    public const string MeterName = "FsusBlog.HttpTransport";

    private static readonly Meter s_meter = new(MeterName, FsusObservability.ServiceVersion);
    private static readonly Counter<long> s_requestCounter = s_meter.CreateCounter<long>("fsus.http.transport.request.count");
    private static readonly Counter<long> s_http3StartupCounter = s_meter.CreateCounter<long>("fsus.http3.startup.count");

    public static void RecordRequest(string protocol, PathString path)
    {
        TagList tags = default;
        tags.Add("fsus.http.protocol", NormalizeProtocol(protocol));
        tags.Add("fsus.http.route_class", ClassifyRoute(path));
        s_requestCounter.Add(1, tags);
    }

    public static void RecordHttp3Startup(string status, IReadOnlyList<string> fallbackReasons)
    {
        TagList tags = default;
        tags.Add("fsus.http3.startup_status", status);
        tags.Add("fsus.http3.fallback_reason", fallbackReasons.Count == 0 ? "none" : fallbackReasons[0]);
        s_http3StartupCounter.Add(1, tags);
    }

    internal static string NormalizeProtocol(string protocol)
        => protocol switch
        {
            "HTTP/1.0" or "HTTP/1.1" => "http1",
            "HTTP/2" => "http2",
            "HTTP/3" => "http3",
            _ => "other"
        };

    internal static string ClassifyRoute(PathString path)
    {
        string value = path.Value ?? string.Empty;
        if (value.EndsWith(".wasm", StringComparison.OrdinalIgnoreCase))
        {
            return "wasm";
        }

        if (value.Contains("/search", StringComparison.OrdinalIgnoreCase))
        {
            return "search";
        }

        if (value.StartsWith("/api/notifications/stream", StringComparison.OrdinalIgnoreCase))
        {
            return "notification-stream";
        }

        if (value.Contains("/upload", StringComparison.OrdinalIgnoreCase))
        {
            return "upload";
        }

        if (value.StartsWith("/api/binary", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".aeds", StringComparison.OrdinalIgnoreCase))
        {
            return "aeds";
        }

        if (value.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase))
        {
            return "static";
        }

        return "public-aot";
    }
}
