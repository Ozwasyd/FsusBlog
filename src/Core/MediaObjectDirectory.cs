using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Core;

internal sealed class MediaObjectDirectory : IDisposable
{
    private const int FileNotFound = 2;
    private const int FileExists = 17;
    private const int WriteOnly = 1;
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode ReadOnlyFile = UnixFileMode.UserRead;
    private const int LockExclusiveNonBlocking = 6;
    private static int ExclusiveCreate => OperatingSystem.IsMacOS() ? 0xa00 : 0xc0;

    private readonly SafeFileHandle directory;
    private readonly int maximumBytes;
    internal string Root { get; }
    private int Fd => directory.DangerousGetHandle().ToInt32();

    internal MediaObjectDirectory(string path, int maximumBytes, IEnumerable<string> forbiddenRoots)
    {
        if (!NativeUnixFile.Supported)
            throw new PlatformNotSupportedException("Media requires an anchored Unix storage directory.");
        path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (path == "/" || !string.Equals(path, ResolvedPath(path), StringComparison.Ordinal))
            throw new InvalidOperationException("Media requires an existing canonical directory without symbolic links.");
        foreach (var view in forbiddenRoots)
        {
            var resolved = ResolvedPath(view) ?? Path.TrimEndingDirectorySeparator(Path.GetFullPath(view));
            if (Contains(path, resolved) || Contains(resolved, path))
                throw new InvalidOperationException("Media storage roots must be separate.");
        }
        Root = path;
        this.maximumBytes = maximumBytes;
        directory = NativeUnixFile.OpenDirectory(path);
        try
        {
            if (!NativeUnixFile.HasMode(directory, PrivateDirectory, owned: true))
                throw new InvalidOperationException("Media storage must have Unix mode 0700 and be process-owned.");
            if (Flock(Fd, LockExclusiveNonBlocking) != 0)
                throw new InvalidOperationException("Media storage is already in use or does not support exclusive locking.");
        }
        catch { directory.Dispose(); throw; }
    }

    internal async Task<byte[]?> Read(string leaf, int length, byte[] hash, CancellationToken token)
    {
        if (length < 1 || length > maximumBytes || hash.Length != 32)
            throw Failure("Invalid expected media length or digest.");
        await using var file = OpenRead(leaf);
        if (file is null) return null;
        if (!file.CanSeek || file.Length != length)
            throw Failure("Unexpected media file shape.");
        var bytes = GC.AllocateUninitializedArray<byte>(length);
        await file.ReadExactlyAsync(bytes, token);
        if (await file.ReadAsync(new byte[1], token) != 0 || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), hash))
            throw Failure("Media bytes do not match their committed digest.");
        return bytes;
    }

    internal async Task Materialize(string leaf, ReadOnlyMemory<byte> bytes, byte[] hash, CancellationToken token)
    {
        if (await Read(leaf, bytes.Length, hash, token) is not null)
        {
            SyncRoot();
            return;
        }

        token.ThrowIfCancellationRequested();
        var temp = $".{Path.GetFileNameWithoutExtension(leaf)}.{Guid.NewGuid():N}.pending";
        var flags = WriteOnly | NativeUnixFile.NoFollow | NativeUnixFile.CloseOnExec | ExclusiveCreate;
        var fd = OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.Arm64
            ? OpenAtDarwinArm64(Fd, temp, flags, 0, 0, 0, 0, 0, (uint)ReadOnlyFile)
            : OpenAt(Fd, temp, flags, (uint)ReadOnlyFile);
        if (fd < 0) throw Failure("Could not reserve a media file.");
        try
        {
            using (var handle = Handle(fd))
            {
                if (Chmod(fd, (uint)ReadOnlyFile) != 0) throw Failure("Could not restrict the media file mode.");
                using var file = new FileStream(handle, FileAccess.Write);
                await file.WriteAsync(bytes, token);
                file.Flush(flushToDisk: true);
            }

            token.ThrowIfCancellationRequested();
            // Establish the final leaf atomically without replacing any existing file.
            if (LinkAt(Fd, temp, Fd, leaf, 0) != 0)
            {
                if (Marshal.GetLastPInvokeError() != FileExists || await Read(leaf, bytes.Length, hash, token) is null)
                    throw Failure("Could not establish the media file.");
            }
        }
        catch (Exception original)
        {
            try
            {
                UnlinkOwned(temp);
                SyncRoot();
            }
            catch (Exception cleanup) { throw new AggregateException(original, cleanup); }
            throw;
        }

        UnlinkOwned(temp);
        SyncRoot();
    }

    internal async Task Delete(string leaf, int length, byte[] hash, CancellationToken token)
    {
        if (await Read(leaf, length, hash, token) is not null)
        {
            token.ThrowIfCancellationRequested();
            UnlinkOwned(leaf);
        }
        SyncRoot();
    }

    public void Dispose() => directory.Dispose();

    private FileStream? OpenRead(string name)
    {
        var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out var error);
        if (handle is null)
        {
            if (error == FileNotFound) return null;
            throw Failure("Media file is inaccessible.");
        }

        try
        {
            if (!NativeUnixFile.IsRegular(handle, ReadOnlyFile, owned: true))
                throw Failure("Media file permissions are unexpected.");
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    private void UnlinkOwned(string name)
    {
        if (UnlinkAt(Fd, name, 0) != 0 && Marshal.GetLastPInvokeError() != FileNotFound)
            throw Failure("Could not remove the owned media file.");
    }

    private void SyncRoot()
    {
        if (Sync(Fd) != 0) throw Failure("Could not synchronize the media directory.");
    }

    private static SafeFileHandle Handle(int file) => new((nint)file, ownsHandle: true);
    private static IOException Failure(string message) => new(message);

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
