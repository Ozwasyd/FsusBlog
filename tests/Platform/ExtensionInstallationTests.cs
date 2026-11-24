using static FsusBlog.V2.Platform.Tests.PlatformScratchDirectory;
using static FsusBlog.V2.Tests.SignedExtensionFixture;

namespace FsusBlog.V2.Platform.Tests;

public sealed class ExtensionInstallationTests : IDisposable
{
    private readonly PlatformScratchDirectory _root = new("fsus-installed-extension-", restrictMode: true);
    private readonly List<ExtensionInstallationStore> _stores = [];
    private PlatformScratchDirectory? _staging;
    private readonly Guid _id = Guid.NewGuid();
    private readonly byte[] _mac = RandomNumberGenerator.GetBytes(32);
    private readonly ECDsa _publisher = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly ExtensionPublisherKey _publisherKey;
    private readonly byte[] _archive = MakeArchive();
    private readonly byte[] _signature;
    private readonly ApprovedExtensionSource _approved;
    private readonly Clock _clock = new();
    private readonly ExtensionOwner _owner = NewOwner();

    private DirectoryInfo StagingDir => (_staging ??= new("fsus-stage-", restrictMode: true)).Info;

    public ExtensionInstallationTests()
    {
        _publisherKey = Key(_publisher);
        _signature = Sign(_publisher, _archive);
        _approved = Catalog("fixture", _archive);
    }

    public void Dispose()
    {
        foreach (var store in _stores) store.Dispose();
        _publisher.Dispose();
        _staging?.Dispose();
        _root.Dispose();
    }

    [Fact]
    public void InstalledPackageRestartsWithItsVersionFloorAndAnExclusiveWriter()
    {
        if (!IsPosix) return;
        var current = MakeArchive(json => json.Replace("\"Version\":\"1.0\"", "\"Version\":\"2.0\"", StringComparison.Ordinal));
        var signature = Sign(_publisher, current);
        ExtensionCheckpoint checkpoint;
        Guid staleGrant;
        using (var store = Create([Catalog("current", current), Catalog("older", _archive)]))
        {
            Assert.ThrowsAny<IOException>(() => Open());
            var installed = store.InstallAndActivate("approved-source/current", current, signature, ExtensionPlatform.ServerLinux);
            Assert.Equal("2.0", installed.Manifest.Version);
            checkpoint = store.Checkpoint;
            Assert.Equal(2, checkpoint.Sequence);
            store.InstallAndActivate("approved-source/current", current, signature, ExtensionPlatform.ServerLinux);
            Assert.Equal(checkpoint, store.Checkpoint);
            store.SetOwner(_owner);
            staleGrant = GrantRead(store);
        }

        using (var recovered = Open(checkpoint))
        {
            Assert.Equal(checkpoint, recovered.Checkpoint);
            recovered.SetOwner(_owner);
            AssertRejected("unknown-consent", () => BeginRead(recovered, staleGrant));
            using var operation = BeginRead(recovered, GrantRead(recovered));
            var published = false;
            operation.Complete(() => published = true);
            Assert.True(published);
            recovered.Deactivate("fixture.extension");
            checkpoint = recovered.Checkpoint;
        }

        using var final = Open(checkpoint);
        final.SetOwner(_owner);
        AssertRejected("consent-owner-or-package", () => GrantRead(final));
        AssertRejected("package-version-switch", () => final.InstallAndActivate("approved-source/older", _archive, _signature, ExtensionPlatform.ServerLinux));
        Assert.Equal(checkpoint, final.Checkpoint);
    }

    [Theory]
    [InlineData(true, "archive-digest")]
    [InlineData(false, "installed-signature-digest")]
    public void DiskTamperingRejectsAnInFlightResultAndAReopenedActivation(bool tamperArchive, string expectedCode)
    {
        if (!IsPosix) return;
        using (var store = OpenActive())
        {
            var grant = GrantRead(store);
            using var operation = BeginRead(store, grant);
            var original = tamperArchive ? _archive : _signature;
            Replace($"{Hash(original)}.{(tamperArchive ? "zip" : "signature")}", FlipLast(original));
            AssertNotCompleted(operation, expectedCode);
            AssertRejected("unknown-consent", () => BeginRead(store, grant));
        }
        AssertRejected(expectedCode, () => Open());
    }

    [Fact]
    public void TrustRotationPersistsAndOldLedgerRequiresTheExternalCheckpoint()
    {
        if (!IsPosix) return;
        ExtensionCheckpoint checkpoint;
        byte[] old, current;
        using (var store = OpenActive())
        {
            old = ReadLedger();
            using var operation = BeginRead(store, GrantRead(store));
            store.ReplaceTrust([_publisherKey with { RevokedAt = Now }], [_approved]);
            checkpoint = store.Checkpoint;
            current = ReadLedger();
            AssertRejected("operation-no-longer-current", () => operation.Complete(() => throw new InvalidOperationException()));
            Replace("activation.v1", old);
            AssertRejected("activation-ledger-drift", () => _ = store.Checkpoint);
            Replace("activation.v1", current);
            AssertRejected("installation-store-unavailable", () => _ = store.Checkpoint);
        }

        Replace("activation.v1", old);
        AssertRejected("activation-checkpoint-mismatch", () => Open(checkpoint));
        Replace("activation.v1", current);
        using (var recovered = Open(checkpoint))
        {
            recovered.SetOwner(_owner);
            AssertRejected("consent-owner-or-package", () => GrantRead(recovered));
            AssertRejected("publisher-key-not-current", () => Install(recovered));
        }
        Replace("activation.v1", FlipLast(current));
        AssertRejected("activation-ledger-authentication", () => Open());
    }

    [Fact]
    public void RestartAfterKeyExpiryAdmitsTrustMaintenanceButIssuesNoConsent()
    {
        if (!IsPosix) return;
        using (OpenActive()) { }
        _clock.Next = _publisherKey.ValidUntil;
        using var recovered = Open();
        recovered.SetOwner(_owner);
        AssertRejected("consent-owner-or-package", () => GrantRead(recovered));
        recovered.ReplaceTrust([_publisherKey with { ValidUntil = _publisherKey.ValidUntil.AddHours(1) }], [_approved]);
        Install(recovered);
        Assert.NotEqual(Guid.Empty, recovered.RecordConsent(
            Consent(_owner, ExtensionCapability.DocumentRangeRead) with { ExpiresAt = _publisherKey.ValidUntil.AddMinutes(2) }));
    }

    [Fact]
    public void EnrollmentPreservesAnExistingDigestPathAndLeavesTheLedgerUnchanged()
    {
        if (!IsPosix) return;
        AssertRejected("approved-source-catalog-shape", () => Create([_approved with { KeyId = "unknown" }]));
        using var store = Create();
        var checkpoint = store.Checkpoint;
        var conflicting = FlipLast(_archive);
        var name = $"{Hash(_archive)}.zip";
        Replace(name, conflicting);
        AssertRejected("installed-file-digest", () => Install(store));
        Assert.Equal(conflicting, Read(name));
        Assert.Equal(checkpoint, store.Checkpoint);
        Assert.Throws<FileNotFoundException>(() => Read($"{Hash(_signature)}.signature"));
    }

    [Fact]
    public void QuarantineRequiresMatchingReceiptAndExplicitOfflineApprovalAcrossRestart()
    {
        if (!IsPosix) return;
        ExtensionCheckpoint before;
        using (var store = OpenActive())
        {
            using var operation = BeginRead(store, GrantRead(store));
            before = store.Checkpoint;
            store.Quarantine("fixture.extension", "operator-investigation");
            AssertRejected("operation-no-longer-current", () => operation.Complete(() => throw new InvalidOperationException()));
        }

        var status = Status();
        var quarantined = Single(status);
        Assert.Equal("quarantined", quarantined.State);
        var receipt = Assert.IsType<ExtensionQuarantine>(quarantined.Quarantine).Receipt;
        AssertRejected("activation-checkpoint-mismatch", () => OpenMaintenance(before));
        using (var store = OpenMaintenance(status.Checkpoint))
        {
            AssertRejected("installation-store-maintenance-only", () => store.SetOwner(_owner));
            AssertRejected("extension-quarantined", () => Install(store));
            AssertRejected("quarantine-approval", () => store.ClearQuarantine("fixture.extension", Guid.NewGuid(), Guid.NewGuid()));
            AssertRejected("quarantine-approval", () => store.ClearQuarantine("fixture.extension", receipt, receipt));
            store.ClearQuarantine("fixture.extension", receipt, Guid.NewGuid());
        }
        status = Status();
        Assert.Equal("inactive", Single(status).State);
        using (var store = OpenMaintenance(status.Checkpoint)) Install(store);
        var active = Single(Status());
        Assert.Equal("active-verified", active.State);
        Assert.NotNull(active.Quarantine?.ReleaseApproval);
    }

    [Fact]
    public void MaintenanceCanQuarantineAnAuthenticatedActivationWithCorruptArchive()
    {
        if (!IsPosix) return;
        using (OpenActive()) { }
        ReplaceArchive(FlipLast(_archive));
        var originalLedger = ReadLedger();
        var status = Status();
        var item = Single(status);
        Assert.Equal(("active-blocked", "archive-digest"), (item.State, item.VerificationIssue));
        Assert.Equal(originalLedger, ReadLedger());
        AssertRejected("archive-digest", () => Open());
        using (var store = OpenMaintenance(status.Checkpoint)) store.Quarantine("fixture.extension", "archive-digest");
        Assert.Equal("quarantined", Single(Status()).State);
        using var reopened = Open();
        reopened.SetOwner(NewOwner());
    }

    [Fact]
    public async Task StagePreservesExistingFileAndClosesOnlyTheHandleItCreated()
    {
        if (!IsPosix) return;
        var (authority, grant, staging) = OpenStaging();
        var collision = BeginStage(authority, grant);
        var existing = Path.Combine(StagingDir.FullName, $"{collision.Proposal.RequestId:N}.stage");
        await File.WriteAllTextAsync(existing, "earlier request owns this");
        await Assert.ThrowsAnyAsync<IOException>(() => staging.Stage(collision, Abc()));
        Assert.Equal("earlier request owns this", await File.ReadAllTextAsync(existing));

        Assert.Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            await staging.Stage(BeginStage(authority, grant), Abc()));
        await AssertRejectedAsync("staging-length", () => staging.Stage(BeginStage(authority, grant), new MemoryStream("abcd"u8.ToArray())));

        using var canceled = new CancellationTokenSource();
        var failed = await Assert.ThrowsAsync<IOException>(() => staging.Stage(BeginStage(authority, grant), new FaultingStream(canceled), canceled.Token));
        Assert.Equal("first write input failure", failed.Message);
        Assert.Equal(existing, Assert.Single(Directory.GetFiles(StagingDir.FullName)));
    }

    [Fact]
    public async Task StagingOwnsOneHandleAndRevocationWhileAwaitingInputRejectsItsReceipt()
    {
        if (!IsPosix) return;
        var (authority, grant, staging) = OpenStaging();
        using var operation = BeginStage(authority, grant);
        using var input = new PausedStream();
        var pending = staging.Stage(operation, input);
        await input.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await AssertRejectedAsync("staging-already-started", () => staging.Stage(operation, Stream.Null));
        AssertRejected("installation-store-broker-busy", () => authority.Deactivate("fixture.extension"));
        authority.RevokeConsent(grant);
        input.Resume.SetResult();
        await AssertRejectedAsync("operation-no-longer-current", () => pending);
        AssertStagingEmpty();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingStageRetainsTheOriginalStoreAndQuotaAcrossDisposal(bool closeOperationFirst)
    {
        if (!IsPosix) return;
        var (store, grant, staging) = OpenStaging();
        var request = StageRequest(grant);
        using var operation = Begin(store, request);
        using var input = new PausedStream();
        var pending = staging.Stage(operation, input);
        try
        {
            await input.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var before = store.Checkpoint;
            foreach (var action in new Action[]
            {
                () => Install(store),
                () => store.ReplaceTrust([_publisherKey], [_approved]),
                () => store.Deactivate("fixture.extension"),
                () => store.Quarantine("fixture.extension", "new-reason"),
                () => store.ClearQuarantine("fixture.extension", Guid.NewGuid(), Guid.NewGuid()),
            }) AssertRejected("installation-store-broker-busy", action);
            Assert.Equal(before, store.Checkpoint);

            if (closeOperationFirst) operation.Dispose();
            AssertRejected("proposal-scope", () => BeginStage(store, grant));
            store.Dispose();
            Assert.ThrowsAny<IOException>(() => Open());
        }
        finally { input.Resume.TrySetResult(); }

        if (closeOperationFirst) await AssertRejectedAsync("operation-closed", () => pending);
        else await Assert.ThrowsAsync<ObjectDisposedException>(() => pending);
        AssertStagingEmpty();
        using var reopened = Open();
        AssertRejected("unknown-consent", () => Begin(reopened, request));
        reopened.Deactivate("fixture.extension");
    }

    [Fact]
    public async Task StagingCannotPublishThroughAnInMemoryScopeOrAGenericCompletion()
    {
        if (!IsPosix) return;
        var (authority, owner, _) = Host(_publisher, "provenance/fixture");
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = authority.Begin(owner, "fixture.read", "preview", StageRequest(grant));
        AssertNotCompleted(operation, "staging-broker-required");
        var staging = new ExtensionStaging("scratch", StagingDir);
        using var content = Abc();
        await AssertRejectedAsync("staging-installed-scope-required", () => staging.Stage(operation, content));
        Assert.Equal(0, content.Position);
        AssertStagingEmpty();
    }

    [Fact]
    public async Task OnlyTheBoundStagingBrokerCanUseTheApprovedRootLabel()
    {
        if (!IsPosix) return;
        using var otherDir = new PlatformScratchDirectory("fsus-stage-other-", restrictMode: true);
        var (store, grant, original) = OpenStaging();
        AssertRejected("staging-broker-already-bound", () => store.BindStaging("scratch", otherDir.Info));
        var foreign = new ExtensionStaging("scratch", otherDir.Info);
        var request = StageRequest(grant);
        using var operation = Begin(store, request);
        using var content = Abc();
        await AssertRejectedAsync("staging-broker-not-bound", () => foreign.Stage(operation, content));
        Assert.Equal(0, content.Position);
        Assert.Empty(otherDir.Info.EnumerateFileSystemInfos());
        AssertRejected("proposal-scope", () => Begin(store, request));
        using var fresh = BeginStage(store, grant);
        Assert.Equal(Hash("abc"u8.ToArray()), await original.Stage(fresh, content));
    }

    [Fact]
    public async Task StageRechecksTheExactInstalledArchiveBeforeIssuingAReceipt()
    {
        if (!IsPosix) return;
        var (store, grant, staging) = OpenStaging();
        using var operation = BeginStage(store, grant);
        using var stream = new AtEndStream(() => ReplaceArchive("invalid fixture bytes"u8.ToArray()));
        await AssertRejectedAsync("archive-digest", () => staging.Stage(operation, stream));
        AssertStagingEmpty();
        AssertRejected("unknown-consent", () => BeginStage(store, grant));
        store.Deactivate("fixture.extension");
    }

    private ExtensionInstallationStore Create(ApprovedExtensionSource[]? sources = null) =>
        ExtensionInstallationStore.Create(_root.Info, _id, _mac, [_publisherKey], sources ?? [_approved], _clock);

    private ExtensionInstallationStore OpenActive()
    {
        var store = Create();
        Install(store);
        store.SetOwner(_owner);
        return store;
    }

    private ExtensionInstallationStore Open(ExtensionCheckpoint? checkpoint = null) =>
        ExtensionInstallationStore.Open(_root.Info, _id, _mac, _clock, checkpoint);

    private ExtensionInstallationStore OpenMaintenance(ExtensionCheckpoint checkpoint) =>
        ExtensionInstallationStore.OpenForMaintenance(_root.Info, _id, _mac, _clock, checkpoint);

    private ExtensionStoreStatus Status() => ExtensionInstallationStore.Inspect(_root.Info, _id, _mac, _clock);
    private static ExtensionInstallationStatus Single(ExtensionStoreStatus status) => Assert.Single(status.Installations);
    private void AssertStagingEmpty() => Assert.Empty(StagingDir.EnumerateFileSystemInfos());
    private void Install(ExtensionInstallationStore store) => store.InstallAndActivate(Source, _archive, _signature, ExtensionPlatform.ServerLinux);
    private Guid GrantRead(ExtensionInstallationStore store) => store.RecordConsent(Consent(_owner, ExtensionCapability.DocumentRangeRead));
    private Guid GrantStage(ExtensionInstallationStore store) => store.RecordConsent(Consent(_owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
    private ExtensionAuthority.Operation Begin(ExtensionInstallationStore store, ExtensionProposal proposal) => store.Begin(_owner, "fixture.read", "preview", proposal);
    private ExtensionAuthority.Operation BeginRead(ExtensionInstallationStore store, Guid grant) => Begin(store, ReadRequest(grant));
    private ExtensionAuthority.Operation BeginStage(ExtensionInstallationStore store, Guid grant) => Begin(store, StageRequest(grant));
    private byte[] Read(string name) => File.ReadAllBytes(Path.Combine(_root.FullName, name));
    private byte[] ReadLedger() => Read("activation.v1");
    private void Replace(string name, byte[] content) => WriteReadOnly(_root.FullName, name, content);
    private void ReplaceArchive(byte[] content) => Replace($"{Hash(_archive)}.zip", content);

    private (ExtensionInstallationStore Store, Guid Grant, ExtensionStaging Staging) OpenStaging()
    {
        var store = OpenActive();
        _stores.Add(store);
        return (store, GrantStage(store), store.BindStaging("scratch", StagingDir));
    }

    private static MemoryStream Abc() => new("abc"u8.ToArray());

    private static void AssertNotCompleted(ExtensionAuthority.Operation operation, string code)
    {
        var executed = false;
        AssertRejected(code, () => operation.Complete(() => executed = true));
        Assert.False(executed);
    }

    private sealed class AtEndStream(Action atEnd) : MemoryStream("abc"u8.ToArray())
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Position == Length) atEnd();
            return base.ReadAsync(buffer, cancellationToken);
        }
    }

    private sealed class FaultingStream(CancellationTokenSource cancellation) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellation.Cancel();
            throw new IOException("first write input failure");
        }
    }

    private sealed class PausedStream() : MemoryStream("abc"u8.ToArray())
    {
        public TaskCompletionSource Waiting { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Waiting.TrySetResult();
            await Resume.Task.WaitAsync(cancellationToken);
            return await base.ReadAsync(buffer, cancellationToken);
        }
    }
}
