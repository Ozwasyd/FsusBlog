using System.IO.Compression;
using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.Themes;

public interface IThemePackageStore
{
    Task<ThemePackageStoreReceipt> StoreAsync(
        ValidatedThemePackage package,
        CancellationToken cancellationToken);

    Task DeleteAsync(string location, CancellationToken cancellationToken);
}

public sealed class InMemoryThemePackageStore : IThemePackageStore
{
    private readonly Dictionary<string, byte[]> _packages = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public Task<ThemePackageStoreReceipt> StoreAsync(
        ValidatedThemePackage package,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string location = $"memory://themes/{package.Manifest.Id}/{package.PackageHash}.fstheme";
        lock (_gate)
        {
            bool created = !_packages.ContainsKey(location);
            _packages[location] = package.PackageBytes.ToArray();
            return Task.FromResult(new ThemePackageStoreReceipt(location, created));
        }
    }

    public Task DeleteAsync(string location, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _packages.Remove(location);
        }

        return Task.CompletedTask;
    }
}

public sealed class LocalThemePackageStore : IThemePackageStore
{
    private const string PackageFileName = "archive.fstheme";
    private const string ContentDirectoryName = "content";

    private readonly string _rootPath;

    public LocalThemePackageStore(string rootPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        _rootPath = Path.GetFullPath(rootPath);
    }

    public async Task<ThemePackageStoreReceipt> StoreAsync(
        ValidatedThemePackage package,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        cancellationToken.ThrowIfCancellationRequested();
        string actualPackageHash = Convert.ToHexStringLower(SHA256.HashData(package.PackageBytes.Span));
        if (!string.Equals(actualPackageHash, package.PackageHash, StringComparison.Ordinal))
        {
            throw new ThemePackageException(
                "theme_package_store_hash_mismatch",
                "Theme package bytes do not match the validated package hash.");
        }

        string themeRoot = Path.Combine(_rootPath, package.Manifest.Id);
        string finalPath = Path.Combine(themeRoot, package.PackageHash);
        string packagePath = Path.Combine(finalPath, PackageFileName);
        if (File.Exists(packagePath))
        {
            return new ThemePackageStoreReceipt(finalPath, Created: false);
        }

        Directory.CreateDirectory(themeRoot);
        string stagingPath = Path.Combine(
            themeRoot,
            $".staging-{package.PackageHash}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(stagingPath);
        try
        {
            string stagingPackagePath = Path.Combine(stagingPath, PackageFileName);
            await File.WriteAllBytesAsync(
                stagingPackagePath,
                package.PackageBytes.ToArray(),
                cancellationToken).ConfigureAwait(false);
            using var archive = new ZipArchive(
                new MemoryStream(package.PackageBytes.ToArray(), writable: false),
                ZipArchiveMode.Read,
                leaveOpen: false);
            string contentPath = Path.Combine(stagingPath, ContentDirectoryName);
            Directory.CreateDirectory(contentPath);
            foreach (ThemePackageEntry expected in package.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ZipArchiveEntry entry = archive.GetEntry(expected.Path)
                    ?? throw new ThemePackageException(
                        "theme_package_store_entry_missing",
                        $"Validated package entry '{expected.Path}' disappeared before storage.");
                string destinationPath = ResolveDestination(contentPath, expected.Path);
                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                await using Stream source = entry.Open();
                await using var destination = new FileStream(
                    destinationPath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    bufferSize: 81920,
                    FileOptions.Asynchronous | FileOptions.WriteThrough);
                await CopyAndVerifyEntryAsync(
                    source,
                    destination,
                    expected,
                    cancellationToken).ConfigureAwait(false);
                await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            try
            {
                Directory.Move(stagingPath, finalPath);
                return new ThemePackageStoreReceipt(finalPath, Created: true);
            }
            catch (IOException) when (File.Exists(packagePath))
            {
                Directory.Delete(stagingPath, recursive: true);
                return new ThemePackageStoreReceipt(finalPath, Created: false);
            }
        }
        catch
        {
            if (Directory.Exists(stagingPath))
            {
                Directory.Delete(stagingPath, recursive: true);
            }

            throw;
        }
    }

    public Task DeleteAsync(string location, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string fullPath = Path.GetFullPath(location);
        string rootPrefix = _rootPath.EndsWith(
            Path.DirectorySeparatorChar)
            ? _rootPath
            : _rootPath + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootPrefix, StringComparison.Ordinal))
        {
            throw new ThemeLifecycleException(
                "theme_package_store_location_invalid",
                "Theme package location is outside the configured store root.");
        }

        if (Directory.Exists(fullPath))
        {
            Directory.Delete(fullPath, recursive: true);
        }

        return Task.CompletedTask;
    }

    private static async Task CopyAndVerifyEntryAsync(
        Stream source,
        Stream destination,
        ThemePackageEntry expected,
        CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long sizeBytes = 0;
        while (true)
        {
            int read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            sizeBytes += read;
            hash.AppendData(buffer, 0, read);
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }

        string contentHash = Convert.ToHexStringLower(hash.GetHashAndReset());
        if (sizeBytes != expected.SizeBytes
            || !string.Equals(contentHash, expected.ContentHash, StringComparison.Ordinal))
        {
            throw new ThemePackageException(
                "theme_package_store_entry_mismatch",
                $"Theme package entry '{expected.Path}' changed after validation.");
        }
    }

    private static string ResolveDestination(string contentPath, string entryPath)
    {
        string destination = Path.GetFullPath(
            Path.Combine(contentPath, entryPath.Replace('/', Path.DirectorySeparatorChar)));
        string contentPrefix = contentPath.EndsWith(Path.DirectorySeparatorChar)
            ? contentPath
            : contentPath + Path.DirectorySeparatorChar;
        if (!destination.StartsWith(contentPrefix, StringComparison.Ordinal))
        {
            throw new ThemePackageException(
                "theme_package_store_path_invalid",
                $"Theme package entry '{entryPath}' escapes the staging directory.");
        }

        return destination;
    }
}
