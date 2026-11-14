using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

public sealed record ExtensionCheckpoint(long Sequence, string Digest);

/// <summary>Owns the activation ledger and its host-provisioned trust while holding an exclusive store handle.</summary>
public sealed class ExtensionInstallationStore : IDisposable
{
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
    private Ledger _ledger;
    private ExtensionCheckpoint _checkpoint;
    private ExtensionPackageVerifier _verifier;
    private bool _poisoned;
    private bool _closed;

    public static ExtensionInstallationStore Create(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key,
        IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources, TimeProvider clock) =>
        new(root, storeId, key, clock, new(1, storeId, 1, [.. keys], [.. sources], []), null);

    public static ExtensionInstallationStore Open(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        ExtensionCheckpoint? expectedCheckpoint = null) => new(root, storeId, key, clock, null, expectedCheckpoint);

    private ExtensionInstallationStore(DirectoryInfo root, Guid storeId, ReadOnlyMemory<byte> key, TimeProvider clock,
        Ledger? initial, ExtensionCheckpoint? expectedCheckpoint)
    {
        if (storeId == Guid.Empty || key.Length != TagBytes) throw Reject("installation-store-identity");
        _root = ExtensionDisk.ValidatePrivateRoot(root);
        _storeId = storeId;
        _clock = clock;
        _key = key.ToArray();
        try
        {
            _ownership = Acquire(root);
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
            _authority = new(_verifier, _clock, _gate, ReverifyActive);
            foreach (var installation in _ledger.Installations)
            {
                _authority.RestoreVersion(installation.Id, installation.Version);
                if (!installation.Active) continue;
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
            RequireLedger(cancellationToken);
            RequirePackageSize(archive.Length, signature.Length);
            // Keep private snapshots of caller-owned memory for both validation and publication.
            var data = archive.ToArray();
            var signed = signature.ToArray();
            var package = _verifier.VerifySnapshot(approvedSource, data, signed, platform, cancellationToken);
            return _authority.ActivateVerified(package, version =>
            {
                var before = _ledger.Installations.SingleOrDefault(item => item.Id == package.Manifest.Id);
                if (before is not null && package.CheckedAt < before.ActivatedAt) throw Reject("publisher-key-not-current");
                var installation = new Installation(package.Manifest.Id, version, approvedSource, Digest(signed), platform,
                    package.Identity, package.CheckedAt, true);
                Put(ArchiveName(installation), data, installation.Version.ArchiveDigest, cancellationToken);
                Put(SignatureName(installation), signed, installation.SignatureDigest, cancellationToken);
                ReadPackage(installation, cancellationToken);
                var current = _ledger.Installations.Where(item => item.Id != installation.Id).Append(installation).ToImmutableArray();
                cancellationToken.ThrowIfCancellationRequested();
                Save(_ledger with { Installations = current });
            }, cancellationToken);
        }
    }

    public void ReplaceTrust(IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources)
    {
        lock (_gate)
        {
            RequireLedger(CancellationToken.None);
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
            RequireLedger(CancellationToken.None);
            var installed = _ledger.Installations.SingleOrDefault(item => item.Id == extensionId);
            if (installed is not { Active: true }) return;
            Save(_ledger with { Installations = _ledger.Installations.Replace(installed, installed with { Active = false }) });
            _authority.Deactivate(extensionId);
        }
    }

    public void SetOwner(ExtensionOwner owner)
    {
        lock (_gate) { RequireOpen(); _authority.SetOwner(owner); }
    }

    public Guid RecordConsent(ExtensionConsent consent)
    {
        lock (_gate) { RequireOpen(); return _authority.RecordConsent(consent); }
    }

    public void RevokeConsent(Guid id)
    {
        lock (_gate) { RequireOpen(); _authority.RevokeConsent(id); }
    }

    public ExtensionAuthority.Operation Begin(ExtensionOwner owner, string contributionId, string purpose, ExtensionProposal proposal,
        CancellationToken cancellationToken = default)
    {
        lock (_gate) { RequireOpen(); return _authority.Begin(owner, contributionId, purpose, proposal, cancellationToken); }
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
        }
    }

    private static FileStream Acquire(DirectoryInfo root)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var path = Path.Combine(root.FullName, "writer.lock");
        if (File.Exists(path) && ((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
            File.GetUnixFileMode(path) != (UnixFileMode.UserRead | UnixFileMode.UserWrite))) throw Reject("installation-lock-shape");
        return new(path, new FileStreamOptions
        {
            Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.None,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
        });
    }

    private void RequireOpen()
    {
        ObjectDisposedException.ThrowIf(_closed, this);
        if (_poisoned) throw Reject("installation-store-unavailable");
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            CryptographicOperations.ZeroMemory(_key);
            _ownership.Dispose();
        }
    }

    private static string ArchiveName(Installation entry) => $"{entry.Version.ArchiveDigest}.zip";
    private static string SignatureName(Installation entry) => $"{entry.SignatureDigest}.signature";
    private static ExtensionRejectedException Reject(string code) => new(code);

    private sealed record Ledger(int Format, Guid StoreId, long Sequence, ImmutableArray<ExtensionPublisherKey> Keys,
        ImmutableArray<ApprovedExtensionSource> Sources, ImmutableArray<Installation> Installations);
    private sealed record Installation(string Id, ExtensionInstalledVersion Version, string Source, string SignatureDigest,
        ExtensionPlatform Platform, string PackageIdentity, DateTimeOffset ActivatedAt, bool Active);
}
