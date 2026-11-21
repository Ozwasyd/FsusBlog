using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Core.Extensions;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Platform.Extensions;

/// <summary>Owns the activation ledger and its host-provisioned trust while holding an exclusive store handle.</summary>
public sealed class ExtensionInstallationStore : IDisposable
{
    public const int MaximumArchiveBytes = MaxArchiveBytes;
    public const int MaximumSignatureBytes = MaxSignatureBytes;
    private const string LedgerName = "activation.v1";
    private const int LedgerBytes = 4 * 1024 * 1024;
    private const int TagBytes = 32;
    private readonly object _gate = new();
    private readonly string _root;
    private readonly Guid _storeId;
    private readonly byte[] _key;
    private readonly TimeProvider _clock;
    private readonly FileStream _ownership;
    private readonly ExtensionAuthority _authority;
    private readonly bool _readOnly;
    private readonly bool _servesOperations;
    private Ledger _ledger;
    private ExtensionCheckpoint _checkpoint;
    private ExtensionPackageVerifier _verifier;
    private bool _poisoned;
    private bool _closed;
    private bool _brokerHeld;
    private ExtensionStaging? _staging;
    private ExtensionDocumentBroker? _documentReader;

    public static ExtensionInstallationStore Create(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key,
        IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources, TimeProvider clock) =>
        new(root, storeId, key, clock, new(1, storeId, 1, [.. keys], [.. sources], []), null, OpenMode.Authority);

    public static ExtensionInstallationStore Open(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        ExtensionCheckpoint? expectedCheckpoint = null) => new(root, storeId, key, clock, null, expectedCheckpoint, OpenMode.Authority);

    public static ExtensionInstallationStore OpenForMaintenance(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        ExtensionCheckpoint expectedCheckpoint) => new(root, storeId, key, clock, null,
            expectedCheckpoint ?? throw Reject("activation-checkpoint-required"), OpenMode.Maintenance);

    public static ExtensionStoreStatus Inspect(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        CancellationToken cancellationToken = default)
    {
        using var store = new ExtensionInstallationStore(root, storeId, key, clock, null, null, OpenMode.ReadOnly);
        return store.InspectCore(cancellationToken);
    }

    private ExtensionInstallationStore(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        Ledger? initial, ExtensionCheckpoint? expectedCheckpoint, OpenMode mode)
    {
        if (storeId == Guid.Empty || key.Length != TagBytes) throw Reject("installation-store-identity");
        _root = ExtensionDisk.ValidatePrivateRoot(root);
        _storeId = storeId;
        _clock = clock;
        _key = key.ToArray();
        _readOnly = mode == OpenMode.ReadOnly;
        _servesOperations = mode == OpenMode.Authority;
        try
        {
            _ownership = Acquire(root, initial is not null, _readOnly);
            if (initial is null)
            {
                (_ledger, _checkpoint) = Load(CancellationToken.None);
                _verifier = new(_ledger.Keys, _ledger.Sources, _clock);
            }
            else
            {
                if (Directory.EnumerateFileSystemEntries(_root).Any(path => Path.GetFileName(path) != "writer.lock"))
                    throw Reject("installation-store-initialized");
                Validate(initial);
                _ledger = initial;
                _verifier = new(initial.Keys, initial.Sources, _clock);
                _checkpoint = Write(initial, overwrite: false);
            }

            if (expectedCheckpoint is not null && expectedCheckpoint != _checkpoint) throw Reject("activation-checkpoint-mismatch");
            _authority = new(_verifier, _clock, _gate, ReverifyActive, RetainBrokerScope);
            foreach (var installation in _ledger.Installations)
            {
                _authority.RestoreVersion(installation.Id, installation.Version);
                if (mode != OpenMode.Authority || !installation.Active) continue;
                try { _authority.ActivateVerified(ReadPackage(installation, CancellationToken.None), null, CancellationToken.None); }
                catch (ExtensionRejectedException error) when (error.Code == "publisher-key-not-current")
                {
                    // A naturally expired key must leave the store available for trust rotation or deactivation.
                }
            }
        }
        catch
        {
            _ownership?.Dispose();
            CryptographicOperations.ZeroMemory(_key);
            throw;
        }
    }

    public ExtensionCheckpoint Checkpoint
    {
        get { lock (_gate) { RequireLedger(CancellationToken.None); return _checkpoint; } }
    }

    public VerifiedExtensionPackage InstallAndActivate(string approvedSource, ReadOnlyMemory<byte> archive, ReadOnlyMemory<byte> signature,
        ExtensionPlatform platform, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            RequireMutablePackage(cancellationToken);
            RequirePackageSize(archive.Length, signature.Length);
            // Keep private snapshots of caller-owned memory for both validation and publication.
            var data = archive.ToArray();
            var signed = signature.ToArray();
            var package = _verifier.VerifySnapshot(approvedSource, data, signed, platform, cancellationToken);
            var before = _ledger.Installations.SingleOrDefault(item => item.Id == package.Manifest.Id);
            if (before?.Quarantine is { ReleasedAt: null }) throw Reject("extension-quarantined");
            if (before is not null && (package.CheckedAt < before.ActivatedAt || package.CheckedAt < before.Quarantine?.ReleasedAt))
                throw Reject("publisher-key-not-current");
            if (before is { Active: true } && before.PackageIdentity == package.Identity)
            {
                var persisted = ReadPackage(before, cancellationToken);
                return _servesOperations ? _authority.ActivateVerified(persisted, null, cancellationToken) : persisted;
            }
            var verified = _authority.ActivateVerified(package, version =>
            {
                var installation = new Installation(package.Manifest.Id, version, approvedSource, Digest(signed), platform,
                    package.Identity, package.CheckedAt, true, before?.Quarantine);
                Put(ArchiveName(installation), data, installation.Version.ArchiveDigest, cancellationToken);
                Put(SignatureName(installation), signed, installation.SignatureDigest, cancellationToken);
                ReadPackage(installation, cancellationToken);
                var current = _ledger.Installations.Where(item => item.Id != installation.Id).Append(installation).ToImmutableArray();
                cancellationToken.ThrowIfCancellationRequested();
                Save(_ledger with { Installations = current });
            }, cancellationToken);
            if (!_servesOperations) _authority.Deactivate(verified.Manifest.Id);
            return verified;
        }
    }

    public void ReplaceTrust(IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources)
    {
        lock (_gate)
        {
            RequireMutablePackage(CancellationToken.None);
            // Rotate trust conservatively so old grants and successful approvals cannot survive the change.
            var next = _ledger with
            {
                Keys = [.. keys], Sources = [.. sources],
                Installations = [.. _ledger.Installations.Select(item => item with { Active = false })]
            };
            Validate(next);
            var verifier = new ExtensionPackageVerifier(next.Keys, next.Sources, _clock);
            Save(next);
            _authority.ReplaceTrust(verifier);
            _verifier = verifier;
        }
    }

    public void Deactivate(string extensionId)
    {
        lock (_gate)
        {
            RequireMutablePackage(CancellationToken.None);
            var installed = FindInstallation(extensionId);
            if (!installed.Active) return;
            Save(_ledger with { Installations = _ledger.Installations.Replace(installed, installed with { Active = false }) });
            _authority.Deactivate(extensionId);
        }
    }

    public void Quarantine(string extensionId, string reason)
    {
        lock (_gate)
        {
            RequireMutablePackage(CancellationToken.None);
            if (!IsIdentifier(reason)) throw Reject("quarantine-reason");
            var installed = FindInstallation(extensionId);
            if (installed.Quarantine is { ReleasedAt: null } previous)
            {
                if (previous.Reason != reason) throw Reject("extension-already-quarantined");
                return;
            }
            var now = _clock.GetUtcNow();
            if (now < installed.ActivatedAt || now < installed.Quarantine?.ReleasedAt) throw Reject("quarantine-clock");
            var next = installed with { Active = false, Quarantine = new(Guid.NewGuid(), reason, now) };
            Save(_ledger with { Installations = _ledger.Installations.Replace(installed, next) });
            _authority.Deactivate(extensionId);
        }
    }

    public void ClearQuarantine(string extensionId, Guid receipt, Guid approval)
    {
        lock (_gate)
        {
            RequireMutablePackage(CancellationToken.None);
            var installed = FindInstallation(extensionId);
            if (installed.Quarantine is not { ReleasedAt: null } quarantine || quarantine.Receipt != receipt ||
                approval == Guid.Empty || approval == receipt) throw Reject("quarantine-approval");
            var now = _clock.GetUtcNow();
            if (now < quarantine.QuarantinedAt) throw Reject("quarantine-clock");
            var next = installed with { Quarantine = quarantine with { ReleaseApproval = approval, ReleasedAt = now } };
            Save(_ledger with { Installations = _ledger.Installations.Replace(installed, next) });
        }
    }

    private Installation FindInstallation(string extensionId) =>
        _ledger.Installations.SingleOrDefault(item => item.Id == extensionId) ?? throw Reject("installed-extension-unknown");

    private ExtensionStoreStatus InspectCore(CancellationToken cancellationToken)
    {
        RequireLedger(cancellationToken);
        var installations = ImmutableArray.CreateBuilder<ExtensionInstallationStatus>(_ledger.Installations.Length);
        foreach (var installed in _ledger.Installations.OrderBy(item => item.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string? failure = null;
            if (installed.Active)
            {
                try { ReadPackage(installed, cancellationToken); }
                catch (ExtensionRejectedException error) { failure = error.Code; }
            }
            var state = installed.Active ? failure is null ? "active-verified" : "active-blocked" :
                installed.Quarantine is { ReleasedAt: null } ? "quarantined" : "inactive";
            installations.Add(new(installed.Id, installed.Version.Version, installed.Version.Publisher, installed.PackageIdentity,
                state, failure, installed.Quarantine));
        }
        RequireLedger(cancellationToken);
        return new(_checkpoint, installations.MoveToImmutable());
    }

    public void SetOwner(ExtensionOwner owner)
    {
        lock (_gate) { RequireOperationAuthority(); _authority.SetOwner(owner); }
    }

    public Guid RecordConsent(ExtensionConsent consent)
    {
        lock (_gate) { RequireOperationAuthority(); return _authority.RecordConsent(consent); }
    }

    public void RevokeConsent(Guid id)
    {
        lock (_gate) { RequireOperationAuthority(); _authority.RevokeConsent(id); }
    }

    public ExtensionAuthority.Operation Begin(ExtensionOwner owner, string contributionId, string purpose, ExtensionProposal proposal,
        CancellationToken cancellationToken = default)
    {
        lock (_gate) { RequireOperationAuthority(); return _authority.Begin(owner, contributionId, purpose, proposal, cancellationToken); }
    }

    public ExtensionStaging BindStaging(string rootId, DirectoryInfo privateRoot)
    {
        lock (_gate)
        {
            RequireOperationAuthority();
            if (_staging is not null) throw Reject("staging-broker-already-bound");
            return _staging = new ExtensionStaging(rootId, privateRoot);
        }
    }

    internal ExtensionDocumentBroker BindDocumentReader(IExtensionDocumentCustodian custodian)
    {
        lock (_gate)
        {
            RequireOperationAuthority();
            if (_documentReader is not null) throw Reject("document-read-broker-already-bound");
            return _documentReader = new ExtensionDocumentBroker(custodian);
        }
    }

    private IDisposable RetainBrokerScope(object broker)
    {
        // Admission runs under the same gate as package verification and all store mutations.
        RequireOperationAuthority();
        if (!ReferenceEquals(_staging, broker) && !ReferenceEquals(_documentReader, broker))
            throw Reject(broker is ExtensionStaging ? "staging-broker-not-bound" : "document-read-broker-not-bound");
        if (_brokerHeld) throw Reject("installation-store-broker-busy");
        _brokerHeld = true;
        return new BrokerScope(this);
    }

    private void RequireMutablePackage(CancellationToken cancellationToken)
    {
        RequireOpen();
        if (_brokerHeld) throw Reject("installation-store-broker-busy");
        RequireLedger(cancellationToken);
    }

    private void ReverifyActive(VerifiedExtensionPackage package, CancellationToken cancellationToken, bool readInstalled)
    {
        RequireOpen();
        if (!readInstalled) return;
        RequireLedger(cancellationToken);
        var installation = _ledger.Installations.SingleOrDefault(item => item.Id == package.Manifest.Id);
        if (installation is not { Active: true } || installation.PackageIdentity != package.Identity)
            throw Reject("activation-no-longer-current");
        try { ReadPackage(installation, cancellationToken); }
        catch (ExtensionRejectedException)
        {
            _authority.Deactivate(installation.Id);
            throw;
        }
    }

    private VerifiedExtensionPackage ReadPackage(Installation installation, CancellationToken cancellationToken)
    {
        try
        {
            var archive = ExtensionDisk.Read(_root, ArchiveName(installation), MaxArchiveBytes, cancellationToken);
            var signature = ExtensionDisk.Read(_root, SignatureName(installation), MaxSignatureBytes, cancellationToken);
            if (Digest(signature) != installation.SignatureDigest) throw Reject("installed-signature-digest");
            var package = _verifier.VerifySnapshot(installation.Source, archive, signature, installation.Platform, cancellationToken);
            if (package.CheckedAt < installation.ActivatedAt) throw Reject("publisher-key-not-current");
            if (package.Manifest.Id != installation.Id || package.Identity != installation.PackageIdentity ||
                ExtensionInstalledVersion.From(package) != installation.Version) throw Reject("installed-package-identity");
            return package;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw Reject("installed-package-unavailable");
        }
    }

    private void Put(string name, byte[] bytes, string digest, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var known = ExtensionDisk.Read(_root, name, bytes.Length, cancellationToken);
            if (Digest(known) != digest) throw Reject("installed-file-digest");
        }
        catch (FileNotFoundException) { ExtensionDisk.Publish(_root, name, bytes, overwrite: false); }
    }

    private void RequireLedger(CancellationToken cancellationToken)
    {
        RequireOpen();
        try
        {
            var bytes = ReadLedger(cancellationToken);
            if (Digest(bytes) != _checkpoint.Digest) throw Reject("activation-ledger-drift");
        }
        catch (ExtensionRejectedException)
        {
            _poisoned = true;
            throw;
        }
    }

    private byte[] ReadLedger(CancellationToken cancellationToken)
    {
        try
        {
            ExtensionDisk.ValidatePrivateRoot(new(_root));
            return ExtensionDisk.Read(_root, LedgerName, LedgerBytes, cancellationToken);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw Reject("activation-ledger-unavailable");
        }
    }

    private (Ledger Ledger, ExtensionCheckpoint Checkpoint) Load(CancellationToken cancellationToken)
    {
        var bytes = ReadLedger(cancellationToken);
        if (bytes.Length <= TagBytes) throw Reject("activation-ledger-authentication");
        var data = bytes.AsSpan(TagBytes);
        var expected = HMACSHA256.HashData(_key, data);
        if (!CryptographicOperations.FixedTimeEquals(expected, bytes.AsSpan(0, TagBytes))) throw Reject("activation-ledger-authentication");
        Ledger ledger;
        try { ledger = JsonSerializer.Deserialize<Ledger>(data, Json) ?? throw Reject("activation-ledger-shape"); }
        catch (JsonException) { throw Reject("activation-ledger-shape"); }
        Validate(ledger);
        return (ledger, new(ledger.Sequence, Digest(bytes)));
    }

    private void Save(Ledger ledger)
    {
        if (_readOnly) throw Reject("installation-store-read-only");
        ledger = ledger with { Sequence = checked(_ledger.Sequence + 1) };
        _checkpoint = Write(ledger, overwrite: true);
        _ledger = ledger;
    }

    private ExtensionCheckpoint Write(Ledger ledger, bool overwrite)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(ledger, Json);
        if (data.Length > LedgerBytes - TagBytes) throw Reject("activation-ledger-size");
        var bytes = new byte[TagBytes + data.Length];
        HMACSHA256.HashData(_key, data, bytes.AsSpan(0, TagBytes));
        data.CopyTo(bytes, TagBytes);
        try { ExtensionDisk.Publish(_root, LedgerName, bytes, overwrite); }
        catch
        {
            _poisoned = true; // A failed durability acknowledgment can follow a successful rename.
            throw;
        }
        return new(ledger.Sequence, Digest(bytes));
    }

    private void Validate(Ledger ledger)
    {
        if (ledger.Format != 1 || ledger.StoreId != _storeId || ledger.Sequence < 1 || ledger.Keys.IsDefault ||
            ledger.Sources.IsDefault || ledger.Installations.IsDefault || ledger.Installations.Length > 1024 ||
            ledger.Keys.Length > 256 || ledger.Sources.Length > 1024 || ledger.Keys.Any(key => key is null) ||
            ledger.Sources.Any(source => source is null)) throw Reject("activation-ledger-shape");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var installation in ledger.Installations)
        {
            if (installation is null || !IsIdentifier(installation.Id) || !ids.Add(installation.Id) ||
                !IsOpaqueReference(installation.Source, "approved-source/") || !IsDigest(installation.SignatureDigest) ||
                !IsDigest(installation.PackageIdentity) || !Enum.IsDefined(installation.Platform) || !IsIdentifier(installation.Version.Publisher) ||
                !IsVersion(installation.Version.Version) || !IsDigest(installation.Version.ArchiveDigest) ||
                installation.Version.StateSchema is < 1 or > 1_000_000 || installation.Version.DataSchema is < 1 or > 1_000_000)
                throw Reject("activation-ledger-shape");
            if (installation.Quarantine is { } quarantine &&
                (quarantine.Receipt == Guid.Empty || !IsIdentifier(quarantine.Reason) || (quarantine.ReleasedAt is null && installation.Active) ||
                (quarantine.ReleaseApproval is null) != (quarantine.ReleasedAt is null) || quarantine.ReleaseApproval == Guid.Empty ||
                quarantine.ReleaseApproval == quarantine.Receipt || quarantine.ReleasedAt < quarantine.QuarantinedAt))
                throw Reject("activation-ledger-shape");
        }
    }

    private static FileStream Acquire(DirectoryInfo root, bool create, bool readOnly)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var path = Path.Combine(root.FullName, "writer.lock");
        if (File.Exists(path) && ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
            File.GetUnixFileMode(path) != (UnixFileMode.UserRead | UnixFileMode.UserWrite))) throw Reject("installation-lock-shape");
        return new(path, new FileStreamOptions
        {
            Mode = create ? FileMode.OpenOrCreate : FileMode.Open, Access = readOnly ? FileAccess.Read : FileAccess.ReadWrite, Share = FileShare.None,
            UnixCreateMode = create ? UnixFileMode.UserRead | UnixFileMode.UserWrite : null
        });
    }

    private void RequireOpen()
    {
        ObjectDisposedException.ThrowIf(_closed, this);
        if (_poisoned) throw Reject("installation-store-unavailable");
    }

    private void RequireOperationAuthority()
    {
        RequireOpen();
        if (!_servesOperations) throw Reject("installation-store-maintenance-only");
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            CryptographicOperations.ZeroMemory(_key);
            if (!_brokerHeld) _ownership.Dispose();
        }
    }

    private sealed class BrokerScope(ExtensionInstallationStore store) : IDisposable
    {
        private bool _released;

        public void Dispose()
        {
            lock (store._gate)
            {
                if (_released) return;
                _released = true;
                store._brokerHeld = false;
                if (store._closed) store._ownership.Dispose();
            }
        }
    }

    private static string ArchiveName(Installation entry) => $"{entry.Version.ArchiveDigest}.zip";
    private static string SignatureName(Installation entry) => $"{entry.SignatureDigest}.signature";
    private static ExtensionRejectedException Reject(string code) => new(code);

    private sealed record Ledger(int Format, Guid StoreId, long Sequence, ImmutableArray<ExtensionPublisherKey> Keys,
        ImmutableArray<ApprovedExtensionSource> Sources, ImmutableArray<Installation> Installations);
    private sealed record Installation(string Id, ExtensionInstalledVersion Version, string Source, string SignatureDigest,
        ExtensionPlatform Platform, string PackageIdentity, DateTimeOffset ActivatedAt, bool Active, ExtensionQuarantine? Quarantine = null);
    private enum OpenMode { Authority, Maintenance, ReadOnly }
}
