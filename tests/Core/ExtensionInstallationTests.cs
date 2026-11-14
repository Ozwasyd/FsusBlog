using System.Runtime.Versioning;
using System.Security.Cryptography;
using FsusBlog.V2.Core.Extensions;

public sealed partial class ExtensionAuthorityTests
{
    [Fact]
    public void InstalledPackageRestartsWithItsVersionFloorAndAnExclusiveWriter()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var older = MakeArchive();
        var current = MakeArchive(json => json.Replace("\"Version\":\"1.0\"", "\"Version\":\"2.0\"", StringComparison.Ordinal));
        var clock = new Clock();
        ExtensionCheckpoint checkpoint;
        var signature = Sign(publisher, current);
        var owner = NewOwner();
        Guid staleGrant;
        using (var store = disk.Create(Key(publisher), [Catalog("current", current), Catalog("older", older)], clock))
        {
            Assert.ThrowsAny<IOException>(() => disk.Open(clock));
            var installed = store.InstallAndActivate("approved-source/current", current, signature, ExtensionPlatform.ServerLinux);
            Assert.Equal("2.0", installed.Manifest.Version);
            checkpoint = store.Checkpoint;
            Assert.Equal(2, checkpoint.Sequence);
            store.InstallAndActivate("approved-source/current", current, signature, ExtensionPlatform.ServerLinux);
            Assert.Equal(checkpoint, store.Checkpoint);
            store.SetOwner(owner);
            staleGrant = store.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
        }

        using (var recovered = disk.Open(clock, checkpoint))
        {
            Assert.Equal(checkpoint, recovered.Checkpoint);
            recovered.SetOwner(owner);
            AssertRejected("unknown-consent", () => BeginRead(recovered, owner, staleGrant));
            var newGrant = recovered.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
            using var operation = BeginRead(recovered, owner, newGrant);
            var published = false;
            operation.Complete(() => published = true);
            Assert.True(published);
            recovered.Deactivate("fixture.extension");
            checkpoint = recovered.Checkpoint;
        }

        using var final = disk.Open(clock, checkpoint);
        final.SetOwner(owner);
        AssertRejected("consent-owner-or-package", () => final.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead)));
        AssertRejected("package-version-switch", () => final.InstallAndActivate("approved-source/older", older, Sign(publisher, older), ExtensionPlatform.ServerLinux));
        Assert.Equal(checkpoint, final.Checkpoint);
    }

    [Theory]
    [InlineData(true, "archive-digest")]
    [InlineData(false, "installed-signature-digest")]
    public void DiskTamperingRejectsAnInFlightResultAndAReopenedActivation(bool tamperArchive, string expectedCode)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var signature = Sign(publisher, archive);
        var clock = new Clock();
        using (var store = disk.Create(Key(publisher), [Catalog("fixture", archive)], clock))
        {
            store.InstallAndActivate(Source, archive, signature, ExtensionPlatform.ServerLinux);
            var owner = NewOwner();
            store.SetOwner(owner);
            var grant = store.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
            using var operation = BeginRead(store, owner, grant);
            var original = tamperArchive ? archive : signature;
            var tampered = original.ToArray();
            tampered[^1] ^= 1;
            var path = $"{Hash(original)}.{(tamperArchive ? "zip" : "signature")}";
            disk.Replace(path, tampered);
            var published = false;
            AssertRejected(expectedCode, () => operation.Complete(() => published = true));
            Assert.False(published);
            AssertRejected("unknown-consent", () => BeginRead(store, owner, grant));
        }
        AssertRejected(expectedCode, () => disk.Open(clock));
    }

    [Fact]
    public void TrustRotationPersistsAndOldLedgerRequiresTheExternalCheckpoint()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var signature = Sign(publisher, archive);
        var clock = new Clock();
        var approved = Catalog("fixture", archive);
        var owner = NewOwner();
        ExtensionCheckpoint checkpoint;
        byte[] old;
        byte[] current;
        using (var store = disk.Create(Key(publisher), [approved], clock))
        {
            store.InstallAndActivate(Source, archive, signature, ExtensionPlatform.ServerLinux);
            old = disk.ReadLedger();
            store.SetOwner(owner);
            var grant = store.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
            using var operation = BeginRead(store, owner, grant);
            store.ReplaceTrust([Key(publisher) with { RevokedAt = Now }], [approved]);
            checkpoint = store.Checkpoint;
            current = disk.ReadLedger();
            AssertRejected("operation-no-longer-current", () => operation.Complete(() => throw new InvalidOperationException()));
            disk.Replace("activation.v1", old);
            AssertRejected("activation-ledger-drift", () => _ = store.Checkpoint);
            disk.Replace("activation.v1", current);
            AssertRejected("installation-store-unavailable", () => _ = store.Checkpoint);
        }

        disk.Replace("activation.v1", old);
        AssertRejected("activation-checkpoint-mismatch", () => disk.Open(clock, checkpoint));
        disk.Replace("activation.v1", current);
        using (var recovered = disk.Open(clock, checkpoint))
        {
            recovered.SetOwner(owner);
            AssertRejected("consent-owner-or-package", () => recovered.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead)));
            AssertRejected("publisher-key-not-current", () => recovered.InstallAndActivate(Source, archive, signature, ExtensionPlatform.ServerLinux));
        }
        var edited = current.ToArray();
        edited[^1] ^= 1;
        disk.Replace("activation.v1", edited);
        AssertRejected("activation-ledger-authentication", () => disk.Open(clock));
    }

    [Fact]
    public void RestartAfterKeyExpiryAdmitsTrustMaintenanceButIssuesNoConsent()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var clock = new Clock();
        var key = Key(publisher);
        var signature = Sign(publisher, archive);
        var approved = Catalog("fixture", archive);
        using (var store = disk.Create(key, [approved], clock))
            store.InstallAndActivate(Source, archive, signature, ExtensionPlatform.ServerLinux);
        clock.Next = key.ValidUntil;
        using var recovered = disk.Open(clock);
        var owner = NewOwner();
        recovered.SetOwner(owner);
        AssertRejected("consent-owner-or-package", () => recovered.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead)));
        recovered.ReplaceTrust([key with { ValidUntil = key.ValidUntil.AddHours(1) }], [approved]);
        recovered.InstallAndActivate(Source, archive, signature, ExtensionPlatform.ServerLinux);
        Assert.NotEqual(Guid.Empty, recovered.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead) with { ExpiresAt = key.ValidUntil.AddMinutes(2) }));
    }

    [Fact]
    public void EnrollmentPreservesAnExistingDigestPathAndLeavesTheLedgerUnchanged()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var signed = Sign(publisher, archive);
        var key = Key(publisher);
        var clock = new Clock();
        var approved = Catalog("fixture", archive);
        AssertRejected("approved-source-catalog-shape", () => disk.Create(key, [approved with { KeyId = "unknown" }], clock));
        using var store = disk.Create(key, [approved], clock);
        var checkpoint = store.Checkpoint;
        var conflicting = archive.ToArray();
        conflicting[^1] ^= 1;
        var name = $"{Hash(archive)}.zip";
        disk.Replace(name, conflicting);
        AssertRejected("installed-file-digest", () => store.InstallAndActivate(Source, archive, signed, ExtensionPlatform.ServerLinux));
        Assert.Equal(conflicting, disk.Read(name));
        Assert.Equal(checkpoint, store.Checkpoint);
        Assert.Throws<FileNotFoundException>(() => disk.Read($"{Hash(signed)}.signature"));
    }

    private static ExtensionAuthority.Operation BeginRead(ExtensionInstallationStore store, ExtensionOwner owner, Guid grant) =>
        store.Begin(owner, "fixture.read", "preview", new ExtensionProposal.ReadRange(Guid.NewGuid(), grant, 1, 2));

    private static ExtensionOwner NewOwner() => new(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 17, 1);

    private static ExtensionPublisherKey Key(ECDsa publisher) =>
        new("fixture.publisher", "first", [.. publisher.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1));

    private static ApprovedExtensionSource Catalog(string name, byte[] archive) =>
        new($"approved-source/{name}", $"provenance/{name}", "fixture.publisher", "first", Hash(archive), "signature/first", "trust/policy");

    private sealed class InstallationDisk : IDisposable
    {
        private readonly DirectoryInfo _root;
        private readonly Guid _id = Guid.NewGuid();
        private readonly byte[] _mac = RandomNumberGenerator.GetBytes(32);

        [UnsupportedOSPlatform("windows")]
        public InstallationDisk()
        {
            _root = Directory.CreateTempSubdirectory("fsus-installed-extension-");
            if (OperatingSystem.IsMacOS() && _root.FullName.StartsWith("/var/", StringComparison.Ordinal)) _root = new DirectoryInfo("/private" + _root.FullName);
            File.SetUnixFileMode(_root.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        public ExtensionInstallationStore Create(ExtensionPublisherKey key, ApprovedExtensionSource[] sources, TimeProvider clock) =>
            ExtensionInstallationStore.Create(_root, _id, _mac, [key], sources, clock);

        public ExtensionInstallationStore Open(TimeProvider clock, ExtensionCheckpoint? checkpoint = null) =>
            ExtensionInstallationStore.Open(_root, _id, _mac, clock, checkpoint);

        public byte[] Read(string name) => File.ReadAllBytes(Path.Combine(_root.FullName, name));
        public byte[] ReadLedger() => Read("activation.v1");

        [UnsupportedOSPlatform("windows")]
        public void Replace(string name, byte[] content)
        {
            var path = Path.Combine(_root.FullName, name);
            var temporary = path + ".test";
            File.WriteAllBytes(temporary, content);
            File.SetUnixFileMode(temporary, UnixFileMode.UserRead);
            File.Move(temporary, path, overwrite: true);
        }

        public void Dispose() => _root.Delete(recursive: true);
    }
}
