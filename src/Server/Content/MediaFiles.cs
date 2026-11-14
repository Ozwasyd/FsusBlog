using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Server.Content;

internal sealed class MediaFiles : IDisposable
{
    private const int FileNotFound = 2;
    private const int FileExists = 17;
    private const int WriteOnly = 1;
    private const int PrivateDirectory = 0x1c0; // 0700
    private const int ReadOnlyFile = 0x100; // 0400
    private const int LockExclusiveNonBlocking = 6;
    private static int NoFollow => OperatingSystem.IsMacOS() ? 0x100 : 0x20000;
    private static int DirectoryOnly => OperatingSystem.IsMacOS() ? 0x100000 : 0x10000;
    private static int CloseOnExec => OperatingSystem.IsMacOS() ? 0x1000000 : 0x80000;
    private static int NonBlocking => OperatingSystem.IsMacOS() ? 4 : 0x800;
    private static int ExclusiveCreate => OperatingSystem.IsMacOS() ? 0xa00 : 0xc0;
    private static int OpenDirectory => NoFollow | CloseOnExec | DirectoryOnly;

    private readonly SafeFileHandle directory;
    private int Fd => directory.DangerousGetHandle().ToInt32();

    internal MediaFiles(string path, string publicRoot)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()))
            throw new PlatformNotSupportedException("Private media requires an anchored Unix storage directory.");
        path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (path == "/" || !string.Equals(path, ResolvedPath(path), StringComparison.Ordinal))
            throw new InvalidOperationException("Private media requires an existing canonical directory without symbolic links.");
        foreach (var view in new[] { publicRoot, Path.Combine(publicRoot, "assets"), Path.Combine(publicRoot, "dist") })
        {
            if (ResolvedPath(view) is { } resolved && (Contains(path, resolved) || Contains(resolved, path)))
                throw new InvalidOperationException("Private media storage must be separate from publicly served files.");
        }
        if ((int)File.GetUnixFileMode(path) != PrivateDirectory)
            throw new InvalidOperationException("Private media storage must have Unix mode 0700.");

        directory = OpenRoot(path);
        if ((int)File.GetUnixFileMode(directory) != PrivateDirectory || Flock(Fd, LockExclusiveNonBlocking) != 0)
        {
            directory.Dispose();
            throw new InvalidOperationException("Private media storage is already in use or does not support exclusive locking.");
        }
    }

    internal async Task<byte[]?> Read(Guid id, int length, byte[] hash, CancellationToken token)
    {
        await using var file = OpenRead(Name(id));
        if (file is null) return null;
        if (!file.CanSeek || file.Length != length || length is < 1 or > MediaImage.MaxBytes)
            throw Failure("Unexpected private media file shape.");
        var bytes = GC.AllocateUninitializedArray<byte>(length);
        await file.ReadExactlyAsync(bytes, token);
        if (await file.ReadAsync(new byte[1], token) != 0 || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), hash))
            throw Failure("Private media bytes do not match their committed digest.");
        return bytes;
    }

    internal async Task Materialize(Guid id, MediaImage image, CancellationToken token)
    {
        var leaf = Name(id);
        if (await Read(id, image.Bytes.Length, image.Hash, token) is not null)
        {
            SyncRoot();
            return;
        }

        token.ThrowIfCancellationRequested();
        var temp = $".{id:N}.{Guid.NewGuid():N}.pending";
        var flags = WriteOnly | NoFollow | CloseOnExec | ExclusiveCreate;
        var fd = OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.Arm64
            ? OpenAtDarwinArm64(Fd, temp, flags, 0, 0, 0, 0, 0, ReadOnlyFile)
            : OpenAt(Fd, temp, flags, ReadOnlyFile);
        if (fd < 0) throw Failure("Could not reserve a private media file.");
        try
        {
            using (var handle = Handle(fd))
            {
                if (Chmod(fd, ReadOnlyFile) != 0) throw Failure("Could not restrict the private media file mode.");
                using var file = new FileStream(handle, FileAccess.Write);
                await file.WriteAsync(image.Bytes, token);
                file.Flush(flushToDisk: true);
            }

            token.ThrowIfCancellationRequested();
            // Establish the final leaf atomically without replacing any existing file.
            if (LinkAt(Fd, temp, Fd, leaf, 0) != 0)
            {
                if (Marshal.GetLastPInvokeError() != FileExists || await Read(id, image.Bytes.Length, image.Hash, token) is null)
                    throw Failure("Could not establish the private media file.");
            }
        }
        catch (Exception original)
        {
            try { UnlinkOwned(temp); }
            catch (Exception cleanup) { throw new AggregateException(original, cleanup); }
            throw;
        }

        UnlinkOwned(temp);
        SyncRoot();
    }

    internal async Task Delete(Guid id, int length, byte[] hash, CancellationToken token)
    {
        if (await Read(id, length, hash, token) is not null)
        {
            token.ThrowIfCancellationRequested();
            UnlinkOwned(Name(id));
        }
        SyncRoot();
    }

    public void Dispose() => directory.Dispose();

    private FileStream? OpenRead(string name)
    {
        var fd = OpenAt(Fd, name, NoFollow | NonBlocking | CloseOnExec, 0);
        if (fd < 0)
        {
            if (Marshal.GetLastPInvokeError() == FileNotFound) return null;
            throw Failure("Private media file is inaccessible.");
        }

        var handle = Handle(fd);
        try
        {
            if (OperatingSystem.IsWindows() || (int)File.GetUnixFileMode(handle) != ReadOnlyFile)
                throw Failure("Private media file permissions are unexpected.");
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    private void UnlinkOwned(string name)
    {
        if (UnlinkAt(Fd, name, 0) != 0 && Marshal.GetLastPInvokeError() != FileNotFound)
            throw Failure("Could not remove the owned private media file.");
    }

    private void SyncRoot()
    {
        if (Sync(Fd) != 0) throw Failure("Could not synchronize the private media directory.");
    }

    private static string Name(Guid id) => $"{id:N}.media";
    private static SafeFileHandle Handle(int file) => new((nint)file, ownsHandle: true);
    private static IOException Failure(string message) => new(message);

    private static SafeFileHandle OpenRoot(string path)
    {
        var current = Handle(Open("/", OpenDirectory));
        if (current.IsInvalid) { current.Dispose(); throw Failure("Could not open the Unix root."); }
        try
        {
            foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                var next = OpenAt(current.DangerousGetHandle().ToInt32(), part, OpenDirectory, 0);
                if (next < 0) throw Failure("Could not open the anchored private media directory.");
                current.Dispose();
                current = Handle(next);
            }
            return current;
        }
        catch { current.Dispose(); throw; }
    }

    private static bool Contains(string parent, string child)
    {
        var relative = Path.GetRelativePath(parent, child);
        return !Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith("../", StringComparison.Ordinal);
    }

    private static string? ResolvedPath(string path)
    {
        var pointer = ResolvePath(path, 0);
        if (pointer == 0) return null;
        try { return Marshal.PtrToStringUTF8(pointer); }
        finally { Free(pointer); }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mode);
    // Darwin arm64's first variadic argument is on the stack. Fill the unused argument registers so mode is placed there.
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAtDarwinArm64(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags,
        uint register3, uint register4, uint register5, uint register6, uint register7, uint mode);
    [DllImport("libc", EntryPoint = "linkat", SetLastError = true)]
    private static extern int LinkAt(int source, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int target,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string leaf, int flags);
    [DllImport("libc", EntryPoint = "unlinkat", SetLastError = true)]
    private static extern int UnlinkAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "realpath")]
    private static extern nint ResolvePath([MarshalAs(UnmanagedType.LPUTF8Str)] string path, nint result);
    [DllImport("libc", EntryPoint = "free")]
    private static extern void Free(nint memory);
    [DllImport("libc", EntryPoint = "flock", SetLastError = true)]
    private static extern int Flock(int file, int operation);
    [DllImport("libc", EntryPoint = "fchmod", SetLastError = true)]
    private static extern int Chmod(int file, uint mode);
    [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
    private static extern int Sync(int descriptor);
}
