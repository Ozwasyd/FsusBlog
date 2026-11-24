using static FsusBlog.V2.Platform.Tests.PlatformScratchDirectory;

namespace FsusBlog.V2.Platform.Tests;

public sealed class NativePublicationSigningKeyTests
{
    [Fact]
    public void OpensPrivateKeyOnlyWhenOwned0700Directory0400RegularFileAndMatchingPublicKey()
    {
        if (OperatingSystem.IsWindows() || !NativeUnixFile.Supported) return;
        using var scratch = new PlatformScratchDirectory("fsus-signing-key-");
        using var generated = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var expectedSpki = generated.ExportSubjectPublicKeyInfo();

        var keyDir = scratch.CreatePrivateSubdirectory("keys");
        WriteReadOnly(keyDir.FullName, "signing.der", generated.ExportPkcs8PrivateKey());
        var keyFile = Path.Combine(keyDir.FullName, "signing.der");

        using (var opened = NativePublicationSigningKey.Open(keyFile, expectedSpki))
        {
            var payload = "publication-signing-probe"u8.ToArray();
            var sig = opened.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            Assert.True(generated.VerifyData(payload, sig, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        }

        // Wrong expected public key, non-canonical paths, and symlinks
        var linkedFile = Path.Combine(keyDir.FullName, "linked.der");
        File.CreateSymbolicLink(linkedFile, keyFile);
        var linkedDir = Path.Combine(scratch.FullName, "linked-keys");
        Directory.CreateSymbolicLink(linkedDir, keyDir.FullName);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, other.ExportSubjectPublicKeyInfo()));
        foreach (var badPath in new[] { "signing.der", Path.Combine(keyDir.FullName, "..", "keys", "signing.der"), linkedFile, Path.Combine(linkedDir, "signing.der") })
            Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(badPath, expectedSpki));

        // Permissive file mode (0600) and permissive directory mode (0755)
        File.SetUnixFileMode(keyFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, expectedSpki));
        File.SetUnixFileMode(keyFile, UnixFileMode.UserRead);
        File.SetUnixFileMode(keyDir.FullName, Mode0700 | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, expectedSpki));
    }
}
