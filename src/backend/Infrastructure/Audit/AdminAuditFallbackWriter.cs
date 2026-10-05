using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

/// <summary>
/// Admin-owned encrypted outbox. A returned admission has a flushed, atomically
/// published record; replay removes it only after the store's exact commit proof.
/// </summary>
internal sealed class AdminAuditFallbackWriter
{
    private const string KeyDomain = "admin-audit-delivery";
    private const int BatchSize = 128;
    private readonly string _root;
    private readonly IAuditRetentionEpochKeyStore _keys;
    private readonly SemaphoreSlim _admissionGate = new(1, 1);
    private readonly SemaphoreSlim _replayGate = new(1, 1);
    private readonly object _stateGate = new();
    private long _publicationTicks;
    private long _accepted;
    private long _committed;
    private long _sequence;
    private long _unrecordedFailures;
    private string? _lastReference;
    private string? _lastFailure;

    internal AdminAuditFallbackWriter(IConfiguration configuration, IAuditRetentionEpochKeyStore keys)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _root = Path.GetFullPath(Path.Combine(dataRoot, "admin-audit-fallback"));
        _keys = keys;
        Directory.CreateDirectory(_root);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(_root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        foreach (string path in Directory.EnumerateFiles(_root, "admin-audit-*.json"))
        {
            string name = Path.GetFileName(path);
            const int PrefixLength = 12;
            if (name.Length >= PrefixLength + 19
                && long.TryParse(name.AsSpan(PrefixLength, 19), NumberStyles.None,
                    CultureInfo.InvariantCulture, out long ticks))
            {
                _publicationTicks = Math.Max(_publicationTicks, ticks);
            }
        }
    }

    internal async Task<AdminAuditLog> AdmitAsync(AdminAuditLog source)
    {
        await _admissionGate.WaitAsync().ConfigureAwait(false);
        Guid deliveryId = Guid.NewGuid();
        try
        {
            AdminAuditLog payload = AdminAuditDurableDelivery.Copy(source);
            payload.Id = 0;
            _publicationTicks = Math.Max(DateTime.UtcNow.Ticks, _publicationTicks + 1);
            var entry = new AdminAuditDurableEntry(deliveryId, _publicationTicks, 0, payload);
            byte[] key = await _keys.CreateAsync(KeyDomain, entry.DeliveryId.ToString("N"), CancellationToken.None)
                .ConfigureAwait(false);
            try
            {
                await PublishAsync(entry, key, overwrite: false, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                await _keys.DestroyAsync(KeyDomain, entry.DeliveryId.ToString("N"), CancellationToken.None)
                    .ConfigureAwait(false);
                throw;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
            lock (_stateGate)
            {
                _accepted++;
                _sequence++;
                _lastReference = entry.DeliveryId.ToString("N");
            }
            return AdminAuditDurableDelivery.Bind(entry, this);
        }
        catch (Exception ex)
        {
            ex.Data["AdminAuditDeliveryId"] = deliveryId.ToString("N");
            throw;
        }
        finally
        {
            _admissionGate.Release();
        }
    }

    internal async Task<AdminAuditDurableEntry> ReserveDatabaseIdAsync(
        AdminAuditDurableEntry entry, Func<Task<long>> reserve, CancellationToken cancellationToken)
    {
        if (entry.DatabaseId > 0)
        {
            return entry;
        }
        await _admissionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // The store holds the event's PostgreSQL advisory fence before this
            // read. A second scope must observe the persisted reservation, not RAM.
            AdminAuditDurableEntry current = await ReadAsync(PathFor(entry), cancellationToken).ConfigureAwait(false);
            if (current.DeliveryId != entry.DeliveryId
                || AdminAuditDurableDelivery.SerializePayload(current.Payload)
                    != AdminAuditDurableDelivery.SerializePayload(entry.Payload))
            {
                throw new InvalidDataException("admin_audit_reservation_payload_mismatch");
            }
            if (current.DatabaseId > 0)
            {
                return current;
            }
            long id = await reserve().ConfigureAwait(false);
            if (id <= 0)
            {
                throw new InvalidDataException("admin_audit_database_identity_invalid");
            }
            current = current with
            {
                DatabaseId = id
            };
            byte[] key = await ReadKeyAsync(current.DeliveryId, cancellationToken).ConfigureAwait(false);
            try
            {
                // No INSERT may run until this replacement is flushed and published.
                // A crash before publication leaves only a harmless sequence gap.
                await PublishAsync(current, key, overwrite: true, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
            return current;
        }
        finally
        {
            _admissionGate.Release();
        }
    }

    internal async Task ReplayAsync(
        Func<IReadOnlyList<AdminAuditLog>, CancellationToken, Task> persist,
        CancellationToken cancellationToken)
    {
        await _replayGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                // Retain at most one batch of paths, even for an arbitrarily large
                // disk backlog. Filename order is durable admission order.
                var paths = new SortedSet<string>(StringComparer.Ordinal);
                foreach (string path in Directory.EnumerateFiles(_root, "admin-audit-*.json"))
                {
                    paths.Add(path);
                    if (paths.Count > BatchSize)
                    {
                        paths.Remove(paths.Max!);
                    }
                }
                if (paths.Count == 0)
                {
                    return;
                }
                var batch = new List<AdminAuditLog>(paths.Count);
                string failurePath = paths.Min!;
                try
                {
                    foreach (string path in paths)
                    {
                        failurePath = path;
                        batch.Add(AdminAuditDurableDelivery.Bind(
                            await ReadAsync(path, cancellationToken).ConfigureAwait(false), this));
                    }
                    await persist(batch, cancellationToken).ConfigureAwait(false);
                    foreach (string path in paths)
                    {
                        lock (_stateGate)
                        {
                            File.Delete(path);
                            File.Delete(path + ".failed");
                            _committed++;
                            _sequence++;
                        }
                    }
                    foreach (AdminAuditLog record in batch)
                    {
                        Guid id = AdminAuditDurableDelivery.GetRequired(record).Entry.DeliveryId;
                        await _keys.DestroyAsync(KeyDomain, id.ToString("N"), CancellationToken.None).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw; // Cancellation leaves the original durable batch intact.
                }
                catch (Exception ex)
                {
                    RecordFailure(failurePath, ex.GetType().Name);
                    throw;
                }
            }
        }
        finally
        {
            _replayGate.Release();
        }
    }

    internal AdminAuditJournalSnapshot Snapshot()
    {
        lock (_stateGate)
        {
            long failures = _unrecordedFailures;
            string? failurePath = null;
            foreach (string path in Directory.EnumerateFiles(_root, "admin-audit-*.json.failed"))
            {
                failures++;
                if (failurePath is null || string.CompareOrdinal(path, failurePath) < 0)
                {
                    failurePath = path;
                }
            }
            string? failureReference = null;
            string? failureReason = null;
            if (failurePath is not null)
            {
                if (new FileInfo(failurePath).Length > 512)
                {
                    throw new InvalidDataException("admin_audit_failure_receipt_invalid");
                }
                string[] lines = File.ReadAllLines(failurePath);
                failureReference = Path.GetFileName(failurePath)[..^7];
                if (lines.Length != 3 || lines[0] != "admin-audit" || lines[1] != failureReference
                    || string.IsNullOrWhiteSpace(lines[2]))
                {
                    throw new InvalidDataException("admin_audit_failure_receipt_invalid");
                }
                failureReason = $"admin-audit:replay-failed:{lines[2]}";
            }
            return new(
                Directory.EnumerateFiles(_root, "admin-audit-*.json").LongCount(),
                _accepted, _committed,
                failures, _sequence, failureReference ?? _lastReference,
                failureReason ?? (_unrecordedFailures > 0 ? _lastFailure : null));
        }
    }

    private void RecordFailure(string path, string reason)
    {
        lock (_stateGate)
        {
            _lastReference = Path.GetFileName(path);
            _lastFailure = $"admin-audit:replay-failed:{reason}";
            _sequence++;
            try
            {
                File.WriteAllText(path + ".failed", $"admin-audit\n{_lastReference}\n{reason}\n");
            }
            catch (IOException)
            {
                _unrecordedFailures = 1;
            }
            catch (UnauthorizedAccessException)
            {
                _unrecordedFailures = 1;
            }
        }
    }

    private string PathFor(AdminAuditDurableEntry entry)
        => Path.Combine(_root, $"admin-audit-{entry.PublicationTicks:D19}-{entry.DeliveryId:N}.json");

    private async Task<byte[]> ReadKeyAsync(Guid identity, CancellationToken cancellationToken)
        => await _keys.TryReadAsync(KeyDomain, identity.ToString("N"), cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("admin_audit_journal_key_missing");

    private static byte[] AssociatedData(Guid identity, long ticks)
        => Encoding.UTF8.GetBytes($"admin-audit:v1:{identity:N}:{ticks.ToString(CultureInfo.InvariantCulture)}");

    private async Task PublishAsync(
        AdminAuditDurableEntry entry, byte[] key, bool overwrite, CancellationToken cancellationToken)
    {
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(entry);
        byte[] nonce = RandomNumberGenerator.GetBytes(12);
        byte[] tag = new byte[16];
        byte[] ciphertext = new byte[plaintext.Length];
        try
        {
            using var aes = new AesGcm(key, tag.Length);
            aes.Encrypt(nonce, plaintext, ciphertext, tag, AssociatedData(entry.DeliveryId, entry.PublicationTicks));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
        byte[] envelope = JsonSerializer.SerializeToUtf8Bytes(new AdminAuditJournalEnvelope(
            1, entry.DeliveryId, entry.PublicationTicks, nonce, tag, ciphertext));
        string path = PathFor(entry);
        string temporaryPath = path + ".tmp";
        var options = new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            Share = FileShare.None,
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
                await stream.WriteAsync(envelope, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            lock (_stateGate)
            {
                File.Move(temporaryPath, path, overwrite);
            }
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private async Task<AdminAuditDurableEntry> ReadAsync(string path, CancellationToken cancellationToken)
    {
        AdminAuditJournalEnvelope envelope = JsonSerializer.Deserialize<AdminAuditJournalEnvelope>(
            await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("admin_audit_journal_envelope_invalid");
        if (envelope.Version != 1 || envelope.DeliveryId == Guid.Empty
            || envelope.PublicationTicks <= 0 || envelope.Nonce.Length != 12 || envelope.Tag.Length != 16)
        {
            throw new InvalidDataException("admin_audit_journal_envelope_invalid");
        }
        byte[] key = await ReadKeyAsync(envelope.DeliveryId, cancellationToken).ConfigureAwait(false);
        byte[] plaintext = new byte[envelope.Ciphertext.Length];
        try
        {
            using var aes = new AesGcm(key, envelope.Tag.Length);
            aes.Decrypt(envelope.Nonce, envelope.Ciphertext, envelope.Tag, plaintext,
                AssociatedData(envelope.DeliveryId, envelope.PublicationTicks));
            AdminAuditDurableEntry entry = JsonSerializer.Deserialize<AdminAuditDurableEntry>(plaintext)
                ?? throw new InvalidDataException("admin_audit_journal_payload_invalid");
            if (entry.DeliveryId != envelope.DeliveryId || entry.PublicationTicks != envelope.PublicationTicks
                || entry.DatabaseId < 0 || entry.Payload is null || entry.Payload.Id != 0 || path != PathFor(entry))
            {
                throw new InvalidDataException("admin_audit_journal_identity_invalid");
            }
            return entry;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }
}

internal sealed record AdminAuditJournalSnapshot(
    long Pending, long Accepted, long Committed, long TerminalFailures,
    long Sequence, string? LastReference, string? LastFailure);

internal sealed record AdminAuditJournalEnvelope(
    int Version, Guid DeliveryId, long PublicationTicks, byte[] Nonce, byte[] Tag, byte[] Ciphertext);
