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

    [Fact]
    public void QuarantineRequiresMatchingReceiptAndExplicitOfflineApprovalAcrossRestart()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var signed = Sign(publisher, archive);
        var clock = new Clock();
        var owner = NewOwner();
        ExtensionCheckpoint before;
        using (var store = disk.Create(Key(publisher), [Catalog("fixture", archive)], clock))
        {
            store.InstallAndActivate(Source, archive, signed, ExtensionPlatform.ServerLinux);
            store.SetOwner(owner);
            var grant = store.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
            using var operation = BeginRead(store, owner, grant);
            before = store.Checkpoint;
            store.Quarantine("fixture.extension", "operator-investigation");
            AssertRejected("operation-no-longer-current", () => operation.Complete(() => throw new InvalidOperationException()));
        }

        var status = disk.Status(clock);
        var quarantined = Assert.Single(status.Installations);
        Assert.Equal("quarantined", quarantined.State);
        var receipt = Assert.IsType<ExtensionQuarantine>(quarantined.Quarantine).Receipt;
        AssertRejected("activation-checkpoint-mismatch", () => disk.OpenMaintenance(clock, before));
        using (var store = disk.OpenMaintenance(clock, status.Checkpoint))
        {
            AssertRejected("installation-store-maintenance-only", () => store.SetOwner(owner));
            AssertRejected("extension-quarantined", () => store.InstallAndActivate(Source, archive, signed, ExtensionPlatform.ServerLinux));
            AssertRejected("quarantine-approval", () => store.ClearQuarantine("fixture.extension", Guid.NewGuid(), Guid.NewGuid()));
            AssertRejected("quarantine-approval", () => store.ClearQuarantine("fixture.extension", receipt, receipt));
            store.ClearQuarantine("fixture.extension", receipt, Guid.NewGuid());
        }
        status = disk.Status(clock);
        Assert.Equal("inactive", Assert.Single(status.Installations).State);
        using (var store = disk.OpenMaintenance(clock, status.Checkpoint))
            store.InstallAndActivate(Source, archive, signed, ExtensionPlatform.ServerLinux);
        status = disk.Status(clock);
        Assert.Equal("active-verified", Assert.Single(status.Installations).State);
        Assert.NotNull(Assert.Single(status.Installations).Quarantine?.ReleaseApproval);
    }

    [Fact]
    public void MaintenanceCanQuarantineAnAuthenticatedActivationWithCorruptArchive()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var clock = new Clock();
        using (var store = disk.Create(Key(publisher), [Catalog("fixture", archive)], clock))
            store.InstallAndActivate(Source, archive, Sign(publisher, archive), ExtensionPlatform.ServerLinux);
        var different = archive.ToArray();
        different[^1] ^= 1;
        disk.Replace($"{Hash(archive)}.zip", different);
        var originalLedger = disk.ReadLedger();
        var status = disk.Status(clock);
        var item = Assert.Single(status.Installations);
        Assert.Equal("active-blocked", item.State);
        Assert.Equal("archive-digest", item.VerificationIssue);
        Assert.Equal(originalLedger, disk.ReadLedger());
        AssertRejected("archive-digest", () => disk.Open(clock));
        using (var store = disk.OpenMaintenance(clock, status.Checkpoint))
            store.Quarantine("fixture.extension", "archive-digest");
        Assert.Equal("quarantined", Assert.Single(disk.Status(clock).Installations).State);
        using var reopened = disk.Open(clock);
        reopened.SetOwner(NewOwner());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingStageRetainsTheOriginalStoreAndQuotaAcrossDisposal(bool closeOperationFirst)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new InstallationDisk();
        using var stagingDisk = new InstallationDisk();
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var store = OpenStagingStore(disk, publisher, out var owner);
        var grant = store.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        var request = new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3);
        using var operation = store.Begin(owner, "fixture.read", "preview", request);
        var staging = store.BindStaging("scratch", stagingDisk.Root);
        using var input = new PausedStream();
        var pending = staging.Stage(operation, input);
        try
        {
            await input.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var before = store.Checkpoint;
            var archive = MakeArchive();
            var source = Catalog("fixture", archive);
            AssertRejected("installation-store-broker-busy", () =>
                store.InstallAndActivate(Source, archive, Sign(publisher, archive), ExtensionPlatform.ServerLinux));
            AssertRejected("installation-store-broker-busy", () => store.ReplaceTrust([Key(publisher)], [source]));
            AssertRejected("installation-store-broker-busy", () => store.Deactivate("fixture.extension"));
            AssertRejected("installation-store-broker-busy", () => store.Quarantine("fixture.extension", "new-reason"));
            AssertRejected("installation-store-broker-busy", () => store.ClearQuarantine("fixture.extension", Guid.NewGuid(), Guid.NewGuid()));
            Assert.Equal(before, store.Checkpoint);

            if (closeOperationFirst) operation.Dispose();
            AssertRejected("proposal-scope", () => store.Begin(owner, "fixture.read", "preview",
                new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3)));
            store.Dispose();
            Assert.ThrowsAny<IOException>(() => disk.Open(new Clock()));
        }
        finally { input.Resume.TrySetResult(); }

        if (closeOperationFirst)
        {
            var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => pending);
            Assert.Equal("operation-closed", failure.Code);
        }
        else await Assert.ThrowsAsync<ObjectDisposedException>(() => pending);
        Assert.Empty(stagingDisk.Root.EnumerateFileSystemInfos());
        using var reopened = disk.Open(new Clock());
        AssertRejected("unknown-consent", () => reopened.Begin(owner, "fixture.read", "preview", request));
        reopened.Deactivate("fixture.extension");
    }

    [Fact]
    public async Task StagingCannotPublishThroughAnInMemoryScopeOrAGenericCompletion()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var stagingDisk = new InstallationDisk();
        var (authority, owner, _, _) = Host(publisher);
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = authority.Begin(owner, "fixture.read", "preview", new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3));
        var executed = false;
        AssertRejected("staging-broker-required", () => operation.Complete(() => executed = true));
        Assert.False(executed);
        var staging = new ExtensionStaging("scratch", stagingDisk.Root);
        using var content = new MemoryStream("abc"u8.ToArray());
        var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => staging.Stage(operation, content));
        Assert.Equal("staging-installed-scope-required", failure.Code);
        Assert.Equal(0, content.Position);
        Assert.Empty(stagingDisk.Root.EnumerateFileSystemInfos());
    }

    [Fact]
    public async Task OnlyTheBoundStagingBrokerCanUseTheApprovedRootLabel()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var disk = new InstallationDisk();
        using var stagingDisk = new InstallationDisk();
        using var otherDisk = new InstallationDisk();
        using var store = OpenStagingStore(disk, publisher, out var owner);
        var grant = store.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        var original = store.BindStaging("scratch", stagingDisk.Root);
        AssertRejected("staging-broker-already-bound", () => store.BindStaging("scratch", otherDisk.Root));
        var foreign = new ExtensionStaging("scratch", otherDisk.Root);
        var request = new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3);
        using var operation = store.Begin(owner, "fixture.read", "preview", request);
        using var content = new MemoryStream("abc"u8.ToArray());
        var error = await Assert.ThrowsAsync<ExtensionRejectedException>(() => foreign.Stage(operation, content));
        Assert.Equal("staging-broker-not-bound", error.Code);
        Assert.Equal(0, content.Position);
        Assert.Empty(otherDisk.Root.EnumerateFileSystemInfos());
        AssertRejected("proposal-scope", () => store.Begin(owner, "fixture.read", "preview", request));
        using var fresh = store.Begin(owner, "fixture.read", "preview",
            new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3));
        Assert.Equal(Hash("abc"u8.ToArray()), await original.Stage(fresh, content));
    }

    [Fact]
    public async Task StageRechecksTheExactInstalledArchiveBeforeIssuingAReceipt()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var disk = new InstallationDisk();
        using var stagingDisk = new InstallationDisk();
        var archive = MakeArchive();
        using var store = disk.Create(Key(publisher), [Catalog("fixture", archive)], new Clock());
        store.InstallAndActivate(Source, archive, Sign(publisher, archive), ExtensionPlatform.ServerLinux);
        var owner = NewOwner();
        store.SetOwner(owner);
        var grant = store.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = store.Begin(owner, "fixture.read", "preview", new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3));
        using var stream = new AtEndStream(() =>
        {
            if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            disk.Replace($"{Hash(archive)}.zip", "invalid fixture bytes"u8.ToArray());
        });
        var staging = store.BindStaging("scratch", stagingDisk.Root);
        var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => staging.Stage(operation, stream));
        Assert.Equal("archive-digest", failure.Code);
        Assert.Empty(stagingDisk.Root.EnumerateFileSystemInfos());
        AssertRejected("unknown-consent", () => store.Begin(owner, "fixture.read", "preview",
            new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3)));
        store.Deactivate("fixture.extension");
    }

    private sealed class AtEndStream(Action atEnd) : MemoryStream("abc"u8.ToArray())
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Position == Length) atEnd();
            return base.ReadAsync(buffer, cancellationToken);
        }
    }

    private static ExtensionInstallationStore OpenStagingStore(InstallationDisk disk, ECDsa publisher, out ExtensionOwner owner)
    {
        var archive = MakeArchive();
        var store = disk.Create(Key(publisher), [Catalog("fixture", archive)], new Clock());
        try
        {
            store.InstallAndActivate(Source, archive, Sign(publisher, archive), ExtensionPlatform.ServerLinux);
            owner = NewOwner();
            store.SetOwner(owner);
            return store;
        }
        catch
        {
            store.Dispose();
            throw;
        }
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

        public ExtensionInstallationStore OpenMaintenance(TimeProvider clock, ExtensionCheckpoint checkpoint) =>
            ExtensionInstallationStore.OpenForMaintenance(_root, _id, _mac, clock, checkpoint);

        public ExtensionStoreStatus Status(TimeProvider clock) => ExtensionInstallationStore.Inspect(_root, _id, _mac, clock);

        public DirectoryInfo Root => _root;

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
