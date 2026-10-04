using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Audit;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Security-risk-owned encrypted journal. Admission never opens SQL; only an
/// exact store commit permits the immutable source to enter its deletion phase.
/// </summary>
internal sealed class SecurityRiskFallbackWriter : IDisposable
{
    internal const string KeyDomain = "security-risk-delivery";
    private const int MaximumFileBytes = 65_536;
    private const UnixFileMode DirectoryMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode FileModeBits = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private readonly string _root;
    private readonly string _keyRoot;
    private readonly IAuditRetentionEpochKeyStore _keys;
    private readonly FileStream _ownerLease;
    private readonly int _maximumInFlight;
    private readonly SemaphoreSlim _admissionGate = new(1, 1);
    private readonly object _gate = new();
    private readonly Dictionary<string, Lease> _leases = new(StringComparer.Ordinal);
    private long _publicationSequence;
    private long _accepted;
    private long _committed;
    private long _sequence;
    private readonly HashSet<string> _unrecordedFailureReferences = new(StringComparer.Ordinal);
    private bool _unrepresentedMarkerFailure;
    private string? _lastReference;

    internal SecurityRiskFallbackWriter(IConfiguration configuration, IAuditRetentionEpochKeyStore? keys, int maximumInFlight)
    {
        string? configured = configuration["FSUSBLOG_DATA_ROOT"];
        if (string.IsNullOrWhiteSpace(configured) || !Path.IsPathFullyQualified(configured))
        {
            throw new InvalidDataException("security_risk_data_root_required");
        }
        string dataRoot = Path.GetFullPath(configured);
        CheckComponents(dataRoot);
        _root = Path.Combine(dataRoot, "security-risk-fallback");
        _keyRoot = Path.Combine(dataRoot, "audit-retention", "epoch-keys");
        CheckComponents(_keyRoot);
        CheckPrivateDirectoryIfPresent(_keyRoot);
        CheckComponents(_root);
        CheckPrivateDirectoryIfPresent(_root);
        if (OperatingSystem.IsWindows())
        {
            // This journal's private-file contract currently requires Unix mode evidence.
            throw new PlatformNotSupportedException("security_risk_private_files_required");
        }
        Directory.CreateDirectory(_root, DirectoryMode);
        string ownerPath = Path.Combine(_root, ".security-risk-owner.lock");
        try
        {
            _ownerLease = new FileStream(ownerPath, PrivateOptions(FileMode.CreateNew));
        }
        catch (IOException) when (File.Exists(ownerPath))
        {
            // A surviving private lock file is reusable only after its previous
            // owner exited. Never share a key/admission namespace concurrently.
            _ownerLease = OpenPrivate(ownerPath);
        }
        try
        {
            CheckPrivateFile(ownerPath);
            _keys = keys ?? new LocalAuditRetentionEpochKeyStore(configuration);
            CheckPrivateDirectoryIfPresent(_keyRoot);
            _maximumInFlight = maximumInFlight;
            foreach (string path in Directory.EnumerateFiles(_root, "security-risk-*"))
            {
                (long sequence, string reference) = FileIdentity(path);
                _publicationSequence = Math.Max(_publicationSequence, sequence);
                CheckPrivateFile(path);
                if (path.EndsWith(".tmp", StringComparison.Ordinal))
                {
                    // A reserved private temp is discoverable before creating its DEK.
                    // It was never admitted; recovery destroys only that exact event key.
                    using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                        _ = _keys.DestroyAsync(KeyDomain, reference, CancellationToken.None).GetAwaiter().GetResult();
                    }
                    File.Delete(path);
                }
            }
        }
        catch
        {
            _ownerLease.Dispose();
            throw;
        }
    }

    internal async Task AdmitAsync(SecurityRiskEventWrite source)
    {
        SecurityRiskEventWrite payload = SecurityRiskDurableDelivery.Normalize(source);
        string reference = SecurityRiskDurableDelivery.Reference(payload.Id);
        await _admissionGate.WaitAsync().ConfigureAwait(false);
        string? temporary = null;
        try
        {
            CheckPrivateDirectoryIfPresent(_root);
            CheckPrivateDirectoryIfPresent(_keyRoot);
            string? existing = FindReference(reference);
            if (existing is not null)
            {
                using FileStream stream = OpenPrivate(existing);
                SecurityRiskDurableEntry entry = Read(stream, existing);
                if (!SecurityRiskDurableDelivery.SamePayload(entry.Payload, payload))
                {
                    throw new InvalidDataException("security_risk_delivery_identity_conflict");
                }
                return; // This exact payload already has an immutable durable source.
            }
            _publicationSequence = Math.Max(DateTime.UtcNow.Ticks, _publicationSequence + 1);
            var delivery = new SecurityRiskDurableEntry(_publicationSequence, reference, payload);
            string path = PathFor(delivery);
            temporary = path + ".tmp";
            await using (var reservation = new FileStream(temporary, PrivateOptions(FileMode.CreateNew)))
            {
                reservation.Flush(flushToDisk: true);
            }
            byte[] key = await _keys.CreateAsync(KeyDomain, reference, CancellationToken.None).ConfigureAwait(false);
            try
            {
                CheckPrivateFile(KeyPath(reference));
                byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(delivery);
                byte[] nonce = RandomNumberGenerator.GetBytes(12);
                byte[] tag = new byte[16];
                byte[] ciphertext = new byte[plaintext.Length];
                try
                {
                    using var aes = new AesGcm(key, tag.Length);
                    aes.Encrypt(nonce, plaintext, ciphertext, tag,
                        SecurityRiskDurableDelivery.AssociatedData(reference, delivery.Sequence));
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(plaintext);
                }
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new SecurityRiskJournalEnvelope(
                    1, delivery.Sequence, reference, nonce, tag, ciphertext));
                if (bytes.Length > MaximumFileBytes)
                {
                    throw new InvalidDataException("security_risk_delivery_size_invalid");
                }
                await using (var stream = new FileStream(temporary, PrivateOptions(FileMode.Open)))
                {
                    await stream.WriteAsync(bytes).ConfigureAwait(false);
                    await stream.FlushAsync().ConfigureAwait(false);
                    stream.Flush(flushToDisk: true);
                }
                lock (_gate)
                {
                    File.Move(temporary, path, overwrite: false);
                    temporary = null;
                    _accepted++;
                    _sequence++;
                    _lastReference = reference;
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(key);
            }
        }
        catch
        {
            if (temporary is not null)
            {
                _ = await _keys.DestroyAsync(KeyDomain, reference, CancellationToken.None).ConfigureAwait(false);
                File.Delete(temporary);
                temporary = null;
            }
            throw;
        }
        finally
        {
            // A failed key deletion retains its reservation for exact restart cleanup.
            _admissionGate.Release();
        }
    }

    internal bool TryLease(out SecurityRiskEventWrite payload)
    {
        lock (_gate)
        {
            payload = default;
            if (_leases.Count >= _maximumInFlight)
            {
                return false;
            }
            string? next = null;
            foreach (string path in Directory.EnumerateFiles(_root, "security-risk-*.json"))
            {
                if (!_leases.Values.Any(lease => lease.Path == path)
                    && (next is null || string.CompareOrdinal(path, next) < 0))
                {
                    next = path;
                }
            }
            if (next is null)
            {
                return false;
            }
            FileStream? stream = null;
            try
            {
                stream = OpenPrivate(next);
                SecurityRiskDurableEntry entry = Read(stream, next);
                _leases.Add(entry.Reference, new Lease(next, entry, stream));
                payload = entry.Payload;
                stream = null;
                _sequence++;
                _lastReference = entry.Reference;
                return true;
            }
            catch
            {
                RecordFailure(next);
                throw;
            }
            finally
            {
                stream?.Dispose();
            }
        }
    }

    internal bool ReturnPending(SecurityRiskEventWrite payload, bool terminal)
    {
        lock (_gate)
        {
            string reference = SecurityRiskDurableDelivery.Reference(payload.Id);
            if (!_leases.Remove(reference, out Lease? lease))
            {
                return false; // Already committed/disposed part of a partially completed batch.
            }
            lease.Stream.Dispose();
            if (terminal)
            {
                RecordFailure(lease.Path);
            }
            _sequence++;
            return true;
        }
    }

    internal async Task AcknowledgeAsync(SecurityRiskEventWrite payload)
    {
        Lease lease;
        lock (_gate)
        {
            string reference = SecurityRiskDurableDelivery.Reference(payload.Id);
            if (!_leases.TryGetValue(reference, out Lease? current)
                || !SecurityRiskDurableDelivery.SamePayload(current.Entry.Payload, payload))
            {
                throw new InvalidDataException("security_risk_ack_identity_invalid");
            }
            lease = current;
            lease.Stream.Dispose();
            // An ACK-phase source lets restart finish exact key deletion without SQL.
            File.Move(lease.Path, lease.Path + ".ack", overwrite: false);
            _leases.Remove(reference);
            File.Delete(lease.Path + ".failed");
            _sequence++;
        }
        try
        {
            await DeleteAcknowledgedAsync(lease.Path + ".ack").ConfigureAwait(false);
        }
        catch
        {
            RecordFailure(lease.Path + ".ack");
            throw;
        }
    }

    internal async Task CleanupAcknowledgedAsync()
    {
        // Stream paths instead of retaining an unbounded backlog index in RAM.
        foreach (string path in Directory.EnumerateFiles(_root, "security-risk-*.json.ack"))
        {
            try
            {
                await DeleteAcknowledgedAsync(path).ConfigureAwait(false);
            }
            catch
            {
                RecordFailure(path);
                throw;
            }
        }
    }

    private async Task DeleteAcknowledgedAsync(string path)
    {
        (_, string reference) = FileIdentity(path);
        using (FileStream stream = OpenPrivate(path))
        {
            // The private ACK marker is an owner rename, not a new SQL delivery.
            // A key absent after an interrupted deletion is allowed only here.
            if (File.Exists(KeyPath(reference)))
            {
                _ = Read(stream, path);
            }
            _ = await _keys.DestroyAsync(KeyDomain, reference, CancellationToken.None).ConfigureAwait(false);
        }
        lock (_gate)
        {
            File.Delete(path);
            File.Delete(path + ".failed");
            _unrecordedFailureReferences.Remove(reference);
            _committed++;
            _sequence++;
        }
    }

    internal SecurityRiskJournalSnapshot Snapshot()
    {
        lock (_gate)
        {
            CheckPrivateDirectoryIfPresent(_root);
            CheckPrivateDirectoryIfPresent(_keyRoot);
            long outstanding = 0;
            long terminal = 0;
            // The only RAM failure index is capped by the configured lease batch.
            // Missing sources remain unresolved; never infer their ACK from absence.
            var missingFailures = new HashSet<string>(_unrecordedFailureReferences, StringComparer.Ordinal);
            string? reference = _lastReference;
            foreach (string path in Directory.EnumerateFiles(_root, "security-risk-*"))
            {
                (_, string itemReference) = FileIdentity(path);
                CheckPrivateFile(path);
                if (path.EndsWith(".json", StringComparison.Ordinal) || path.EndsWith(".json.ack", StringComparison.Ordinal))
                {
                    outstanding++;
                    bool unrecorded = _unrecordedFailureReferences.Contains(itemReference);
                    missingFailures.Remove(itemReference);
                    if ((File.Exists(path + ".failed") || unrecorded) && !_leases.ContainsKey(itemReference))
                    {
                        terminal++;
                        reference = itemReference;
                    }
                }
            }
            long retainedTerminal = terminal;
            terminal += missingFailures.Count;
            if (missingFailures.Count > 0)
            {
                reference = missingFailures.First();
            }
            if (_unrepresentedMarkerFailure)
            {
                // This is an opaque authority-loss guard, NOT an exact event count.
                // Successful known events cannot prove disposition of untracked loss.
                terminal++;
                reference = null;
            }
            return new(Math.Max(0, outstanding - _leases.Count - retainedTerminal), _leases.Count,
                _accepted, _committed, terminal, _sequence, reference,
                _unrepresentedMarkerFailure ? "security-risk:replay-failure-budget-exhausted"
                    : terminal > 0 ? "security-risk:replay-failed" : null);
        }
    }

    private void RecordFailure(string path)
    {
        lock (_gate)
        {
            (_, string reference) = FileIdentity(path);
            _lastReference = reference;
            _sequence++;
            try
            {
                string failurePath = path + ".failed";
                if (!File.Exists(failurePath))
                {
                    using var stream = new FileStream(failurePath, PrivateOptions(FileMode.CreateNew));
                    stream.Write(Encoding.UTF8.GetBytes("security-risk:replay-failed\n"));
                    stream.Flush(flushToDisk: true);
                }
                CheckPrivateFile(failurePath);
                _unrecordedFailureReferences.Remove(reference); // The private marker now owns this current failure.
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                if (_unrecordedFailureReferences.Count < _maximumInFlight || _unrecordedFailureReferences.Contains(reference))
                {
                    _unrecordedFailureReferences.Add(reference);
                }
                else
                {
                    _unrepresentedMarkerFailure = true;
                }
            }
        }
    }

    private SecurityRiskDurableEntry Read(FileStream stream, string path)
    {
        if (stream.Length is <= 0 or > MaximumFileBytes)
        {
            throw new InvalidDataException("security_risk_journal_size_invalid");
        }
        byte[] bytes = new byte[(int)stream.Length];
        stream.ReadExactly(bytes);
        SecurityRiskJournalEnvelope envelope = JsonSerializer.Deserialize<SecurityRiskJournalEnvelope>(bytes)
            ?? throw new InvalidDataException("security_risk_journal_envelope_invalid");
        (long sequence, string reference) = FileIdentity(path);
        if (envelope.Version != 1 || envelope.Sequence != sequence || envelope.Reference != reference
            || envelope.Nonce is not { Length: 12 } || envelope.Tag is not { Length: 16 }
            || envelope.Ciphertext is not { Length: > 0 })
        {
            throw new InvalidDataException("security_risk_journal_envelope_invalid");
        }
        CheckPrivateFile(KeyPath(reference));
        byte[] key = _keys.TryReadAsync(KeyDomain, reference, CancellationToken.None).GetAwaiter().GetResult()
            ?? throw new InvalidDataException("security_risk_journal_key_missing");
        byte[] plaintext = new byte[envelope.Ciphertext.Length];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(envelope.Nonce, envelope.Ciphertext, envelope.Tag, plaintext,
                SecurityRiskDurableDelivery.AssociatedData(reference, sequence));
            SecurityRiskDurableEntry entry = JsonSerializer.Deserialize<SecurityRiskDurableEntry>(plaintext)
                ?? throw new InvalidDataException("security_risk_journal_payload_invalid");
            if (entry.Sequence != sequence || entry.Reference != reference
                || SecurityRiskDurableDelivery.Reference(entry.Payload.Id) != reference
                || !SecurityRiskDurableDelivery.SamePayload(entry.Payload, SecurityRiskDurableDelivery.Normalize(entry.Payload)))
            {
                throw new InvalidDataException("security_risk_journal_identity_invalid");
            }
            return entry;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private string? FindReference(string reference)
    {
        string? found = null;
        foreach (string path in Directory.EnumerateFiles(_root, $"security-risk-*-{reference}.json*"))
        {
            if (path.EndsWith(".failed", StringComparison.Ordinal))
            {
                continue;
            }
            if (found is not null)
            {
                throw new InvalidDataException("security_risk_duplicate_source_invalid");
            }
            found = path;
        }
        return found;
    }

    private string PathFor(SecurityRiskDurableEntry entry)
        => Path.Combine(_root, $"security-risk-{entry.Sequence:D19}-{entry.Reference}.json");

    private string KeyPath(string reference)
    {
        string identity = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{KeyDomain}\n{reference}")));
        return Path.Combine(_keyRoot, $"dek-{identity}.bin");
    }

    private static (long Sequence, string Reference) FileIdentity(string path)
    {
        Match match = Regex.Match(Path.GetFileName(path),
            @"\Asecurity-risk-([0-9]{19})-([a-f0-9]{64})\.json(?:\.ack)?(?:\.failed|\.tmp)?\z",
            RegexOptions.CultureInvariant);
        if (!match.Success || !long.TryParse(match.Groups[1].Value, NumberStyles.None,
            CultureInfo.InvariantCulture, out long sequence) || sequence <= 0)
        {
            throw new InvalidDataException("security_risk_journal_filename_invalid");
        }
        return (sequence, match.Groups[2].Value);
    }

    private FileStream OpenPrivate(string path)
    {
        CheckPrivateDirectoryIfPresent(_root);
        CheckPrivateDirectoryIfPresent(_keyRoot);
        CheckPrivateFile(path);
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
    }

    private static FileStreamOptions PrivateOptions(FileMode mode)
    {
        var options = new FileStreamOptions
        {
            Mode = mode,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous | FileOptions.WriteThrough
        };
        if (mode == FileMode.CreateNew && !OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = FileModeBits;
        }
        return options;
    }

    private static void CheckPrivateFile(string path)
    {
        CheckComponents(path);
        var info = new FileInfo(path);
        if (!info.Exists || info.Attributes.HasFlag(FileAttributes.Directory)
            || !OperatingSystem.IsWindows() && File.GetUnixFileMode(path) != FileModeBits)
        {
            throw new InvalidDataException("security_risk_private_file_invalid");
        }
    }

    private static void CheckPrivateDirectoryIfPresent(string path)
    {
        if (Directory.Exists(path) && !OperatingSystem.IsWindows() && File.GetUnixFileMode(path) != DirectoryMode)
        {
            throw new InvalidDataException("security_risk_private_directory_invalid");
        }
    }

    private static void CheckComponents(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (info.LinkTarget is not null || info.Exists && info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                throw new InvalidDataException("security_risk_symlink_rejected");
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (Lease lease in _leases.Values)
            {
                lease.Stream.Dispose();
            }
            _leases.Clear(); // Immutable files survive; disposal is never an ACK.
            _ownerLease.Dispose();
        }
        _admissionGate.Dispose();
    }

    private sealed record Lease(string Path, SecurityRiskDurableEntry Entry, FileStream Stream);
}
