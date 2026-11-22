using System.Security.Cryptography;
using FsusBlog.V2.Core.Extensions;
using static FsusBlog.V2.Tests.SignedExtensionFixture;

public sealed class ExtensionAuthorityTests
{
    [Fact]
    public void DetachedSignatureAndApprovedProvenanceBindTheSameArchive()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var clock = new Clock();
        var verifier = Verifier(key, clock, archive, Now.AddMinutes(3));
        var signed = Sign(key, archive);
        var result = verifier.Verify(Source, archive, signed, ExtensionPlatform.ServerLinux);
        Assert.Equal("fixture.extension", result.Manifest.Id);
        Assert.Equal(Now.AddMinutes(3), result.ValidUntil);

        var tampered = archive.ToArray();
        tampered[^1] ^= 1;
        AssertRejected("archive-digest", () => verifier.Verify(Source, tampered, signed, ExtensionPlatform.ServerLinux));
        var invalidSignature = signed.ToArray();
        invalidSignature[^1] ^= 1;
        AssertRejected("archive-signature", () => verifier.Verify(Source, archive, invalidSignature, ExtensionPlatform.ServerLinux));
        AssertRejected("source-not-approved", () => verifier.Verify("approved-source/forged", archive, signed, ExtensionPlatform.ServerLinux));
        AssertRejected("manifest-platform", () => verifier.Verify(Source, archive, signed, ExtensionPlatform.Browser));
        var differentTrust = Verifier(key, clock, archive, Now.AddMinutes(4));
        Assert.NotEqual(result.Identity, differentTrust.Verify(Source, archive, signed, ExtensionPlatform.ServerLinux).Identity);
        var differentProvenance = Verifier(key, clock, archive, Now.AddMinutes(3), provenance: "provenance/review-two");
        Assert.NotEqual(result.Identity, differentProvenance.Verify(Source, archive, signed, ExtensionPlatform.ServerLinux).Identity);
    }

    [Fact]
    public void ClosedManifestAndArchiveRejectEvenPublisherSignedBadInputs()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        Check(MakeArchive(json => "{\"SchemaVersion\":1," + json[1..]), "manifest-shape");
        Check(MakeArchive(json => json.Replace("\"AllowExecutionFallback\":false", "\"AllowExecutionFallback\":true", StringComparison.Ordinal)), "manifest-contract");
        Check(MakeArchive(json => json.Replace("\"Capabilities\":[0,7]", "\"Capabilities\":[0,99]", StringComparison.Ordinal)), "manifest-contribution");
        Check(MakeArchive(path: "../worker.wasm"), "archive-entry-shape");
        Check(MakeArchive(symlink: true), "archive-entry-shape");
        Check(MakeArchive(wrongDigest: true), "content-digest");

        void Check(byte[] package, string code) => AssertRejected(code, () =>
            Verifier(key, new Clock(), package).Verify(Source, package, Sign(key, package), ExtensionPlatform.ServerLinux));
    }

    [Fact]
    public void TrustCutoffAndRegressedClockAreRecheckedAfterArchiveProcessing()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = MakeArchive();
        var cutoff = Now.AddMinutes(3);
        var signed = Sign(key, archive);
        var clock = new Clock { Next = cutoff };
        AssertRejected("publisher-key-not-current", () =>
            Verifier(key, clock, archive, cutoff).Verify(Source, archive, signed, ExtensionPlatform.ServerLinux));
        clock = new Clock { Next = Now.AddTicks(-1) };
        AssertRejected("publisher-key-not-current", () =>
            Verifier(key, clock, archive).Verify(Source, archive, signed, ExtensionPlatform.ServerLinux));
    }

    [Fact]
    public void ConsentIsBoundToOwnerRevisionCapabilityAndSingleRequest()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (authority, owner, verifier) = Host(key, "provenance/review-one");
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.DocumentRangeRead));
        var request = new ExtensionProposal.ReadRange(Guid.NewGuid(), grant, 2, 5);
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
        using var next = authority.Begin(owner, "fixture.read", "preview", new ExtensionProposal.ReadRange(Guid.NewGuid(), fresh, 2, 5));
        authority.ReplaceTrust(verifier);
        AssertRejected("operation-no-longer-current", () => next.Complete(() => published = true));
        Assert.False(published);
    }

    [Fact]
    public void SameVersionArchiveCollisionCannotBeActivatedAfterDeactivation()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var reference = "approved-source/second";
        var clock = new Clock();
        var first = MakeArchive();
        var second = MakeArchive(json => json + "\n");
        var verifier = new ExtensionPackageVerifier(
            [new("fixture.publisher", "first", [.. key.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1))],
            [new(Source, "provenance/original", "fixture.publisher", "first", Hash(first), "signature/first", "trust/policy"),
             new(reference, "provenance/alternate", "fixture.publisher", "first", Hash(second), "signature/first", "trust/policy")], clock);
        var authority = new ExtensionAuthority(verifier, clock);
        var original = authority.Activate(Source, first, Sign(key, first), ExtensionPlatform.ServerLinux);
        authority.Deactivate(original.Manifest.Id);
        AssertRejected("package-version-switch", () =>
            authority.Activate(reference, second, Sign(key, second), ExtensionPlatform.ServerLinux));
        authority.Activate(Source, first, Sign(key, first), ExtensionPlatform.ServerLinux);
    }

    [Fact]
    public void StagingOperationRequiresBoundBrokerScopeInCoreModel()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (authority, owner, _) = Host(key, "provenance/review-one");
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = authority.Begin(owner, "fixture.read", "preview",
            new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3));

        var executed = false;
        AssertRejected("staging-broker-required", () => operation.Complete(() => executed = true));
        Assert.False(executed);
        AssertRejected("staging-installed-scope-required", () => operation.BeginStaging(new StubStagingBroker(), CancellationToken.None));
    }

    private sealed class StubStagingBroker : IExtensionStagingBroker;
}
