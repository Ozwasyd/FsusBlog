using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICacheTelemetry
{
    void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed);
}

public sealed class CacheTelemetry : ICacheTelemetry
{
    public void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed)
        => FsusObservability.RecordCacheOperation(operation, policy, layer, outcome, elapsed);
}
