using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Audit;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// Challenge-owned protected admission and ordered replay, with independent lane
/// accounting. Recovery requires the same data root and compatible epoch keys.
/// </summary>
internal sealed class ChallengeV2FallbackWriter : IDisposable
{
    private const string KeyDomain = "challenge-v2-delivery";
    private const int MaximumEnvelopeBytes = 65_536;
    internal const int MaximumLaneLeases = 64;
    internal const int MaximumFailureReferences = 64;
    private readonly string _root;
    private readonly string _keyRoot;
    private readonly IAuditRetentionEpochKeyStore _keys;
    private readonly FileStream _ownerLock;
    private readonly SemaphoreSlim _admissionGate = new(1, 1);
    private readonly object _gate = new();
    private readonly Lane _high = new();
    private readonly Lane _normal = new();
    private bool _disposed;

    internal ChallengeV2FallbackWriter(IConfiguration configuration, IAuditRetentionEpochKeyStore keys)
    {
        string dataRoot = ValidateConfiguration(configuration);
        _root = Path.Combine(Path.GetFullPath(dataRoot), "challenge-v2-fallback");
        _keyRoot = Path.Combine(Path.GetFullPath(dataRoot), "audit-retention", "epoch-keys");
        _keys = keys;
        CreatePrivateDirectory(_root);
        CreatePrivateDirectory(LaneRoot(true));
        CreatePrivateDirectory(LaneRoot(false));
        CheckComponents(_keyRoot);
        string lockPath = Path.Combine(_root, ".owner.lock");
        VerifyPrivateFile(lockPath, allowMissing: true);
        _ownerLock = new FileStream(lockPath, PrivateOptions(FileMode.OpenOrCreate));
        try
        {
            foreach (bool high in new[] { true, false })
            {
                Lane lane = GetLane(high);
                foreach (string path in PendingPaths(high).Concat(Directory.EnumerateFiles(LaneRoot(high), "*.committed")))
                {
                    long ticks = ReadPublicationTicks(path);
                    lane._publicationTicks = Math.Max(lane._publicationTicks, ticks);
                }
            }
        }
        catch
        {
            _ownerLock.Dispose();
            throw;
        }
    }

    internal static string ValidateConfiguration(IConfiguration configuration)
    {
        string? dataRoot = configuration["FSUSBLOG_DATA_ROOT"] ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT");
        if (string.IsNullOrWhiteSpace(dataRoot) || !Path.IsPathFullyQualified(dataRoot))
        {
            throw new InvalidOperationException("challenge_audit_data_root_required");
        }
        CheckComponents(dataRoot);
        return Path.GetFullPath(dataRoot);
    }

    internal async Task<ChallengeV2AuditEvent> AdmitAsync(ChallengeV2AuditEvent source)
    {
        await _admissionGate.WaitAsync().ConfigureAwait(false);
        string? reference = null;
        try
        {
            SecurityChallengeAttemptRequest request = ChallengeV2DurableDelivery.Prepare(source.Attempt);
            ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(request);
            reference = ChallengeV2DurableDelivery.Reference(request.AttemptId!);
            var auditEvent = source with
            {
                Attempt = request
            };
            foreach (bool high in new[] { true, false })
            {
                string? existingPath = Directory.EnumerateFiles(LaneRoot(high), $"challenge-*-{reference}.json*")
                    .FirstOrDefault(path => path.EndsWith(".json", StringComparison.Ordinal)
                        || path.EndsWith(".json.committed", StringComparison.Ordinal));
                if (existingPath is null)
                {
                    continue;
                }
                ChallengeV2DurableEntry existing = await ReadAsync(existingPath, CancellationToken.None).ConfigureAwait(false);
                // Neither clock is a public input. For an explicit repeated identity,
                // its already-published metadata wins; supplied attempt time must match.
                SecurityChallengeAttemptRequest comparable = prepared.SuppliedAttemptedAt
                    ? request : request with
                    {
                        AttemptedAtUtc = existing.Event.Attempt.AttemptedAtUtc
                    };
                if (existing.Event != (auditEvent with
                {
                    Attempt = comparable
                }))
                {
                    throw new InvalidDataException("challenge_audit_identity_payload_conflict");
                }
                lock (_gate)
                {
                    Lane existingLane = GetLane(existing.Event.IsHighValue);
                    ClearFailure(existingLane, reference, CurrentFailure.Admission);
                }
                return Restore(existing);
            }
            Lane lane = GetLane(auditEvent.IsHighValue);
            long ticks;
            lock (_gate)
            {
                ticks = Math.Max(prepared.CreatedAtUtc.Ticks, lane._publicationTicks + 1);
                lane._publicationTicks = ticks;
            }
            var entry = new ChallengeV2DurableEntry(ticks, reference, auditEvent, prepared.CreatedAtUtc,
                prepared.SuppliedAttemptedAt);
            CheckComponents(_keyRoot);
            byte[] key = await _keys.CreateAsync(KeyDomain, reference, CancellationToken.None).ConfigureAwait(false);
            try
            {
                await PublishAsync(entry, key).ConfigureAwait(false);
            }
            catch
            {
                await _keys.DestroyAsync(KeyDomain, reference, CancellationToken.None).ConfigureAwait(false);
                throw;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
            lock (_gate)
            {
                lane._accepted++;
                ClearFailure(lane, reference, CurrentFailure.Admission);
                Update(lane, "durable-accepted", reference);
            }
            return auditEvent;
        }
        catch
        {
            lock (_gate)
            {
                Lane lane = GetLane(source.IsHighValue);
                RememberFailure(lane, reference, CurrentFailure.Admission);
                Update(lane, "terminal-failed", reference);
            }
            throw;
        }
        finally
        {
            _admissionGate.Release();
        }
    }

    internal bool MarkQueued(ChallengeV2AuditEvent auditEvent)
    {
        string reference = Reference(auditEvent);
        lock (_gate)
        {
            Lane lane = GetLane(auditEvent.IsHighValue);
            if (lane._leased.ContainsKey(reference) || lane._queued.Contains(reference)
                || FindPending(auditEvent.IsHighValue, reference) is null)
            {
                return false;
            }
            lane._queued.Add(reference);
            Update(lane, "queued", reference);
            return true;
        }
    }

    internal void MarkRejected(ChallengeV2AuditEvent auditEvent, bool removeQueued = false)
    {
        lock (_gate)
        {
            Lane lane = GetLane(auditEvent.IsHighValue);
            if (removeQueued)
            {
                lane._queued.Remove(Reference(auditEvent));
            }
            lane._rejected++;
            Update(lane, "durable-pending", Reference(auditEvent));
        }
    }

    internal bool TryLeaseNext(out ChallengeV2AuditEvent? auditEvent, out bool wasQueued)
    {
        lock (_gate)
        {
            // An unleased high source remains first even when its lane's lease
            // budget is full. Selection and leasing share the publication lock.
            return TryLease(HasUnleasedSource(true), out auditEvent, out wasQueued);
        }
    }

    private bool TryLease(bool high, out ChallengeV2AuditEvent? auditEvent, out bool wasQueued)
    {
        lock (_gate)
        {
            Lane lane = GetLane(high);
            if (lane._leased.Count >= MaximumLaneLeases)
            {
                auditEvent = null;
                wasQueued = false;
                return false;
            }
            string? path = null;
            foreach (string candidate in PendingPaths(high))
            {
                string reference = ReferenceFromPath(candidate);
                if (!lane._leased.ContainsKey(reference)
                    && (path is null || string.CompareOrdinal(candidate, path) < 0))
                {
                    path = candidate;
                }
            }
            if (path is null)
            {
                auditEvent = null;
                wasQueued = false;
                return false;
            }
            string itemReference = ReferenceFromPath(path);
            try
            {
                ChallengeV2DurableEntry entry = Task.Run(() => ReadAsync(path, CancellationToken.None)).GetAwaiter().GetResult();
                auditEvent = Restore(entry);
                wasQueued = lane._queued.Remove(itemReference);
                lane._leased.Add(itemReference, entry);
                Update(lane, "in-flight", itemReference);
                return true;
            }
            catch
            {
                RecordFailure(lane, path, itemReference, "journal-invalid");
                throw;
            }
        }
    }

    internal bool HasAvailable
    {
        get
        {
            lock (_gate)
            {
                if (HasUnleasedSource(true))
                {
                    return _high._leased.Count < MaximumLaneLeases;
                }
                return _normal._leased.Count < MaximumLaneLeases && HasUnleasedSource(false);
            }
        }
    }

    // Called only under _gate, like TryLeaseNext and HasAvailable.
    private bool HasUnleasedSource(bool high)
        => PendingPaths(high).Any(path => !GetLane(high)._leased.ContainsKey(ReferenceFromPath(path)));

    internal Task CommitAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            Lane lane = GetLane(auditEvent.IsHighValue);
            string reference = Reference(auditEvent);
            if (!lane._leased.TryGetValue(reference, out ChallengeV2DurableEntry? entry))
            {
                throw new InvalidOperationException("challenge_audit_commit_lease_required");
            }
            // Keep the protected identity/payload witness after ACK. A repeated
            // explicit identity must not acquire a new private CreatedAtUtc.
            string path = PathFor(entry);
            File.Delete(path + ".failed");
            File.Move(path, path + ".committed");
            lane._leased.Remove(reference);
            lane._committed++;
            lane._currentFailures.Remove(reference);
            Update(lane, "committed", reference);
        }
        return Task.CompletedTask;
    }

    internal bool Return(ChallengeV2AuditEvent auditEvent, string? failure)
    {
        lock (_gate)
        {
            Lane lane = GetLane(auditEvent.IsHighValue);
            string reference = Reference(auditEvent);
            if (!lane._leased.Remove(reference, out ChallengeV2DurableEntry? entry))
            {
                return false;
            }
            lane._requeued++;
            if (failure is not null)
            {
                RecordFailure(lane, PathFor(entry), reference, failure);
            }
            else
            {
                Update(lane, "durable-pending", reference);
            }
            return true;
        }
    }

    internal ChallengeV2LaneSnapshot Snapshot(bool high)
    {
        lock (_gate)
        {
            Lane lane = GetLane(high);
            long pending = PendingPaths(high).LongCount();
            long failures = lane._currentFailures.Count;
            string? reference = lane._currentFailures.Keys.FirstOrDefault();
            string? reason = reference is null ? null : QueueId(high) + ":" + FailureCategory(lane._currentFailures[reference]);
            foreach (string path in Directory.EnumerateFiles(LaneRoot(high), "*.json.failed"))
            {
                if (!File.Exists(path[..^7]))
                {
                    continue;
                }
                string receiptReference = ReferenceFromPath(path[..^7]);
                if (!lane._currentFailures.ContainsKey(receiptReference))
                {
                    failures++;
                }
                if (reference is null)
                {
                    VerifyPrivateFile(path);
                    if (new FileInfo(path).Length > 256)
                    {
                        throw new InvalidDataException("challenge_audit_failure_receipt_invalid");
                    }
                    string category = File.ReadAllText(path).Trim();
                    if (category is not ("journal-invalid" or "persist-failed" or "scope-unavailable"))
                    {
                        throw new InvalidDataException("challenge_audit_failure_receipt_invalid");
                    }
                    reference = ReferenceFromPath(path[..^7]);
                    reason = QueueId(high) + ":" + category;
                }
            }
            if (lane._unknownCurrentFailure)
            {
                // A sentinel, not an exact count of failures outside the fixed
                // reference budget. No known event can prove this unknown loss healed.
                failures++;
                reference = null;
                reason = QueueId(high) + ":current-failure-unknown";
            }
            return new(lane._queued.Count, lane._leased.Count,
                Math.Max(0, pending - lane._queued.Count - lane._leased.Count),
                lane._accepted, lane._committed, lane._requeued, lane._rejected, failures, lane._sequence,
                lane._disposition, failures > 0 ? reference : lane._reference,
                failures > 0 ? reason : null, lane._historicalFailureCount);
        }
    }

    private void RecordFailure(Lane lane, string path, string reference, string category)
    {
        lane._historicalFailureCount++;
        Update(lane, "terminal-failed", reference);
        try
        {
            string receipt = path + ".failed";
            VerifyPrivateFile(receipt, allowMissing: true);
            using var stream = new FileStream(receipt, PrivateOptions(FileMode.Create));
            stream.Write(Encoding.UTF8.GetBytes(category));
            stream.Flush(flushToDisk: true);
            ClearFailure(lane, reference, CurrentFailure.Replay);
        }
        catch (IOException)
        {
            RememberFailure(lane, reference, ReplayFailure(category), countOccurrence: false);
        }
        catch (UnauthorizedAccessException)
        {
            RememberFailure(lane, reference, ReplayFailure(category), countOccurrence: false);
        }
    }

    private static void RememberFailure(Lane lane, string? reference, CurrentFailure failure, bool countOccurrence = true)
    {
        if (countOccurrence)
        {
            lane._historicalFailureCount++;
        }
        if (reference is null || (!lane._currentFailures.ContainsKey(reference)
            && lane._currentFailures.Count >= MaximumFailureReferences))
        {
            lane._unknownCurrentFailure = true;
            return;
        }
        lane._currentFailures.TryGetValue(reference, out CurrentFailure existing);
        lane._currentFailures[reference] = existing | failure;
    }

    private static void ClearFailure(Lane lane, string reference, CurrentFailure recovered)
    {
        if (!lane._currentFailures.TryGetValue(reference, out CurrentFailure current))
        {
            return;
        }
        CurrentFailure remaining = current & ~recovered;
        if (remaining == 0)
        {
            lane._currentFailures.Remove(reference);
        }
        else
        {
            lane._currentFailures[reference] = remaining;
        }
    }

    private static CurrentFailure ReplayFailure(string category) => category switch
    {
        "journal-invalid" => CurrentFailure.Journal,
        "scope-unavailable" => CurrentFailure.Scope,
        _ => CurrentFailure.Persist
    };

    private static string FailureCategory(CurrentFailure failure)
        => (failure & CurrentFailure.Admission) != 0 ? "admission-failed"
            : (failure & CurrentFailure.Journal) != 0 ? "journal-invalid"
            : (failure & CurrentFailure.Scope) != 0 ? "scope-unavailable" : "persist-failed";

    private static ChallengeV2AuditEvent Restore(ChallengeV2DurableEntry entry)
        => entry.Event with
        {
            Attempt = ChallengeV2DurableDelivery.Bind(new(entry.Event.Attempt, entry.CreatedAtUtc, entry.SuppliedAttemptedAt))
        };

    private async Task PublishAsync(ChallengeV2DurableEntry entry, byte[] key)
    {
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(entry);
        byte[] nonce = RandomNumberGenerator.GetBytes(12);
        byte[] tag = new byte[16];
        byte[] ciphertext = new byte[plaintext.Length];
        try
        {
            using var aes = new AesGcm(key, tag.Length);
            aes.Encrypt(nonce, plaintext, ciphertext, tag, AssociatedData(entry.Reference, entry.PublicationTicks, entry.Event.IsHighValue));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new Envelope(1, entry.Reference, entry.PublicationTicks,
            entry.Event.IsHighValue, nonce, tag, ciphertext));
        string path = PathFor(entry);
        string temporary = path + ".tmp";
        CheckComponents(Path.GetDirectoryName(path)!);
        VerifyPrivateFile(temporary, allowMissing: true);
        try
        {
            await using (var stream = new FileStream(temporary, PrivateOptions(FileMode.CreateNew)))
            {
                await stream.WriteAsync(bytes).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            lock (_gate)
            {
                File.Move(temporary, path);
            }
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private async Task<ChallengeV2DurableEntry> ReadAsync(string path, CancellationToken cancellationToken)
    {
        VerifyPrivateFile(path);
        if (new FileInfo(path).Length > MaximumEnvelopeBytes)
        {
            throw new InvalidDataException("challenge_audit_journal_envelope_invalid");
        }
        Envelope envelope = JsonSerializer.Deserialize<Envelope>(await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("challenge_audit_journal_envelope_invalid");
        if (envelope.Version != 1 || envelope.Reference != ReferenceFromPath(path)
            || envelope.PublicationTicks != ReadPublicationTicks(path) || envelope.Reference.Length != 64
            || envelope.Nonce.Length != 12 || envelope.Tag.Length != 16)
        {
            throw new InvalidDataException("challenge_audit_journal_identity_invalid");
        }
        CheckComponents(_keyRoot);
        if (_keys is LocalAuditRetentionEpochKeyStore)
        {
            string keyIdentity = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{KeyDomain}\n{envelope.Reference}")));
            VerifyPrivateFile(Path.Combine(_keyRoot, $"dek-{keyIdentity}.bin"));
        }
        byte[] key = await _keys.TryReadAsync(KeyDomain, envelope.Reference, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("challenge_audit_journal_key_missing");
        byte[] plaintext = new byte[envelope.Ciphertext.Length];
        try
        {
            using var aes = new AesGcm(key, envelope.Tag.Length);
            aes.Decrypt(envelope.Nonce, envelope.Ciphertext, envelope.Tag, plaintext,
                AssociatedData(envelope.Reference, envelope.PublicationTicks, envelope.High));
            ChallengeV2DurableEntry entry = JsonSerializer.Deserialize<ChallengeV2DurableEntry>(plaintext)
                ?? throw new InvalidDataException("challenge_audit_journal_payload_invalid");
            if (entry.Reference != envelope.Reference || entry.PublicationTicks != envelope.PublicationTicks
                || entry.Event.IsHighValue != envelope.High || Reference(entry.Event) != entry.Reference
                || (path != PathFor(entry) && path != PathFor(entry) + ".committed"))
            {
                throw new InvalidDataException("challenge_audit_journal_payload_invalid");
            }
            _ = Restore(entry);
            return entry;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private string? FindPending(bool high, string reference)
        => Directory.EnumerateFiles(LaneRoot(high), $"challenge-*-{reference}.json").FirstOrDefault();

    private IEnumerable<string> PendingPaths(bool high) => Directory.EnumerateFiles(LaneRoot(high), "challenge-*.json");

    private string PathFor(ChallengeV2DurableEntry entry)
        => Path.Combine(LaneRoot(entry.Event.IsHighValue), $"challenge-{entry.PublicationTicks:D19}-{entry.Reference}.json");

    private string LaneRoot(bool high) => Path.Combine(_root, high ? "high-value" : "normal");
    private Lane GetLane(bool high) => high ? _high : _normal;
    private static string QueueId(bool high) => high ? "challenge-audit-high-value" : "challenge-audit-normal";
    private static string Reference(ChallengeV2AuditEvent auditEvent) => ChallengeV2DurableDelivery.Reference(auditEvent.Attempt.AttemptId!);

    private static string ReferenceFromPath(string path)
    {
        string name = Path.GetFileName(path);
        if (name.Length < 99 || name[29] != '-')
        {
            throw new InvalidDataException("challenge_audit_journal_filename_invalid");
        }
        string reference = name.Substring(30, 64);
        if (reference.Any(value => value is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidDataException("challenge_audit_journal_filename_invalid");
        }
        return reference;
    }

    private static long ReadPublicationTicks(string path)
        => long.TryParse(Path.GetFileName(path).AsSpan(10, 19), NumberStyles.None, CultureInfo.InvariantCulture, out long ticks)
            && ticks > 0 ? ticks : throw new InvalidDataException("challenge_audit_journal_filename_invalid");

    private static byte[] AssociatedData(string reference, long ticks, bool high)
        => Encoding.UTF8.GetBytes($"challenge:v1:{QueueId(high)}:{reference}:{ticks.ToString(CultureInfo.InvariantCulture)}");

    private static void Update(Lane lane, string disposition, string? reference)
    {
        lane._sequence++;
        lane._disposition = disposition;
        lane._reference = reference;
    }

    private static FileStreamOptions PrivateOptions(FileMode mode)
    {
        var options = new FileStreamOptions
        {
            Mode = mode,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous | FileOptions.WriteThrough
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        return options;
    }

    private static void CreatePrivateDirectory(string path)
    {
        CheckComponents(path);
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    private static void CheckComponents(string path)
    {
        for (var current = new DirectoryInfo(Path.GetFullPath(path)); current is not null; current = current.Parent)
        {
            if (current.LinkTarget is not null || (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0))
            {
                throw new InvalidDataException("challenge_audit_path_link_rejected");
            }
        }
    }

    private static void VerifyPrivateFile(string path, bool allowMissing = false)
    {
        CheckComponents(Path.GetDirectoryName(path)!);
        var info = new FileInfo(path);
        if (info.LinkTarget is not null || (info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0))
        {
            throw new InvalidDataException("challenge_audit_path_link_rejected");
        }
        if (!info.Exists && allowMissing)
        {
            return;
        }
        if (!info.Exists || (!OperatingSystem.IsWindows()
            && (File.GetUnixFileMode(path) & ~(UnixFileMode.UserRead | UnixFileMode.UserWrite)) != 0))
        {
            throw new InvalidDataException("challenge_audit_private_file_required");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _ownerLock.Dispose();
        _admissionGate.Dispose();
    }

    private sealed class Lane
    {
        internal readonly HashSet<string> _queued = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, ChallengeV2DurableEntry> _leased = new(StringComparer.Ordinal);
        internal long _publicationTicks;
        internal long _accepted;
        internal long _committed;
        internal long _requeued;
        internal long _rejected;
        internal long _sequence;
        internal readonly Dictionary<string, CurrentFailure> _currentFailures = new(StringComparer.Ordinal);
        internal bool _unknownCurrentFailure;
        internal long _historicalFailureCount;
        internal string? _reference;
        internal string? _disposition;
    }

    [Flags]
    private enum CurrentFailure
    {
        Admission = 1,
        Journal = 2,
        Persist = 4,
        Scope = 8,
        Replay = Journal | Persist | Scope
    }

    private sealed record Envelope(int Version, string Reference, long PublicationTicks, bool High,
        byte[] Nonce, byte[] Tag, byte[] Ciphertext);
}
