using System.Buffers.Binary;

namespace FsusBlog.V2.Tests;

internal static class SignedExtensionFixture
{
    private const string PathInArchive = "bin/worker.wasm";
    internal const string Source = "approved-source/fixture";
    internal static readonly DateTimeOffset Now = new(2026, 11, 14, 12, 0, 0, TimeSpan.Zero);

    internal static void AssertRejected(string code, Action act) => Assert.Equal(code, Assert.Throws<ExtensionRejectedException>(act).Code);

    internal static async Task AssertRejectedAsync(string code, Func<Task> act) =>
        Assert.Equal(code, (await Assert.ThrowsAsync<ExtensionRejectedException>(act)).Code);

    internal static byte[] FlipLast(byte[] bytes)
    {
        var copy = bytes.ToArray();
        copy[^1] ^= 1;
        return copy;
    }

    internal static ExtensionProposal.ReadRange ReadRequest(Guid grant, int start = 1, int end = 2) => new(Guid.NewGuid(), grant, start, end);

    internal static ExtensionProposal.StageFile StageRequest(Guid grant) => new(Guid.NewGuid(), grant, "scratch", 3);

    internal static (ExtensionAuthority, ExtensionOwner, ExtensionPackageVerifier) Host(ECDsa key, string provenance)
    {
        var clock = new Clock();
        var archive = MakeArchive();
        var verifier = Verifier(key, clock, archive, provenance: provenance);
        var authority = new ExtensionAuthority(verifier, clock);
        authority.Activate(Source, archive, Sign(key, archive), ExtensionPlatform.ServerLinux);
        var owner = NewOwner();
        authority.SetOwner(owner);
        return (authority, owner, verifier);
    }

    internal static ExtensionConsent Consent(ExtensionOwner owner, ExtensionCapability capability, string? root = null, int bytes = 0) =>
        new("fixture.extension", "fixture.read", owner, "preview", capability, root, bytes, Now.AddMinutes(2));

    internal static ExtensionPackageVerifier Verifier(ECDsa key, Clock clock, byte[] archive, DateTimeOffset? revokedAt = null,
        string provenance = "provenance/review-one") => new(
        [Key(key, revokedAt)], [Catalog("fixture", archive, provenance)], clock);

    internal static ExtensionOwner NewOwner() => new(Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(), 17, 1);

    internal static ExtensionPublisherKey Key(ECDsa publisher, DateTimeOffset? revokedAt = null) =>
        new("fixture.publisher", "first", [.. publisher.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1), revokedAt);

    internal static ApprovedExtensionSource Catalog(string name, byte[] archive, string? provenance = null) =>
        new($"approved-source/{name}", provenance ?? $"provenance/{name}", "fixture.publisher", "first", Hash(archive), "signature/first", "trust/policy");

    internal static byte[] Sign(ECDsa key, byte[] archive) => key.SignData(archive, HashAlgorithmName.SHA256,
        DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    internal static byte[] MakeArchive(Func<string, string>? change = null, string path = PathInArchive, bool symlink = false, bool wrongDigest = false)
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
        return AppearancePackageStore.MakeZip(
            ("manifest.json", Encoding.UTF8.GetBytes(change?.Invoke(json) ?? json), false),
            (path, module, symlink));
    }

    private static byte[] Framed(byte[] bytes)
    {
        var result = new byte[4 + bytes.Length];
        BinaryPrimitives.WriteInt32BigEndian(result, bytes.Length);
        bytes.CopyTo(result, 4);
        return result;
    }

    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    internal sealed class Clock : TimeProvider
    {
        private int _reads;
        public DateTimeOffset? Next { get; set; }
        public override DateTimeOffset GetUtcNow() => _reads++ == 0 ? Now : Next ?? Now;
    }
}
