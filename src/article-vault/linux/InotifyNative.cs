using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

internal static partial class InotifyNative
{
    internal const int NonBlocking = 0x800;
    internal const int CloseOnExec = 0x80000;
    internal const int Again = 11;
    internal const int Interrupted = 4;

    internal const uint Access = 0x00000001;
    internal const uint Modify = 0x00000002;
    internal const uint Attributes = 0x00000004;
    internal const uint CloseWrite = 0x00000008;
    internal const uint CloseNoWrite = 0x00000010;
    internal const uint Open = 0x00000020;
    internal const uint MovedFrom = 0x00000040;
    internal const uint MovedTo = 0x00000080;
    internal const uint Create = 0x00000100;
    internal const uint Delete = 0x00000200;
    internal const uint DeleteSelf = 0x00000400;
    internal const uint MoveSelf = 0x00000800;
    internal const uint Unmount = 0x00002000;
    internal const uint QueueOverflow = 0x00004000;
    internal const uint Ignored = 0x00008000;
    internal const uint OnlyDirectory = 0x01000000;
    internal const uint DoNotFollow = 0x02000000;
    internal const uint IsDirectory = 0x40000000;

    internal const uint WatchMask =
        Modify
        | Attributes
        | CloseWrite
        | MovedFrom
        | MovedTo
        | Create
        | Delete
        | DeleteSelf
        | MoveSelf
        | Unmount
        | OnlyDirectory
        | DoNotFollow;

    [LibraryImport("libc", EntryPoint = "inotify_init1", SetLastError = true)]
    internal static partial int Initialize(int flags);

    [LibraryImport("libc", EntryPoint = "inotify_add_watch", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int AddWatch(int descriptor, string path, uint mask);

    [LibraryImport("libc", EntryPoint = "inotify_rm_watch", SetLastError = true)]
    internal static partial int RemoveWatch(int descriptor, int watchDescriptor);

    [LibraryImport("libc", EntryPoint = "read", SetLastError = true)]
    internal static unsafe partial nint Read(int descriptor, byte* buffer, nuint count);

    [LibraryImport("libc", EntryPoint = "realpath", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint RealPath(string path, nint resolvedPath);

    [LibraryImport("libc", EntryPoint = "free")]
    internal static partial void Free(nint pointer);

    internal static int FileDescriptor(SafeFileHandle handle)
        => checked((int)handle.DangerousGetHandle());
}
