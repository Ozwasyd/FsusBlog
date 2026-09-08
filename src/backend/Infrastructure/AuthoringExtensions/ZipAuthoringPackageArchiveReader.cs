using System.Collections.Immutable;
using System.IO.Compression;
using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class ZipAuthoringPackageArchiveReader : IAuthoringPackageArchiveReader
{
    public const string ManifestPath = "manifest.json";
    public const int MaximumManifestBytes = 256 * 1024;
    public const int MaximumEntryBytes = 16 * 1024 * 1024;
    public const long MaximumContentBytes = 64L * 1024 * 1024;
    public const int MaximumEntries = 4096;

    public async ValueTask<AuthoringPackageArchiveContents> ReadAsync(
        ReadOnlyMemory<byte> canonicalArchive,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (canonicalArchive.IsEmpty || canonicalArchive.Length > 128 * 1024 * 1024)
        {
            throw new AuthoringExtensionContractException("Package archive is empty or outside its byte bound.");
        }

        try
        {
            using var stream = new MemoryStream(canonicalArchive.ToArray(), writable: false);
            using var archive = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: false);
            if (archive.Entries.Count is < 2 or > MaximumEntries + 1)
            {
                throw new AuthoringExtensionContractException("Package archive entry count is outside its bound.");
            }

            ImmutableArray<byte> manifest = default;
            var entries = ImmutableArray.CreateBuilder<AuthoringPackageEntry>(archive.Entries.Count - 1);
            var paths = new HashSet<string>(StringComparer.Ordinal);
            long totalBytes = 0;
            foreach (ZipArchiveEntry item in archive.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string path = ValidatePath(item.FullName);
                if (!paths.Add(path))
                {
                    throw new AuthoringExtensionContractException("Package archive contains a duplicate path.");
                }

                bool symbolicLink = IsSymbolicLink(item);
                bool reparsePoint = (item.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0;
                if (symbolicLink || reparsePoint || string.IsNullOrEmpty(item.Name))
                {
                    throw new AuthoringExtensionContractException("Package archive contains a link, reparse point, or directory entry.");
                }

                long maximum = path == ManifestPath ? MaximumManifestBytes : MaximumEntryBytes;
                if (item.Length < 0 || item.Length > maximum)
                {
                    throw new AuthoringExtensionContractException("Package archive entry is outside its byte bound.");
                }

                byte[] content = await ReadExactBoundedAsync(item, maximum, cancellationToken).ConfigureAwait(false);
                if (path == ManifestPath)
                {
                    if (!manifest.IsDefault)
                    {
                        throw new AuthoringExtensionContractException("Package archive contains multiple manifests.");
                    }

                    manifest = ImmutableArray.Create(content);
                    continue;
                }

                totalBytes = checked(totalBytes + content.Length);
                if (totalBytes > MaximumContentBytes)
                {
                    throw new AuthoringExtensionContractException("Package archive content exceeds its aggregate byte bound.");
                }

                bool postInstall = path.Equals("postinstall", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith("/postinstall", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".postinstall", StringComparison.OrdinalIgnoreCase);
                entries.Add(new AuthoringPackageEntry(
                    path,
                    ImmutableArray.Create(content),
                    Convert.ToHexStringLower(SHA256.HashData(content)),
                    symbolicLink,
                    reparsePoint,
                    postInstall));
            }

            if (manifest.IsDefaultOrEmpty || entries.Count == 0)
            {
                throw new AuthoringExtensionContractException("Package archive must contain one manifest and at least one content entry.");
            }

            return new AuthoringPackageArchiveContents(manifest, entries.MoveToImmutable());
        }
        catch (AuthoringExtensionContractException)
        {
            throw;
        }
        catch (Exception exception) when (exception is InvalidDataException or IOException or OverflowException)
        {
            throw new AuthoringExtensionContractException($"Package archive is malformed: {exception.GetType().Name}.");
        }
    }

    private static string ValidatePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 256 || path.Length != path.Trim().Length ||
            path.Contains('\\') || path.Contains(':') ||
            path.ContainsAny(['\0', '\r', '\n']) || path.StartsWith("/", StringComparison.Ordinal) ||
            path.EndsWith("/", StringComparison.Ordinal) || path.Contains("//", StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package archive path is not canonical or bounded.");
        }

        foreach (string segment in path.Split('/'))
        {
            if (segment is "" or "." or "..")
            {
                throw new AuthoringExtensionContractException("Package archive path traverses or aliases its owned root.");
            }
        }

        return path;
    }

    private static bool IsSymbolicLink(ZipArchiveEntry entry)
    {
        const int UnixFileTypeMask = 0xF000;
        const int UnixSymbolicLink = 0xA000;
        int unixMode = (entry.ExternalAttributes >> 16) & 0xFFFF;
        return (unixMode & UnixFileTypeMask) == UnixSymbolicLink;
    }

    private static async Task<byte[]> ReadExactBoundedAsync(
        ZipArchiveEntry entry,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        await using Stream source = entry.Open();
        using var destination = new MemoryStream((int)Math.Min(entry.Length, maximumBytes));
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            int read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total = checked(total + read);
            if (total > maximumBytes)
            {
                throw new AuthoringExtensionContractException("Package archive entry expanded beyond its byte bound.");
            }

            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }

        if (total != entry.Length)
        {
            throw new AuthoringExtensionContractException("Package archive entry length changed while reading.");
        }

        return destination.ToArray();
    }
}
