using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditFallbackWriter
{
    Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken);
}

public sealed class AuditFallbackWriter(IConfiguration configuration, AuditLogRuntimeState runtimeState) : IAuditFallbackWriter
{
    private readonly string _fallbackRoot = ResolveFallbackRoot(configuration);
    private readonly AuditLogRuntimeState _runtimeState = runtimeState;

    public async Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_fallbackRoot);
        string path = Path.Combine(_fallbackRoot, $"critical-audit-{DateTime.UtcNow:yyyyMMdd}.jsonl");
        string line = JsonSerializer.Serialize(new
        {
            fallbackAtUtc = DateTime.UtcNow,
            failure = reason.GetType().FullName,
            reason.Message,
            record.Source,
            record.Type,
            record.Action,
            record.Outcome,
            record.Severity,
            record.ActorType,
            record.ActorId,
            record.ActorRole,
            record.TargetType,
            record.TargetId,
            record.IsHighValue,
            record.TraceId,
            record.RequestPath,
            record.RequestMethod,
            record.IpHash,
            record.UserAgentHash,
            record.SessionIdHash,
            record.DeviceFingerprintHash,
            record.ReasonCode,
            record.EventInfo,
            record.ContextJson,
            record.OccurredAtUtc
        });

        await File.AppendAllTextAsync(path, line + Environment.NewLine, cancellationToken);
        _runtimeState.RecordFallbackWrite(1);
    }

    private static string ResolveFallbackRoot(IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");

        return Path.Combine(dataRoot, "audit-fallback");
    }
}
