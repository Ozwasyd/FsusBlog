using System.Buffers;
using System.Globalization;
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

public interface IAuditDurableJournal : IAuditFallbackReplayReader
{
    Task AdmitAsync(AuditRecord record, CancellationToken cancellationToken);
    AuditDurableJournalSnapshot Snapshot();
}

public sealed record AuditDurableJournalSnapshot(
    long PendingCount,
    long InFlightCount,
    long AcceptedCount,
    long CommittedCount,
    long TerminalFailureCount,
    long Sequence,
    string? LastItemReference,
    string? LastFailureReason);

public sealed class AuditFallbackWriter : IAuditFallbackWriter, IAuditDurableJournal
{
    private const int BatchSize = 256;
    private const int WriteBufferSize = 81920;
    private static readonly byte[] s_newLineBytes = Encoding.UTF8.GetBytes(Environment.NewLine);

    private readonly string _fallbackRoot;
    private readonly AuditLogRuntimeState _runtimeState;
    private readonly SemaphoreSlim _admissionGate = new(1, 1);
    private readonly SemaphoreSlim _replayGate = new(1, 1);
    private readonly object _stateGate = new();
    private long _inFlightCount;
    private long _acceptedCount;
    private long _committedCount;
    private long _terminalFailureCount;
    private long _sequence;
    private long _observedPendingCount = -1;
    private string? _lastItemReference;
    private string? _lastFailureReason;
    private long _publicationTicks;

    private readonly AuditRetentionPayloadProtector? _retentionProtector;

    public AuditFallbackWriter(
        IConfiguration configuration,
        AuditLogRuntimeState runtimeState,
        AuditRetentionPayloadProtector? retentionProtector = null)
    {
        string fallbackRoot = ResolveFallbackRoot(configuration);
        Directory.CreateDirectory(fallbackRoot);
        _fallbackRoot = fallbackRoot;
        _runtimeState = runtimeState;
        _retentionProtector = retentionProtector;
        foreach (string path in Directory.EnumerateFiles(_fallbackRoot, "critical-audit-*.jsonl", SearchOption.TopDirectoryOnly))
        {
            string name = Path.GetFileName(path);
            const int PrefixLength = 15;
            if (name.Length >= PrefixLength + 21
                && DateTime.TryParseExact(name.AsSpan(PrefixLength, 21), "yyyyMMddHHmmssfffffff",
                    CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out DateTime publication))
            {
                _publicationTicks = Math.Max(_publicationTicks, publication.Ticks);
            }
        }
    }

    public async Task WriteAsync(AuditRecord record, Exception reason, CancellationToken cancellationToken)
        => await WriteBatchAsync([record], reason, cancellationToken);

    public async Task AdmitAsync(AuditRecord record, CancellationToken cancellationToken)
    {
        if (_retentionProtector is null)
        {
            throw new InvalidOperationException("audit_durable_retention_protector_required");
        }
        await WriteBatchAsync([record], new InvalidOperationException("durable-admission"), cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken)
    {
        // Publication order is admission order. No writer appends to a file that a
        // replay reader can move/delete, and the live backlog never grows in RAM.
        await _admissionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            for (int offset = 0; offset < records.Count; offset += BatchSize)
            {
                await WriteChunkAsync(records.Skip(offset).Take(BatchSize).ToArray(), reason, cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            _admissionGate.Release();
        }
    }

    private async Task WriteChunkAsync(IReadOnlyList<AuditRecord> records, Exception reason, CancellationToken cancellationToken)
    {
        DateTime fallbackAtUtc = DateTime.UtcNow;
        _publicationTicks = Math.Max(fallbackAtUtc.Ticks, _publicationTicks + 1);
        DateTime publicationAtUtc = new(_publicationTicks, DateTimeKind.Utc);
        string publicationToken = publicationAtUtc.ToString("yyyyMMddHHmmssfffffff", CultureInfo.InvariantCulture);
        string path = Path.Combine(_fallbackRoot,
            $"critical-audit-{publicationToken}-{Guid.NewGuid():N}.jsonl");
        string temporaryPath = path + ".tmp";
        var buffer = new ArrayBufferWriter<byte>(Math.Min(records.Count * 1024, WriteBufferSize));

        foreach (AuditRecord sourceRecord in records)
        {
            _ = AuditRetentionCatalog.GetRequired(sourceRecord.Action);
            AuditRecord record = _retentionProtector is null
                ? sourceRecord
                : await _retentionProtector.ProtectAsync(AuditDurableDelivery.NormalizeForStore(sourceRecord), cancellationToken, forceEnvelope: true)
                    .ConfigureAwait(false);
            if (_retentionProtector is not null)
            {
                record = record with
                {
                    DurableDeliveryId = AuditDurableDelivery.Identity(record.ContextPayload!)
                };
                AuditDurableDelivery.Validate(record);
            }
            using (var writer = new Utf8JsonWriter(buffer))
            {
                JsonSerializer.Serialize(writer, new
                {
                    fallbackAtUtc,
                    failure = reason.GetType().FullName,
                    Message = "audit-durable-delivery",
                    record.DurableDeliveryId,
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
                    ContextJson = record.DurableDeliveryId is not null
                        ? null
                        : record.ContextJson ?? AuditContextJsonSerializer.Serialize(record.ContextPayload),
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

        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = WriteBufferSize,
            Options = FileOptions.Asynchronous | FileOptions.WriteThrough
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        try
        {
            await using (var stream = new FileStream(temporaryPath, options))
            {
                await stream.WriteAsync(buffer.WrittenMemory, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            lock (_stateGate)
            {
                File.Move(temporaryPath, path, overwrite: false);
                _acceptedCount += records.Count;
                _lastItemReference = Path.GetFileName(path);
                _sequence++;
            }
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
        _runtimeState.RecordFallbackWrite(records.Count);
    }

    public async Task ReplayAsync(
        Func<IReadOnlyList<AuditRecord>, CancellationToken, Task> persist,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(persist);
        await _replayGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            string? previousPath = null;
            while (NextPendingPath(previousPath) is string path)
            {
                previousPath = path;
                cancellationToken.ThrowIfCancellationRequested();
                long committedInFile = 0;
                try
                {
                    using (var reader = new StreamReader(path))
                    {
                        var records = new List<AuditRecord>(BatchSize);
                        while (await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false) is string line)
                        {
                            if (string.IsNullOrWhiteSpace(line))
                            {
                                continue;
                            }
                            AuditRecord record = ParseRecord(line);
                            if (_retentionProtector is not null && record.DurableDeliveryId is null)
                            {
                                throw new InvalidDataException("audit_durable_unprotected_record");
                            }
                            records.Add(record);
                            if (records.Count == BatchSize)
                            {
                                await PersistChunkAsync(records, persist, cancellationToken).ConfigureAwait(false);
                                committedInFile += records.Count;
                                records.Clear();
                            }
                        }
                        if (records.Count > 0)
                        {
                            await PersistChunkAsync(records, persist, cancellationToken).ConfigureAwait(false);
                            committedInFile += records.Count;
                        }
                    }
                    lock (_stateGate)
                    {
                        if (committedInFile == 0)
                        {
                            throw new InvalidDataException("audit_durable_published_file_empty");
                        }
                        // A lost acknowledgement leaves the file replayable. Successful
                        // delivery needs no indefinitely retained ciphertext archive.
                        File.Delete(path);
                        _committedCount += committedInFile;
                        _lastFailureReason = null;
                        _terminalFailureCount = 0;
                        _sequence++;
                    }
                }
                catch (Exception ex)
                {
                    lock (_stateGate)
                    {
                        _lastItemReference = Path.GetFileName(path);
                        _lastFailureReason = $"replay-failed:{ex.GetType().Name}";
                        _terminalFailureCount = ex is InvalidDataException or JsonException or FormatException ? 1 : 0;
                        _sequence++;
                    }
                    throw;
                }
            }
        }
        finally
        {
            _replayGate.Release();
        }
    }

    private string? NextPendingPath(string? after)
    {
        // Selecting only the next filename avoids materializing an unbounded list
        // of backlog paths; immutable filenames retain publication order.
        string? next = null;
        foreach (string candidate in Directory.EnumerateFiles(_fallbackRoot, "critical-audit-*.jsonl", SearchOption.TopDirectoryOnly))
        {
            if ((after is null || StringComparer.Ordinal.Compare(candidate, after) > 0)
                && (next is null || StringComparer.Ordinal.Compare(candidate, next) < 0))
            {
                next = candidate;
            }
        }
        return next;
    }

    private async Task PersistChunkAsync(
        IReadOnlyList<AuditRecord> records,
        Func<IReadOnlyList<AuditRecord>, CancellationToken, Task> persist,
        CancellationToken cancellationToken)
    {
        lock (_stateGate)
        {
            _inFlightCount = records.Count;
            _sequence++;
        }
        try
        {
            await persist(records, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            lock (_stateGate)
            {
                _inFlightCount = 0;
                _sequence++;
            }
        }
    }

    public AuditDurableJournalSnapshot Snapshot()
    {
        lock (_stateGate)
        {
            long outstanding = 0;
            foreach (string path in Directory.EnumerateFiles(_fallbackRoot, "critical-audit-*.jsonl", SearchOption.TopDirectoryOnly))
            {
                long inFile = 0;
                using var reader = new StreamReader(path);
                while (reader.ReadLine() is string line)
                {
                    if (!string.IsNullOrWhiteSpace(line))
                    {
                        outstanding++;
                        inFile++;
                    }
                }
                if (inFile == 0)
                {
                    if (_terminalFailureCount == 0 || _lastItemReference != Path.GetFileName(path))
                    {
                        _sequence++;
                    }
                    _terminalFailureCount = 1;
                    _lastItemReference = Path.GetFileName(path);
                    _lastFailureReason = "audit_durable_published_file_empty";
                }
            }
            long pending = Math.Max(0, outstanding - _inFlightCount);
            if (_observedPendingCount != pending)
            {
                _observedPendingCount = pending;
                _sequence++;
            }
            return new AuditDurableJournalSnapshot(pending, _inFlightCount, _acceptedCount,
                _committedCount, _terminalFailureCount, _sequence, _lastItemReference, _lastFailureReason);
        }
    }

    private static AuditRecord ParseRecord(string line)
    {
        using JsonDocument document = JsonDocument.Parse(line);
        JsonElement root = document.RootElement;
        AuditRecord record = new(
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
            RecordMac: GetString(root, "RecordMac"))
        {
            DurableDeliveryId = GetString(root, "DurableDeliveryId")
        };
        if (record.DurableDeliveryId is not null)
        {
            AuditDurableDelivery.Validate(record);
        }
        else if (record.EventInfo == AuditRetentionPayloadProtector.EncryptedEventInfo
            && record.ContextPayload is { Length: > 0 } payload)
        {
            // Protected legacy fallback files retain the same stable ciphertext
            // identity; replay must not create a new DEK or a new audit event.
            record = record with
            {
                DurableDeliveryId = AuditDurableDelivery.Identity(payload)
            };
            AuditDurableDelivery.Validate(record);
        }
        return record;
    }

    private static string? GetString(JsonElement root, string property)
        => root.TryGetProperty(property, out JsonElement value) && value.ValueKind != JsonValueKind.Null
            ? value.GetString()
            : null;

    private static DateTime GetDateTime(JsonElement root, string property)
        => root.TryGetProperty(property, out JsonElement value) && value.TryGetDateTime(out DateTime result)
            ? result.ToUniversalTime()
            : throw new InvalidDataException("audit_durable_timestamp_missing");

    private static byte[]? DecodePayload(string? encoded)
        => string.IsNullOrWhiteSpace(encoded) ? null : WebEncoders.Base64UrlDecode(encoded);

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
