using System.Runtime.InteropServices;
using FsusBlog.V2.Core.Extensions;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Platform.Extensions;

internal static class ExtensionDisk
{
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode ImmutableFile = UnixFileMode.UserRead;
    internal readonly record struct Stamp(NativeUnixFile.ChangeStamp Directory, NativeUnixFile.ChangeStamp File);

    internal static string ValidatePrivateRoot(DirectoryInfo root)
    {
        if (!NativeUnixFile.Supported) throw new PlatformNotSupportedException();
        if (!root.Exists) throw Reject("private-root-unavailable");
        for (DirectoryInfo? component = root; component is not null; component = component.Parent)
        {
            if ((component.Attributes & FileAttributes.ReparsePoint) != 0) throw Reject("private-root-link");
        }
        using var directory = NativeUnixFile.OpenDirectory(root.FullName);
        if (!NativeUnixFile.HasMode(directory, PrivateDirectory, owned: true)) throw Reject("private-root-mode");
        return root.FullName;
    }

    internal static byte[] Read(string root, string name, int limit, CancellationToken cancellationToken) =>
        Read(root, name, limit, cancellationToken, stampChanges: false, out _);

    internal static byte[] ReadStamped(string root, string name, int limit, CancellationToken cancellationToken, out Stamp stamp) =>
        Read(root, name, limit, cancellationToken, stampChanges: true, out stamp);

    private static byte[] Read(string root, string name, int limit, CancellationToken cancellationToken, bool stampChanges, out Stamp stamp)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var directory = NativeUnixFile.OpenDirectory(root);
        var directoryStamp = stampChanges ? NativeUnixFile.InspectChanges(directory) : default;
        if (!NativeUnixFile.HasMode(directory, PrivateDirectory, owned: true)) throw Reject("private-root-mode");
        using var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out var error);
        if (handle is null)
        {
            if (error == NativeUnixFile.NotFound) throw new FileNotFoundException("The installed file is unavailable.", Path.Combine(root, name));
            throw Reject("installed-file-shape");
        }
        var fileStamp = stampChanges ? NativeUnixFile.InspectChanges(handle) : default;
        if (!NativeUnixFile.IsRegular(handle)) throw Reject("installed-file-size");
        if (!NativeUnixFile.HasMode(handle, ImmutableFile, owned: true)) throw Reject("installed-file-shape");
        using var file = new FileStream(handle, FileAccess.Read);
        if (!file.CanSeek || file.Length is < 1 || file.Length > limit) throw Reject("installed-file-size");
        var bytes = new byte[checked((int)file.Length)];
        for (var offset = 0; offset < bytes.Length;)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = file.Read(bytes.AsSpan(offset, Math.Min(64 * 1024, bytes.Length - offset)));
            if (read == 0) throw Reject("installed-file-size");
            offset += read;
        }
        if (file.ReadByte() != -1) throw Reject("installed-file-size");
        if (stampChanges && (fileStamp != NativeUnixFile.InspectChanges(handle) || directoryStamp != NativeUnixFile.InspectChanges(directory)))
            throw Reject("installed-file-changed");
        stamp = new(directoryStamp, fileStamp);
        cancellationToken.ThrowIfCancellationRequested();
        return bytes;
    }

    internal static void Publish(string root, string name, ReadOnlySpan<byte> bytes, bool overwrite)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var destination = Path.Combine(root, name);
        var pending = Path.Combine(root, $".{Guid.NewGuid():N}.pending");
        var owned = false;
        try
        {
            using (var file = new FileStream(pending, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                UnixCreateMode = ImmutableFile
            }))
            {
                owned = true;
                file.Write(bytes);
                file.Flush(flushToDisk: true);
            }
            File.Move(pending, destination, overwrite);
            owned = false;
            FlushRoot(root);
        }
        catch (Exception error)
        {
            if (owned)
            {
                try { File.Delete(pending); }
                catch (Exception cleanup) { throw new AggregateException(error, cleanup); }
            }
            throw;
        }
    }

    private static void FlushRoot(string root)
    {
        // The private root has already been checked. O_RDONLY is 0 on both target systems.
        var descriptor = Open(root, 0);
        if (descriptor < 0) throw Reject("extension-directory-flush");
        var synced = Sync(descriptor);
        if (Close(descriptor) != 0 || synced != 0) throw Reject("extension-directory-flush");
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "fsync")]
    private static extern int Sync(int descriptor);

    [DllImport("libc", EntryPoint = "close")]
    private static extern int Close(int descriptor);

    private static ExtensionRejectedException Reject(string code) => new(code);
}
