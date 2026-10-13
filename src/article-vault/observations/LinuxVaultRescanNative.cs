using System.Runtime.InteropServices;

using FsusBlog.ArticleVault.Linux;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>Reads directory records only through a real enumeration descriptor issued by #2109.</summary>
internal static class LinuxVaultRescanNative
{
    internal static int ReadDirectory(SafeFileHandle descriptor, byte[] buffer)
    {
        RequirePlatform();
        long call = RuntimeInformation.ProcessArchitecture == Architecture.X64 ? 217 : 61;
        long count = ReadDirectoryNative(call, descriptor, buffer, (nuint)buffer.Length);
        if (count < 0)
        {
            int error = Marshal.GetLastPInvokeError();
            throw new LinuxVaultWatcherException(error is 1 or 13
                ? "vault_rescan_directory_permission_blocked" : "vault_rescan_directory_read_failed");
        }

        if (count > buffer.Length)
        {
            throw new LinuxVaultWatcherException("vault_rescan_directory_read_bound_exceeded");
        }

        return checked((int)count);
    }

    internal static DirectoryStamp ObserveDirectory(SafeFileHandle descriptor)
    {
        RequirePlatform();
        const uint RequiredMask = 0x17df;
        if (StatDirectory(descriptor, string.Empty, 0x1000 | 0x100, RequiredMask, out Status status) != 0
            || (status._mask & RequiredMask) != RequiredMask || (status._mode & 0xf000) != 0x4000)
        {
            throw new LinuxVaultWatcherException("vault_rescan_directory_metadata_unavailable");
        }

        return new(status._deviceMajor, status._deviceMinor, status._mountIdentity, status._inode,
            status._mode, status._uid, status._gid, status._links, status._size,
            status._changedSeconds, status._changedNanoseconds, status._modifiedSeconds, status._modifiedNanoseconds);
    }

    private static void RequirePlatform()
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("vault_rescan_native_platform_unsupported");
        }
    }

    internal sealed record DirectoryStamp(uint DeviceMajor, uint DeviceMinor, ulong MountIdentity,
        ulong Inode, ushort Mode, uint UserIdentity, uint GroupIdentity, uint Links, ulong Size,
        long ChangedSeconds, uint ChangedNanoseconds, long ModifiedSeconds, uint ModifiedNanoseconds);

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct Status
    {
        [FieldOffset(0)] internal uint _mask;
        [FieldOffset(16)] internal uint _links;
        [FieldOffset(20)] internal uint _uid;
        [FieldOffset(24)] internal uint _gid;
        [FieldOffset(28)] internal ushort _mode;
        [FieldOffset(32)] internal ulong _inode;
        [FieldOffset(40)] internal ulong _size;
        [FieldOffset(96)] internal long _changedSeconds;
        [FieldOffset(104)] internal uint _changedNanoseconds;
        [FieldOffset(112)] internal long _modifiedSeconds;
        [FieldOffset(120)] internal uint _modifiedNanoseconds;
        [FieldOffset(136)] internal uint _deviceMajor;
        [FieldOffset(140)] internal uint _deviceMinor;
        [FieldOffset(144)] internal ulong _mountIdentity;
    }

    [DllImport("libc", EntryPoint = "syscall", SetLastError = true)]
    private static extern long ReadDirectoryNative(long call, SafeFileHandle descriptor,
        [Out] byte[] buffer, nuint count);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatDirectory(SafeFileHandle descriptor,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out Status status);
}
