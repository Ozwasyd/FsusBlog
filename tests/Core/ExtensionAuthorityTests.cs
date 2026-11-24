using static FsusBlog.V2.Tests.SignedExtensionFixture;

public sealed class ExtensionAuthorityTests : IDisposable
{
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    public void Dispose() => _key.Dispose();

    [Fact]
    public void DetachedSignatureAndApprovedProvenanceBindTheSameArchive()
    {
        var archive = MakeArchive();
        var clock = new Clock();
        var verifier = Verifier(_key, clock, archive, Now.AddMinutes(3));
        var signed = Sign(_key, archive);
        var result = verifier.Verify(Source, archive, signed, ExtensionPlatform.ServerLinux);
        Assert.Equal(("fixture.extension", Now.AddMinutes(3)), (result.Manifest.Id, result.ValidUntil));

        AssertRejected("archive-digest", () => verifier.Verify(Source, FlipLast(archive), signed, ExtensionPlatform.ServerLinux));
        AssertRejected("archive-signature", () => verifier.Verify(Source, archive, FlipLast(signed), ExtensionPlatform.ServerLinux));
        AssertRejected("source-not-approved", () => verifier.Verify("approved-source/forged", archive, signed, ExtensionPlatform.ServerLinux));
        AssertRejected("manifest-platform", () => verifier.Verify(Source, archive, signed, ExtensionPlatform.Browser));
        Assert.NotEqual(result.Identity, Verifier(_key, clock, archive, Now.AddMinutes(4)).Verify(Source, archive, signed, ExtensionPlatform.ServerLinux).Identity);
        Assert.NotEqual(result.Identity, Verifier(_key, clock, archive, Now.AddMinutes(3), provenance: "provenance/review-two").Verify(Source, archive, signed, ExtensionPlatform.ServerLinux).Identity);
    }

    [Fact]
    public void ClosedManifestAndArchiveRejectEvenPublisherSignedBadInputs()
    {
        foreach (var (package, code) in new[]
        {
            (MakeArchive(json => "{\"SchemaVersion\":1," + json[1..]), "manifest-shape"),
            (MakeArchive(json => json.Replace("\"AllowExecutionFallback\":false", "\"AllowExecutionFallback\":true", StringComparison.Ordinal)), "manifest-contract"),
            (MakeArchive(json => json.Replace("\"Capabilities\":[0,7]", "\"Capabilities\":[0,99]", StringComparison.Ordinal)), "manifest-contribution"),
            (MakeArchive(path: "../worker.wasm"), "archive-entry-shape"),
            (MakeArchive(symlink: true), "archive-entry-shape"),
            (MakeArchive(wrongDigest: true), "content-digest"),
        })
            AssertRejected(code, () => Verifier(_key, new Clock(), package).Verify(Source, package, Sign(_key, package), ExtensionPlatform.ServerLinux));
    }

    [Fact]
    public void TrustCutoffAndRegressedClockAreRecheckedAfterArchiveProcessing()
    {
        var archive = MakeArchive();
        var cutoff = Now.AddMinutes(3);
        var signed = Sign(_key, archive);
        AssertRejected("publisher-key-not-current", () => Verifier(_key, new Clock { Next = cutoff }, archive, cutoff).Verify(Source, archive, signed, ExtensionPlatform.ServerLinux));
        AssertRejected("publisher-key-not-current", () => Verifier(_key, new Clock { Next = Now.AddTicks(-1) }, archive).Verify(Source, archive, signed, ExtensionPlatform.ServerLinux));
    }

    [Fact]
    public void ConsentIsBoundToOwnerRevisionCapabilityAndSingleRequest()
    {
        var (authority, owner, verifier) = Host(_key, "provenance/review-one");
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
        var request = ReadRequest(grant, 2, 5);
        AssertRejected("proposal-scope", () => authority.Begin(owner with { Site = Guid.NewGuid() }, "fixture.read", "preview", request));
        AssertRejected("proposal-scope", () => authority.Begin(owner, "fixture.read", "export", request));
        AssertRejected("proposal-scope", () => authority.Begin(owner, "fixture.read", "preview", new ExtensionProposal.ReadSelection(Guid.NewGuid(), grant)));

        using var running = authority.Begin(owner, "fixture.read", "preview", request);
        AssertRejected("proposal-scope", () => authority.Begin(owner, "fixture.read", "preview", request));
        authority.SetOwner(owner with { Revision = 2 });
        authority.SetOwner(owner);
        var published = false;
        AssertRejected("operation-no-longer-current", () => running.Complete(() => published = true));
        Assert.False(published);

        var fresh = authority.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
        using var next = authority.Begin(owner, "fixture.read", "preview", ReadRequest(fresh, 2, 5));
        authority.ReplaceTrust(verifier);
        AssertRejected("operation-no-longer-current", () => next.Complete(() => published = true));
        Assert.False(published);
    }

    [Fact]
    public void SameVersionArchiveCollisionCannotBeActivatedAfterDeactivation()
    {
        var clock = new Clock();
        var first = MakeArchive();
        var second = MakeArchive(json => json + "\n");
        var verifier = new ExtensionPackageVerifier([Key(_key)], [Catalog("fixture", first, "provenance/original"), Catalog("second", second, "provenance/alternate")], clock);
        var authority = new ExtensionAuthority(verifier, clock);
        var original = authority.Activate(Source, first, Sign(_key, first), ExtensionPlatform.ServerLinux);
        authority.Deactivate(original.Manifest.Id);
        AssertRejected("package-version-switch", () => authority.Activate("approved-source/second", second, Sign(_key, second), ExtensionPlatform.ServerLinux));
        authority.Activate(Source, first, Sign(_key, first), ExtensionPlatform.ServerLinux);
    }

    [Fact]
    public void StagingOperationRequiresBoundBrokerScopeInCoreModel()
    {
        var (authority, owner, _) = Host(_key, "provenance/review-one");
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = authority.Begin(owner, "fixture.read", "preview", StageRequest(grant));
        var executed = false;
        AssertRejected("staging-broker-required", () => operation.Complete(() => executed = true));
        Assert.False(executed);
        AssertRejected("staging-installed-scope-required", () => operation.BeginStaging(new StubStagingBroker(), CancellationToken.None));
    }

    private sealed class StubStagingBroker : IExtensionStagingBroker;
}
