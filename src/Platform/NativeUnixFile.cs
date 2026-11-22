using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Platform;

internal static class NativeUnixFile
{
    private const ushort TypeMask = 0xf000;
    private const ushort Regular = 0x8000;
    private const ushort PermissionMask = 0x0fff;
    private const int LinuxEmptyPath = 0x1000;
    private const uint LinuxFields = 0xb; // STATX_TYPE | STATX_MODE | STATX_UID
    private const uint LinuxLinkCount = 0x4; // STATX_NLINK
    private const uint LinuxChanges = 0x180; // STATX_CTIME | STATX_INO
    internal const int NotFound = 2;
    internal const int ReadWrite = 2;

    internal readonly record struct ChangeStamp(ulong Device, ulong Inode, long Seconds, long Nanoseconds);

    internal static bool Supported => (OperatingSystem.IsMacOS() || OperatingSystem.IsLinux()) &&
        RuntimeInformation.ProcessArchitecture is Architecture.Arm64 or Architecture.X64;
    internal static int DirectoryReadFlags => NoFollow | CloseOnExec | DirectoryOnly;
    internal static int FileReadFlags => NoFollow | CloseOnExec | NonBlocking;
    internal static int NoFollow => Abi(0x100, 0x20000, 0x8000);
    internal static int CloseOnExec => Abi(0x1000000, 0x80000, 0x80000);
    private static int DirectoryOnly => Abi(0x100000, 0x10000, 0x4000);
    private static int NonBlocking => Abi(0x4, 0x800, 0x800);

    private static int Abi(int darwin, int linuxX64, int linuxArm64)
    {
        if (!Supported) throw new PlatformNotSupportedException("Native file inspection requires macOS or Linux on x64 or ARM64.");
        if (OperatingSystem.IsMacOS()) return darwin;
        // ARM64 overrides the generic O_NOFOLLOW and O_DIRECTORY ABI bit positions.
        return RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? linuxArm64 : linuxX64;
    }

    internal static SafeFileHandle OpenDirectory(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("An absolute Unix directory is required.", nameof(path));
        var flags = DirectoryReadFlags;
        SafeFileHandle current = new(Open("/", flags), ownsHandle: true);
        try
        {
            if (current.IsInvalid) throw Failure("Could not open the Unix root.", Marshal.GetLastPInvokeError());
            foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                if (part is "." or "..") throw new ArgumentException("A canonical Unix directory is required.", nameof(path));
                var next = OpenAt(current, part, flags);
                if (next < 0) throw Failure("Could not open a real Unix directory.", Marshal.GetLastPInvokeError());
                current.Dispose();
                current = new(next, ownsHandle: true);
            }
            return current;
        }
        catch { current.Dispose(); throw; }
    }

    internal static SafeFileHandle? OpenFile(SafeFileHandle directory, string leaf, int flags, out int error)
    {
        if (leaf.Length == 0 || leaf is "." or ".." || leaf.AsSpan().IndexOfAny('/', '\0') >= 0)
            throw new ArgumentException("A single Unix filename is required.", nameof(leaf));
        var descriptor = OpenAt(directory, leaf, flags);
        error = descriptor < 0 ? Marshal.GetLastPInvokeError() : 0;
        return descriptor < 0 ? null : new(descriptor, ownsHandle: true);
    }

    internal static bool IsRegular(SafeFileHandle handle) => (Inspect(handle).Mode & TypeMask) == Regular;

    internal static UnixFileMode? RegularMode(SafeFileHandle handle)
    {
        var (mode, _, _) = Inspect(handle);
        return (mode & TypeMask) == Regular ? (UnixFileMode)(mode & PermissionMask) : null;
    }

    internal static bool IsRegular(SafeFileHandle handle, UnixFileMode expectedMode, bool owned)
    {
        var (mode, uid, _) = Inspect(handle);
        return (mode & TypeMask) == Regular && (mode & PermissionMask) == (int)expectedMode && (!owned || uid == EffectiveUid());
    }

    internal static bool HasMode(SafeFileHandle handle, UnixFileMode expectedMode, bool owned = false)
    {
        var (mode, uid, _) = Inspect(handle);
        return (mode & PermissionMask) == (int)expectedMode && (!owned || uid == EffectiveUid());
    }

    internal static bool IsRootControlled(SafeFileHandle handle, bool regular)
    {
        var (mode, uid, _) = Inspect(handle);
        const ushort externalWrite = 0x12; // group write or other write
        return uid == 0 && (mode & externalWrite) == 0 && (mode & TypeMask) == (regular ? Regular : 0x4000);
    }

    internal static (ushort Mode, uint Uid, uint Links) Inspect(SafeFileHandle handle, bool includeLinks = false)
    {
        if (OperatingSystem.IsLinux())
        {
            var status = LinuxMetadata(handle, LinuxFields | (includeLinks ? LinuxLinkCount : 0));
            return (status.Mode, status.Uid, status.Links);
        }
        var metadata = DarwinMetadata(handle);
        return (metadata.Mode, metadata.Uid, metadata.Links);
    }

    internal static ChangeStamp InspectChanges(SafeFileHandle handle)
    {
        if (OperatingSystem.IsLinux())
        {
            var status = LinuxMetadata(handle, LinuxChanges);
            return new(((ulong)status.DeviceMajor << 32) | status.DeviceMinor, status.Inode, status.Seconds, status.Nanoseconds);
        }
        var metadata = DarwinMetadata(handle);
        return new(metadata.Device, metadata.Inode, metadata.Seconds, metadata.Nanoseconds);
    }

    private static LinuxStat LinuxMetadata(SafeFileHandle handle, uint fields)
    {
        if (!Supported) throw new PlatformNotSupportedException();
        if (StatLinux(handle, "", LinuxEmptyPath, fields, out var status) != 0)
            throw Failure("Could not inspect the open Unix file.", Marshal.GetLastPInvokeError());
        if ((status.Mask & fields) != fields) throw new IOException("The Unix file metadata is incomplete.");
        return status;
    }

    private static DarwinStat DarwinMetadata(SafeFileHandle handle)
    {
        if (!Supported) throw new PlatformNotSupportedException();
        var success = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
            ? StatDarwin(handle, out var metadata) : StatDarwinInode64(handle, out metadata);
        return success == 0 ? metadata
            : throw Failure("Could not inspect the open Unix file.", Marshal.GetLastPInvokeError());
    }

    internal static int CreateExclusiveAt(SafeFileHandle directory, string leaf, int flags, uint mode)
    {
        flags |= WriteOnly | ExclusiveCreate;
        // The first variadic argument goes on the stack on Darwin ARM64.
        return OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.Arm64
            ? OpenAtDarwinArm64(directory, leaf, flags, 0, 0, 0, 0, 0, mode)
            : OpenAtCreate(directory, leaf, flags, mode);
    }

    private const int WriteOnly = 1;
    private static int ExclusiveCreate => OperatingSystem.IsMacOS() ? 0xa00 : 0xc0;

    private static IOException Failure(string message, int error) => error == NotFound
        ? new FileNotFoundException(message) : new IOException(message, error);

    [StructLayout(LayoutKind.Explicit, Size = 144)]
    private struct DarwinStat
    {
        [FieldOffset(0)] public uint Device;
        [FieldOffset(4)] public ushort Mode;
        [FieldOffset(6)] public ushort Links;
        [FieldOffset(8)] public ulong Inode;
        [FieldOffset(16)] public uint Uid;
        [FieldOffset(64)] public long Seconds;
        [FieldOffset(72)] public long Nanoseconds;
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxStat
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(16)] public uint Links;
        [FieldOffset(20)] public uint Uid;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(96)] public long Seconds;
        [FieldOffset(104)] public uint Nanoseconds;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    internal static extern int OpenAt(SafeFileHandle parent, [MarshalAs(UnmanagedType.LPUTF8Str)] string leaf, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAtCreate(SafeFileHandle parent, [MarshalAs(UnmanagedType.LPUTF8Str)] string leaf, int flags, uint mode);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAtDarwinArm64(SafeFileHandle parent, [MarshalAs(UnmanagedType.LPUTF8Str)] string leaf,
        int flags, uint register3, uint register4, uint register5, uint register6, uint register7, uint mode);
    [DllImport("libc", EntryPoint = "fchmod", SetLastError = true)]
    internal static extern int SetMode(SafeFileHandle handle, uint mode);
    [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
    internal static extern int Sync(SafeFileHandle handle);
    [DllImport("libc", EntryPoint = "geteuid")]
    internal static extern uint EffectiveUid();
    [DllImport("libc", EntryPoint = "fstat", SetLastError = true)]
    private static extern int StatDarwin(SafeFileHandle handle, out DarwinStat status);
    [DllImport("libc", EntryPoint = "fstat$INODE64", SetLastError = true)]
    private static extern int StatDarwinInode64(SafeFileHandle handle, out DarwinStat status);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatLinux(SafeFileHandle handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        int flags, uint mask, out LinuxStat status);
}
