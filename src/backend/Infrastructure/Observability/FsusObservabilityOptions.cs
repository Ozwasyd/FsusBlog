namespace FsusBlog.Server.Infrastructure.Observability;

public sealed class FsusObservabilityOptions
{
    public bool Enabled { get; set; } = true;
    public bool ExporterEnabled
    {
        get; set;
    }
    public string ServiceName { get; set; } = FsusObservability.DefaultServiceName;
    public string ServiceVersion { get; set; } = FsusObservability.ServiceVersion;
    public string? OtlpEndpoint
    {
        get; set;
    }
    public int HttpMetricsSampleRate { get; set; } = 1;
    public int SlowRequestThresholdMilliseconds { get; set; } = 500;
}
