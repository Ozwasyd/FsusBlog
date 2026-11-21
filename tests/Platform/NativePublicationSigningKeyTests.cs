using System.Security.Cryptography;

namespace FsusBlog.V2.Platform.Tests;

public sealed class NativePublicationSigningKeyTests
{
    [Fact]
    public void OpensPrivateKeyOnlyWhenOwned0700Directory0400RegularFileAndMatchingPublicKey()
    {
        if (OperatingSystem.IsWindows() || !NativeUnixFile.Supported) return;
        using var scratch = new Scratch();
        using var generated = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var expectedSpki = generated.ExportSubjectPublicKeyInfo();
        var pkcs8 = generated.ExportPkcs8PrivateKey();

        var keyDir = Directory.CreateDirectory(Path.Combine(scratch.FullName, "keys"));
        File.SetUnixFileMode(keyDir.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var keyFile = Path.Combine(keyDir.FullName, "signing.der");
        File.WriteAllBytes(keyFile, pkcs8);
        File.SetUnixFileMode(keyFile, UnixFileMode.UserRead);

        using (var opened = NativePublicationSigningKey.Open(keyFile, expectedSpki))
        {
            var payload = "publication-signing-probe"u8.ToArray();
            var sig = opened.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            Assert.True(generated.VerifyData(payload, sig, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        }

        // Wrong expected public key
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, other.ExportSubjectPublicKeyInfo()));

        // Relative or non-canonical path
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open("signing.der", expectedSpki));
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(Path.Combine(keyDir.FullName, "..", "keys", "signing.der"), expectedSpki));

        // Symlink file or symlink directory
        var linkedFile = Path.Combine(keyDir.FullName, "linked.der");
        File.CreateSymbolicLink(linkedFile, keyFile);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(linkedFile, expectedSpki));

        var linkedDir = Path.Combine(scratch.FullName, "linked-keys");
        Directory.CreateSymbolicLink(linkedDir, keyDir.FullName);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(Path.Combine(linkedDir, "signing.der"), expectedSpki));

        // Permissive file mode (0600)
        File.SetUnixFileMode(keyFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, expectedSpki));
        File.SetUnixFileMode(keyFile, UnixFileMode.UserRead);

        // Permissive directory mode (0755)
        File.SetUnixFileMode(keyDir.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        Assert.Throws<InvalidOperationException>(() => NativePublicationSigningKey.Open(keyFile, expectedSpki));
    }

    private sealed class Scratch : IDisposable
    {
        public string FullName { get; }

        public Scratch()
        {
            var root = Directory.CreateTempSubdirectory("fsus-signing-key-");
            FullName = OperatingSystem.IsMacOS() && root.FullName.StartsWith("/var/", StringComparison.Ordinal)
                ? "/private" + root.FullName
                : root.FullName;
        }

        public void Dispose() => Directory.Delete(FullName, recursive: true);
    }
}
