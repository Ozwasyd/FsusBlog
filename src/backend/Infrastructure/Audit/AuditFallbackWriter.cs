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

public interface IAuditFallbackReplayReader
{
    Task ReplayAsync(
        Func<IReadOnlyList<AuditRecord>, CancellationToken, Task> persist,
        CancellationToken cancellationToken);
}

public sealed class AuditFallbackWriter : IAuditFallbackWriter, IAuditFallbackReplayReader
{
    private const int WriteBufferSize = 81920;
    private static readonly byte[] s_newLineBytes = Encoding.UTF8.GetBytes(Environment.NewLine);

    private readonly string _fallbackPathPrefix;
    private readonly string _fallbackRoot;
    private readonly AuditLogRuntimeState _runtimeState;

    private readonly AuditRetentionPayloadProtector? _retentionProtector;

    public AuditFallbackWriter(
        IConfiguration configuration,
        AuditLogRuntimeState runtimeState,
        AuditRetentionPayloadProtector? retentionProtector = null)
    {
        string fallbackRoot = ResolveFallbackRoot(configuration);
        Directory.CreateDirectory(fallbackRoot);
        _fallbackRoot = fallbackRoot;
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
                    record.ChainId,
                    record.PrevHash,
                    record.RecordHash,
                    record.RecordMac,
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

    public async Task ReplayAsync(
        Func<IReadOnlyList<AuditRecord>, CancellationToken, Task> persist,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(persist);
        string replayRoot = Path.Combine(_fallbackRoot, "replayed");
        foreach (string path in Directory.EnumerateFiles(_fallbackRoot, "critical-audit-*.jsonl", SearchOption.TopDirectoryOnly)
                     .OrderBy(static item => item, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();

            string[] lines = await File.ReadAllLinesAsync(path, cancellationToken).ConfigureAwait(false);
            var records = new List<AuditRecord>(lines.Length);
            foreach (string line in lines)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                records.Add(ParseRecord(line));
            }

            if (records.Count == 0)
            {
                MoveToReplayArchive(path, replayRoot);
                continue;
            }

            await persist(records, cancellationToken).ConfigureAwait(false);
            MoveToReplayArchive(path, replayRoot);
        }
    }

    private static AuditRecord ParseRecord(string line)
    {
        using JsonDocument document = JsonDocument.Parse(line);
        JsonElement root = document.RootElement;
        return new AuditRecord(
            GetString(root, "Source") ?? AuditSourceCatalog.System,
            GetString(root, "Type") ?? AuditTypeCatalog.Audit,
            GetDateTime(root, "OccurredAtUtc"),
            GetString(root, "EventInfo") ?? string.Empty,
            DecodePayload(GetString(root, "RetentionEnvelopeBase64Url")),
            Action: GetString(root, "Action") ?? AuditActionCatalog.LogRecorded,
            Outcome: GetString(root, "Outcome") ?? AuditOutcomeCatalog.Unknown,
            Severity: GetString(root, "Severity") ?? AuditSeverityCatalog.Info,
            ActorType: GetString(root, "ActorType"),
            ActorId: GetString(root, "ActorId"),
            ActorRole: GetString(root, "ActorRole"),
            TargetType: GetString(root, "TargetType"),
            TargetId: GetString(root, "TargetId"),
            IsHighValue: root.TryGetProperty("IsHighValue", out JsonElement high) && high.ValueKind == JsonValueKind.True,
            TraceId: GetString(root, "TraceId"),
            RequestPath: GetString(root, "RequestPath"),
            RequestMethod: GetString(root, "RequestMethod"),
            IpHash: GetString(root, "IpHash"),
            UserAgentHash: GetString(root, "UserAgentHash"),
            SessionIdHash: GetString(root, "SessionIdHash"),
            DeviceFingerprintHash: GetString(root, "DeviceFingerprintHash"),
            ReasonCode: GetString(root, "ReasonCode"),
            ContextJson: GetString(root, "ContextJson"),
            ChainId: GetString(root, "ChainId"),
            PrevHash: GetString(root, "PrevHash"),
            RecordHash: GetString(root, "RecordHash"),
            RecordMac: GetString(root, "RecordMac"));
    }

    private static string? GetString(JsonElement root, string property)
        => root.TryGetProperty(property, out JsonElement value) && value.ValueKind != JsonValueKind.Null
            ? value.GetString()
            : null;

    private static DateTime GetDateTime(JsonElement root, string property)
        => root.TryGetProperty(property, out JsonElement value) && value.TryGetDateTime(out DateTime result)
            ? result.ToUniversalTime()
            : DateTime.UtcNow;

    private static byte[]? DecodePayload(string? encoded)
        => string.IsNullOrWhiteSpace(encoded) ? null : WebEncoders.Base64UrlDecode(encoded);

    private static void MoveToReplayArchive(string path, string replayRoot)
    {
        Directory.CreateDirectory(replayRoot);
        string destination = Path.Combine(replayRoot, Path.GetFileName(path));
        if (File.Exists(destination))
        {
            destination = Path.Combine(
                replayRoot,
                $"{Path.GetFileNameWithoutExtension(path)}-{DateTime.UtcNow.Ticks}{Path.GetExtension(path)}");
        }

        File.Move(path, destination);
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
