using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Core.Extensions;

internal static class ExtensionDisk
{
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode ImmutableFile = UnixFileMode.UserRead;

    internal static string ValidatePrivateRoot(DirectoryInfo root)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()))
            throw new PlatformNotSupportedException();
        if (!root.Exists) throw Reject("private-root-unavailable");
        for (DirectoryInfo? component = root; component is not null; component = component.Parent)
        {
            if ((component.Attributes & FileAttributes.ReparsePoint) != 0) throw Reject("private-root-link");
        }
        if (File.GetUnixFileMode(root.FullName) != PrivateDirectory) throw Reject("private-root-mode");
        return root.FullName;
    }

    internal static byte[] Read(string root, string name, int limit, CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()))
            throw new PlatformNotSupportedException();
        cancellationToken.ThrowIfCancellationRequested();
        var path = Path.Combine(root, name);
        if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0 ||
            File.GetUnixFileMode(path) != ImmutableFile) throw Reject("installed-file-shape");

        const int macFlags = 0x1000000 | 0x100 | 0x4; // O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        const int linuxFlags = 0x80000 | 0x20000 | 0x800;
        var descriptor = Open(path, OperatingSystem.IsMacOS() ? macFlags : linuxFlags);
        if (descriptor < 0)
        {
            if (Marshal.GetLastPInvokeError() == 2) throw new FileNotFoundException("The installed file is unavailable.", path);
            throw Reject("installed-file-shape");
        }
        using var handle = new SafeFileHandle(descriptor, ownsHandle: true);
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
