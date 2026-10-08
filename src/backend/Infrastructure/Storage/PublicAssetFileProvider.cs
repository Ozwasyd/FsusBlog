using System.Runtime.InteropServices;

using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Infrastructure.Storage;

/// <summary>
/// Supplies only regular files below the illustration root. Directory contents
/// are never enumerated. Linux stream opening walks anchored no-follow handles.
/// </summary>
internal sealed partial class PublicAssetFileProvider(string root) : IFileProvider
{
    private const int OpenDirectory = 0x10000;
    private const int OpenNoFollow = 0x20000;
    private const int OpenCloseOnExec = 0x80000;
    private const int OpenNonBlocking = 0x800;
    private readonly string _root = Path.GetFullPath(root);

    public IFileInfo GetFileInfo(string subpath)
    {
        string key = subpath.TrimStart('/');
        if (key.Length == 0 || key.IndexOfAny(['\\', '%', '\0', ':']) >= 0
            || key.Split('/').Any(static segment => segment.Length == 0 || segment.StartsWith(".", StringComparison.Ordinal)))
        {
            return new NotFoundFileInfo(key);
        }
        string path = Path.Combine(_root, key.Replace('/', Path.DirectorySeparatorChar));
        if (HasLink(path))
        {
            return new NotFoundFileInfo(key);
        }
        var info = new FileInfo(path);
        return info.Exists && (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0
            ? new GuardedFileInfo(_root, key, info)
            : new NotFoundFileInfo(key);
    }

    public IDirectoryContents GetDirectoryContents(string subpath) => NotFoundDirectoryContents.Singleton;

    public IChangeToken Watch(string filter) => NullChangeToken.Singleton;

    private static bool HasLink(string path)
    {
        for (FileSystemInfo? current = new FileInfo(path); current is not null; current = current switch
        {
            FileInfo file => file.Directory,
            DirectoryInfo directory => directory.Parent,
            _ => null
        })
        {
            if (current.LinkTarget is not null || (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0))
            {
                return true;
            }
        }
        return false;
    }

    private sealed class GuardedFileInfo(string root, string key, FileInfo info) : IFileInfo
    {
        public bool Exists => true;
        public long Length => info.Length;
        public string? PhysicalPath => null;
        public string Name => info.Name;
        public DateTimeOffset LastModified => info.LastWriteTimeUtc;
        public bool IsDirectory => false;

        public Stream CreateReadStream()
        {
            if (!OperatingSystem.IsLinux())
            {
                if (HasLink(info.FullName))
                {
                    throw new IOException("public_asset_link_rejected");
                }
                return new FileStream(info.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
            }
            SafeFileHandle directory = Handle(Open(root, OpenDirectory | OpenNoFollow | OpenCloseOnExec));
            try
            {
                string[] segments = key.Split('/');
                foreach (string segment in segments[..^1])
                {
                    SafeFileHandle next = Handle(OpenAt(directory, segment, OpenDirectory | OpenNoFollow | OpenCloseOnExec));
                    directory.Dispose();
                    directory = next;
                }
                SafeFileHandle file = Handle(OpenAt(directory, segments[^1], OpenNoFollow | OpenCloseOnExec | OpenNonBlocking));
                try
                {
                    return new FileStream(file, FileAccess.Read, 1, isAsync: false);
                }
                catch
                {
                    file.Dispose();
                    throw;
                }
            }
            finally
            {
                directory.Dispose();
            }
        }

        private static SafeFileHandle Handle(int descriptor)
            => descriptor >= 0 ? new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true)
                : throw new IOException("public_asset_nofollow_open_failed");
    }

    [LibraryImport("libc", EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int OpenAt(SafeFileHandle directory, string name, int flags);
}
