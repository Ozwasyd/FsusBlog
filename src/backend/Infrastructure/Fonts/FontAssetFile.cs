using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Algorithms.IO;

namespace FsusBlog.Server.Infrastructure.Fonts;

/// <summary>
/// Adapts the shared native regular-file owner to registry-owned font assets.
/// Font byte budgets and hash verification remain with LocalFontRegistry.
/// </summary>
internal sealed class FontAssetFile : IDisposable
{
    private readonly string _path;
    private readonly NativeRegularFileGuard.OriginalRegularFileIdentity _identity;

    private FontAssetFile(string path, FileStream stream,
        NativeRegularFileGuard.OriginalRegularFileIdentity identity)
    {
        _path = path;
        Stream = stream;
        _identity = identity;
    }

    internal FileStream Stream
    {
        get;
    }

    internal static FontAssetFile Open(string root, string contentHash, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new FontRegistryException("font_byte_platform_unsupported", "Anchored font byte reads require Linux x64 or Arm64.");
        }

        string path = Path.Combine(root, "assets", $"{contentHash}.woff2");
        try
        {
            SafeFileHandle handle = NativeRegularFileGuard.OpenOriginalRegularFile(path, cancellationToken);
            try
            {
                NativeRegularFileGuard.OriginalRegularFileIdentity identity =
                    NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
                return new FontAssetFile(path, new FileStream(handle, FileAccess.Read, 16 * 1024, isAsync: false), identity);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        catch (InvalidOperationException exception)
        {
            throw new IOException("Owned font asset admission failed.", exception);
        }
    }

    internal void ValidateUnchanged(CancellationToken cancellationToken = default)
    {
        try
        {
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(_path, Stream.SafeFileHandle, _identity, cancellationToken);
        }
        catch (InvalidOperationException exception)
        {
            throw new IOException("Owned font asset changed during the byte read.", exception);
        }
    }

    public void Dispose() => Stream.Dispose();
}
