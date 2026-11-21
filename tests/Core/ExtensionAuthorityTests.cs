using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Extensions;

public sealed class ExtensionAuthorityTests
{
    private const string PathInArchive = "bin/worker.wasm";
    private const string Source = "approved-source/fixture";
    private static readonly DateTimeOffset Now = new(2026, 11, 14, 12, 0, 0, TimeSpan.Zero);

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
        var (authority, owner, _, verifier) = Host(key);
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
        var (authority, owner, _, _) = Host(key);
        var grant = authority.RecordConsent(Consent(owner, ExtensionCapability.FileSystemRootProposeWrite, "scratch", 3));
        using var operation = authority.Begin(owner, "fixture.read", "preview",
            new ExtensionProposal.StageFile(Guid.NewGuid(), grant, "scratch", 3));

        var executed = false;
        AssertRejected("staging-broker-required", () => operation.Complete(() => executed = true));
        Assert.False(executed);
        AssertRejected("staging-installed-scope-required", () => operation.BeginStaging(new StubStagingBroker(), CancellationToken.None));
    }

    private sealed class StubStagingBroker : IExtensionStagingBroker;

    private static void AssertRejected(string code, Action act) => Assert.Equal(code, Assert.Throws<ExtensionRejectedException>(act).Code);

    private static (ExtensionAuthority, ExtensionOwner, Clock, ExtensionPackageVerifier) Host(ECDsa key)
    {
        var clock = new Clock();
        var archive = MakeArchive();
        var verifier = Verifier(key, clock, archive);
        var authority = new ExtensionAuthority(verifier, clock);
        authority.Activate(Source, archive, Sign(key, archive), ExtensionPlatform.ServerLinux);
        var owner = new ExtensionOwner(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 17, 1);
        authority.SetOwner(owner);
        return (authority, owner, clock, verifier);
    }

    private static ExtensionConsent Consent(ExtensionOwner owner, ExtensionCapability capability, string? root = null, int bytes = 0) =>
        new("fixture.extension", "fixture.read", owner, "preview", capability, root, bytes, Now.AddMinutes(2));

    private static ExtensionPackageVerifier Verifier(ECDsa key, Clock clock, byte[] archive, DateTimeOffset? revokedAt = null,
        string provenance = "provenance/review-one") => new(
        [new("fixture.publisher", "first", [.. key.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1), revokedAt)],
        [new(Source, provenance, "fixture.publisher", "first", Hash(archive), "signature/first", "trust/policy")], clock);

    private static byte[] Sign(ECDsa key, byte[] archive) => key.SignData(archive, HashAlgorithmName.SHA256,
        DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    private static byte[] MakeArchive(Func<string, string>? change = null, string path = PathInArchive, bool symlink = false, bool wrongDigest = false)
    {
        byte[] module = [0, 97, 115, 109, 1, 0, 0, 0];
        var name = Framed(Encoding.UTF8.GetBytes(path));
        var content = Hash([.. name, .. SHA256.HashData(module)]);
        var payload = Hash([.. "fsusblog.authoring-package.payload.v1\0"u8, .. name, .. Framed(module)]);
        var manifest = new ExtensionManifest(1, 1, "fixture.extension", "1.0", payload, wrongDigest ? new string('0', 64) : content,
            "fixture.publisher", "signature/first", "trust/policy", new(1, 1), [ExtensionPlatform.ServerLinux],
            [new("fixture.read", 1, 1, new(1, path, Hash(module)), [ExtensionCapability.DocumentRangeRead, ExtensionCapability.FileSystemRootProposeWrite])],
            new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10), 4096, 1024, 1024, 1, 8, 4, 0, 0, 1024, 0), 1, 1, 0, 0, 0, false);
        var json = JsonSerializer.Serialize(manifest);
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var file = zip.CreateEntry("manifest.json").Open()) file.Write(Encoding.UTF8.GetBytes(change?.Invoke(json) ?? json));
            var entry = zip.CreateEntry(path);
            if (symlink) entry.ExternalAttributes = unchecked((int)0xa1ff0000);
            using var member = entry.Open();
            member.Write(module);
        }
        return output.ToArray();
    }

    private static byte[] Framed(byte[] bytes)
    {
        var result = new byte[4 + bytes.Length];
        BinaryPrimitives.WriteInt32BigEndian(result, bytes.Length);
        bytes.CopyTo(result, 4);
        return result;
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private sealed class Clock : TimeProvider
    {
        private int _reads;
        public DateTimeOffset? Next { get; set; }
        public override DateTimeOffset GetUtcNow() => _reads++ == 0 ? Now : Next ?? Now;
    }
}
