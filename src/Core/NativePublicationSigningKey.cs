using System.Security.Cryptography;

namespace FsusBlog.V2.Core;

public static class NativePublicationSigningKey
{
    public static ECDsa Open(string? path, ReadOnlySpan<byte> expectedPublicKey)
    {
        try
        {
            if (path is null || !Path.IsPathFullyQualified(path) || path != Path.GetFullPath(path)) throw Invalid();
            using var folder = NativeUnixFile.OpenDirectory(Path.GetDirectoryName(path)!);
            if (!NativeUnixFile.HasMode(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, owned: true))
                throw Invalid();
            using var handle = NativeUnixFile.OpenFile(folder, Path.GetFileName(path), NativeUnixFile.FileReadFlags, out _);
            if (handle is null || !NativeUnixFile.IsRegular(handle, UnixFileMode.UserRead, owned: true)) throw Invalid();
            using var stream = new FileStream(handle, FileAccess.Read);
            if (stream.Length is < 1 or > 512) throw Invalid();
            var der = new byte[(int)stream.Length];
            var key = ECDsa.Create();
            try
            {
                stream.ReadExactly(der);
                if (stream.ReadByte() != -1) throw Invalid();
                key.ImportPkcs8PrivateKey(der, out var length);
                if (length != der.Length || !key.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(expectedPublicKey)) throw Invalid();
                return key;
            }
            catch { key.Dispose(); throw; }
            finally { CryptographicOperations.ZeroMemory(der); }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or
            CryptographicException or PlatformNotSupportedException)
        {
            throw Invalid();
        }
    }

    private static InvalidOperationException Invalid() => new("Invalid native publication signing configuration or private key.");
}
