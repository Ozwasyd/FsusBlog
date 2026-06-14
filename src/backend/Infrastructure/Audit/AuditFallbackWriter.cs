using System.Buffers;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditFallbackWriter
{
    Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken);
    Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken);
}

public sealed class AuditFallbackWriter : IAuditFallbackWriter
{
    private const int WriteBufferSize = 81920;
    private static readonly byte[] NewLineBytes = Encoding.UTF8.GetBytes(Environment.NewLine);

    private readonly string _fallbackPathPrefix;
    private readonly AuditLogRuntimeState _runtimeState;

    public AuditFallbackWriter(IConfiguration configuration, AuditLogRuntimeState runtimeState)
    {
        string fallbackRoot = ResolveFallbackRoot(configuration);
        Directory.CreateDirectory(fallbackRoot);
        _fallbackPathPrefix = Path.Combine(fallbackRoot, "critical-audit-");
        _runtimeState = runtimeState;
    }

    public async Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
        => await WriteBatchAsync([record], reason, cancellationToken);

    public async Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken)
    {
        if (records.Count == 0)
        {
            return;
        }

        DateTime fallbackAtUtc = DateTime.UtcNow;
        string path = $"{_fallbackPathPrefix}{fallbackAtUtc:yyyyMMdd}.jsonl";
        var buffer = new ArrayBufferWriter<byte>(Math.Min(records.Count * 1024, WriteBufferSize));

        foreach (AuditRecord record in records)
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                JsonSerializer.Serialize(writer, new
                {
                    fallbackAtUtc,
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
            }
            WriteNewLine(buffer);
        }

        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Append,
            Access = FileAccess.Write,
            Share = FileShare.Read,
            BufferSize = WriteBufferSize,
            Options = FileOptions.Asynchronous
        });

        await stream.WriteAsync(buffer.WrittenMemory, cancellationToken);
        _runtimeState.RecordFallbackWrite(records.Count);
    }

    private static string ResolveFallbackRoot(IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");

        return Path.Combine(dataRoot, "audit-fallback");
    }

    private static void WriteNewLine(ArrayBufferWriter<byte> buffer)
    {
        NewLineBytes.CopyTo(buffer.GetSpan(NewLineBytes.Length));
        buffer.Advance(NewLineBytes.Length);
    }
}
