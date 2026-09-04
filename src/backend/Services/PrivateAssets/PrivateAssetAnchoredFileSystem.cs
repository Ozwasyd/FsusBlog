using System.ComponentModel;
using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Services.PrivateAssets;

internal sealed partial class PrivateAssetAnchoredFileSystem
{
    private const int OpenReadOnly = 0;
    private const int OpenWriteOnly = 1;
    private const int OpenReadWrite = 2;
    private const int OpenCreate = 0x40;
    private const int OpenExclusive = 0x80;
    private const int OpenCloseOnExec = 0x80000;
    private const int OpenDirectory = 0x10000;
    private const int OpenNoFollow = 0x20000;
    private const int OpenTemporaryFile = 0x410000;
    private const uint DirectoryMode = 0x1C0;
    private const uint FilePermissionMode = 0x180;
    private const int AlreadyExists = 17;
    private const int NotFound = 2;
    private const int NotDirectory = 20;
    private const int TooManySymbolicLinks = 40;
    private const int AtEmptyPath = 0x1000;
    private const int AtCurrentWorkingDirectory = -100;
    private const int AtFollowSymbolicLink = 0x400;
    private const uint StatxBasicStats = 0x7FF;
    private readonly string _privateRoot;
    private readonly string _commitRoot;

    public PrivateAssetAnchoredFileSystem(string privateRoot, string commitRoot)
    {
        _privateRoot = privateRoot;
        _commitRoot = commitRoot;
        if (OperatingSystem.IsLinux())
        {
            using SafeFileHandle privateDirectory = OpenDirectoryHandle(_privateRoot);
            using SafeFileHandle commitDirectory = OpenDirectoryHandle(_commitRoot);
            using SafeFileHandle tempDirectory = OpenOrCreateDirectory(commitDirectory, "private-assets");
            VerifySameFileSystem(privateDirectory, tempDirectory);
        }
    }

    public AnchoredTemporaryFile CreateTemporary()
    {
        if (!OperatingSystem.IsLinux())
        {
            string fallbackDirectory = Path.Combine(_commitRoot, "private-assets");
            EnsureRestrictedDirectoryFallback(fallbackDirectory);
            string path = Path.Combine(fallbackDirectory, $"{Guid.NewGuid():N}.tmp");
            return new AnchoredTemporaryFile(Path.GetFileName(path), path, new FileStream(path, CreateWriteOptions()));
        }

        using SafeFileHandle root = OpenDirectoryHandle(_commitRoot);
        using SafeFileHandle directory = OpenOrCreateDirectory(root, "private-assets");
        int descriptor = OpenAt(
            FileDescriptor(directory),
            ".",
            OpenReadWrite | OpenTemporaryFile | OpenCloseOnExec,
            FilePermissionMode);
        if (descriptor < 0)
        {
            throw FileSystemFailure("private_asset_temp_create_failed");
        }

        var handle = new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
        try
        {
            RequireMode(handle, FilePermissionMode, "private_asset_file_mode_rejected");
            return new AnchoredTemporaryFile(
                string.Empty,
                null,
                new FileStream(handle, FileAccess.Write, 128 * 1024, isAsync: false));
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public void Commit(AnchoredTemporaryFile temporary, string storageKey)
    {
        if (!OperatingSystem.IsLinux())
        {
            string finalPath = ResolveFallback(storageKey);
            Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);
            File.Move(temporary.FallbackPath!, finalPath, overwrite: false);
            EnsureRestrictedFileFallback(finalPath);
            return;
        }

        using SafeFileHandle finalDirectory = OpenStorageParent(storageKey, create: true, out string fileName);
        string descriptorPath = $"/proc/self/fd/{FileDescriptor(temporary.Stream.SafeFileHandle)}";
        if (LinkAt(
                AtCurrentWorkingDirectory,
                descriptorPath,
                FileDescriptor(finalDirectory),
                fileName,
                AtFollowSymbolicLink) != 0)
        {
            throw FileSystemFailure("private_asset_commit_publish_failed");
        }
    }

    public FileStream? TryOpenRead(string storageKey)
    {
        if (!OperatingSystem.IsLinux())
        {
            try
            {
                return OpenFallbackNoFollow(ResolveFallback(storageKey));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        SafeFileHandle directory;
        string fileName;
        try
        {
            directory = OpenStorageParent(storageKey, create: false, out fileName);
        }
        catch (IOException exception) when (IsNotFound(exception))
        {
            return null;
        }

        using (directory)
        {
            int descriptor = OpenAt(
                FileDescriptor(directory),
                fileName,
                OpenReadOnly | OpenCloseOnExec | OpenNoFollow,
                0);
            if (descriptor < 0)
            {
                int error = Marshal.GetLastPInvokeError();
                if (error == NotFound)
                {
                    return null;
                }

                throw FileSystemFailure("private_asset_nofollow_open_failed", error);
            }

            var handle = new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
            try
            {
                return new FileStream(handle, FileAccess.Read, 128 * 1024, isAsync: false);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
    }

    public void Delete(string storageKey)
    {
        if (!OperatingSystem.IsLinux())
        {
            File.Delete(ResolveFallback(storageKey));
            return;
        }

        SafeFileHandle directory;
        string fileName;
        try
        {
            directory = OpenStorageParent(storageKey, create: false, out fileName);
        }
        catch (IOException exception) when (IsNotFound(exception))
        {
            return;
        }

        using (directory)
        {
            if (UnlinkAt(FileDescriptor(directory), fileName, 0) == 0
                || Marshal.GetLastPInvokeError() == NotFound)
            {
                return;
            }

            throw FileSystemFailure("private_asset_delete_failed");
        }
    }

    public void MoveToCleanup(string storageKey, string cleanupName)
    {
        if (!OperatingSystem.IsLinux())
        {
            string finalPath = ResolveFallback(storageKey);
            string cleanupRoot = Path.Combine(_commitRoot, "private-assets");
            EnsureRestrictedDirectoryFallback(cleanupRoot);
            File.Move(finalPath, Path.Combine(cleanupRoot, cleanupName), overwrite: false);
            return;
        }

        using SafeFileHandle finalDirectory = OpenStorageParent(storageKey, create: false, out string fileName);
        using SafeFileHandle commitRoot = OpenDirectoryHandle(_commitRoot);
        using SafeFileHandle cleanupDirectory = OpenOrCreateDirectory(commitRoot, "private-assets");
        if (RenameAt(
                FileDescriptor(finalDirectory),
                fileName,
                FileDescriptor(cleanupDirectory),
                cleanupName) != 0)
        {
            throw FileSystemFailure("private_asset_quarantine_failed");
        }
    }

    public void TryDeleteTemporary(string temporaryName, string? fallbackPath)
    {
        try
        {
            if (!OperatingSystem.IsLinux())
            {
                File.Delete(fallbackPath!);
            }
        }
        catch (IOException)
        {
        }
    }

    private SafeFileHandle OpenStorageParent(string storageKey, bool create, out string fileName)
    {
        string[] segments = storageKey.Split('/');
        if (segments.Length < 2)
        {
            throw new IOException("private_asset_storage_key_invalid");
        }

        SafeFileHandle current = OpenDirectoryHandle(_privateRoot);
        try
        {
            for (int index = 0; index < segments.Length - 1; index++)
            {
                SafeFileHandle next = create
                    ? OpenOrCreateDirectory(current, segments[index])
                    : OpenDirectoryAt(current, segments[index]);
                current.Dispose();
                current = next;
            }

            fileName = segments[^1];
            return current;
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    private static SafeFileHandle OpenDirectoryHandle(string path)
    {
        int descriptor = Open(path, OpenReadOnly | OpenDirectory | OpenNoFollow | OpenCloseOnExec);
        if (descriptor < 0)
        {
            throw FileSystemFailure("private_asset_root_open_failed");
        }

        return new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
    }

    private static SafeFileHandle OpenDirectoryAt(SafeFileHandle parent, string name)
    {
        int descriptor = OpenAt(
            FileDescriptor(parent),
            name,
            OpenReadOnly | OpenDirectory | OpenNoFollow | OpenCloseOnExec,
            0);
        if (descriptor < 0)
        {
            throw FileSystemFailure("private_asset_parent_open_failed");
        }

        return new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
    }

    private static SafeFileHandle OpenOrCreateDirectory(SafeFileHandle parent, string name)
    {
        int descriptor = OpenAt(
            FileDescriptor(parent),
            name,
            OpenReadOnly | OpenDirectory | OpenNoFollow | OpenCloseOnExec,
            0);
        if (descriptor < 0)
        {
            int error = Marshal.GetLastPInvokeError();
            if (error != NotFound
                || MkdirAt(FileDescriptor(parent), name, DirectoryMode) != 0
                    && Marshal.GetLastPInvokeError() != AlreadyExists)
            {
                throw FileSystemFailure("private_asset_parent_create_failed", error);
            }

            descriptor = OpenAt(
                FileDescriptor(parent),
                name,
                OpenReadOnly | OpenDirectory | OpenNoFollow | OpenCloseOnExec,
                0);
            if (descriptor < 0)
            {
                throw FileSystemFailure("private_asset_parent_open_failed");
            }
        }

        var handle = new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
        try
        {
            RequireMode(handle, DirectoryMode, "private_asset_directory_mode_rejected");
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void VerifySameFileSystem(SafeFileHandle privateDirectory, SafeFileHandle tempDirectory)
    {
        if (Statx(
                FileDescriptor(privateDirectory),
                string.Empty,
                AtEmptyPath,
                StatxBasicStats,
                out LinuxStatx privateStat) != 0
            || Statx(
                FileDescriptor(tempDirectory),
                string.Empty,
                AtEmptyPath,
                StatxBasicStats,
                out LinuxStatx tempStat) != 0)
        {
            throw FileSystemFailure("private_asset_device_identity_failed");
        }

        if (privateStat.DeviceMajor != tempStat.DeviceMajor
            || privateStat.DeviceMinor != tempStat.DeviceMinor)
        {
            throw new InvalidOperationException("private_asset_roots_cross_device");
        }
    }

    private static void RequireMode(SafeFileHandle handle, uint mode, string error)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException();
        }

        if (Fchmod(FileDescriptor(handle), mode) != 0)
        {
            throw FileSystemFailure(error);
        }

        UnixFileMode actual = File.GetUnixFileMode($"/proc/self/fd/{FileDescriptor(handle)}");
        if ((uint)actual != mode)
        {
            throw new UnauthorizedAccessException(error);
        }
    }

    private static int FileDescriptor(SafeFileHandle handle)
        => checked((int)handle.DangerousGetHandle());

    private string ResolveFallback(string storageKey)
    {
        string candidate = Path.GetFullPath(Path.Combine(
            _privateRoot,
            storageKey.Replace('/', Path.DirectorySeparatorChar)));
        string relative = Path.GetRelativePath(_privateRoot, candidate);
        if (Path.IsPathRooted(relative) || relative.StartsWith("..", StringComparison.Ordinal))
        {
            throw new IOException("private_asset_storage_boundary_rejected");
        }

        return candidate;
    }

    private static IOException FileSystemFailure(string message, int? error = null)
        => new(message, new Win32Exception(error ?? Marshal.GetLastPInvokeError()));

    private static bool IsNotFound(IOException exception)
        => exception.InnerException is Win32Exception { NativeErrorCode: NotFound };

    internal static bool IsUnsafeTraversal(IOException exception)
        => exception.InnerException is Win32Exception
        {
            NativeErrorCode: NotDirectory or TooManySymbolicLinks
        };

    private static FileStream OpenFallbackNoFollow(string path)
    {
        if (new FileInfo(path).LinkTarget is not null)
        {
            throw new IOException("private_asset_symlink_rejected");
        }

        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    }

    private static FileStreamOptions CreateWriteOptions()
    {
        var options = new FileStreamOptions
        {
            Mode = System.IO.FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return options;
    }

    private static void EnsureRestrictedDirectoryFallback(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    private static void EnsureRestrictedFileFallback(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [LibraryImport("libc", EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int OpenAt(int directory, string path, int flags, uint mode);

    [LibraryImport("libc", EntryPoint = "mkdirat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int MkdirAt(int directory, string path, uint mode);

    [LibraryImport("libc", EntryPoint = "renameat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int RenameAt(int oldDirectory, string oldPath, int newDirectory, string newPath);

    [LibraryImport("libc", EntryPoint = "linkat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int LinkAt(int oldDirectory, string oldPath, int newDirectory, string newPath, int flags);

    [LibraryImport("libc", EntryPoint = "unlinkat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int UnlinkAt(int directory, string path, int flags);

    [LibraryImport("libc", EntryPoint = "fchmod", SetLastError = true)]
    private static partial int Fchmod(int descriptor, uint mode);

    [LibraryImport("libc", EntryPoint = "statx", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Statx(
        int directory,
        string path,
        int flags,
        uint mask,
        out LinuxStatx stat);

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct LinuxStatx
    {
        public uint Mask;
        public uint BlockSize;
        public ulong Attributes;
        public uint LinkCount;
        public uint UserId;
        public uint GroupId;
        public ushort Mode;
        public ushort Padding;
        public ulong Inode;
        public ulong Size;
        public ulong Blocks;
        public ulong AttributesMask;
        public LinuxStatxTimestamp AccessTime;
        public LinuxStatxTimestamp BirthTime;
        public LinuxStatxTimestamp ChangeTime;
        public LinuxStatxTimestamp ModifyTime;
        public uint RdevMajor;
        public uint RdevMinor;
        public uint DeviceMajor;
        public uint DeviceMinor;
        public ulong MountId;
        public uint DirectIoMemoryAlign;
        public uint DirectIoOffsetAlign;
        public ulong Subvolume;
        public uint AtomicWriteUnitMin;
        public uint AtomicWriteUnitMax;
        public uint AtomicWriteSegmentsMax;
        public uint AtomicWriteUnitMaxOptimal;
        public fixed ulong Spare[9];
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LinuxStatxTimestamp
    {
        public long Seconds;
        public uint Nanoseconds;
        public int Reserved;
    }
}

internal sealed record AnchoredTemporaryFile(string Name, string? FallbackPath, FileStream Stream) : IAsyncDisposable
{
    public ValueTask DisposeAsync() => Stream.DisposeAsync();
}
