using System.Buffers;
using System.Text;
using System.Text.Json;

using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditFallbackWriter
{
    Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken);
    Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken);
}

public sealed class AuditFallbackWriter : IAuditFallbackWriter
{
    private const int WriteBufferSize = 81920;
    private static readonly byte[] s_newLineBytes = Encoding.UTF8.GetBytes(Environment.NewLine);

    private readonly string _fallbackPathPrefix;
    private readonly AuditLogRuntimeState _runtimeState;

    private readonly AuditRetentionPayloadProtector? _retentionProtector;

    public AuditFallbackWriter(
        IConfiguration configuration,
        AuditLogRuntimeState runtimeState,
        AuditRetentionPayloadProtector? retentionProtector = null)
    {
        string fallbackRoot = ResolveFallbackRoot(configuration);
        Directory.CreateDirectory(fallbackRoot);
        _fallbackPathPrefix = Path.Combine(fallbackRoot, "critical-audit-");
        _runtimeState = runtimeState;
        _retentionProtector = retentionProtector;
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

        foreach (AuditRecord sourceRecord in records)
        {
            _ = AuditRetentionCatalog.GetRequired(sourceRecord.Action);
            AuditRecord record = _retentionProtector is null
                ? sourceRecord
                : await _retentionProtector.ProtectAsync(sourceRecord, cancellationToken).ConfigureAwait(false);
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
                    ContextJson = record.ContextJson ?? AuditContextJsonSerializer.Serialize(record.ContextPayload),
                    RetentionEnvelopeBase64Url = record.ContextPayload is { Length: > 0 }
                        ? WebEncoders.Base64UrlEncode(record.ContextPayload)
                        : null,
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
        s_newLineBytes.CopyTo(buffer.GetSpan(s_newLineBytes.Length));
        buffer.Advance(s_newLineBytes.Length);
    }
}
