using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Opens descriptor-relative Linux paths without following links or crossing mounts.</summary>
internal static class LinuxVaultPathNative
{
    private const int OpenPath = 0x200000;
    private const int OpenDirectory = 0x10000;
    private const int OpenNoFollow = 0x20000;
    private const int OpenCloseOnExec = 0x80000;
    private const int OpenNonBlocking = 0x800;
    private const int OpenNoControllingTerminal = 0x100;
    private const int AtEmptyPath = 0x1000;
    private const int AtNoFollow = 0x100;
    private const uint RequiredStatMask = 0x1 | 0x100 | 0x1000;
    private const ushort FileTypeMask = 0xf000;
    private const ushort DirectoryType = 0x4000;
    private const ushort RegularFileType = 0x8000;
    private const long OpenAt2SystemCall = 437;
    private const ulong ResolveNoMountCrossing = 0x1;
    private const ulong ResolveNoSymlinks = 0x4;
    private const ulong ResolveBeneath = 0x8;
    private const nuint GetInodeFlags = 0x80086601;
    private const int CaseFoldFlag = 0x40000000;

    internal static SafeFileHandle OpenRoot(string absolutePath)
    {
        RequireSupportedPlatform();
        if (!Path.IsPathFullyQualified(absolutePath) || absolutePath.Contains('\0'))
        {
            throw new LinuxVaultWatcherException("linux_vault_descriptor_root_path_invalid");
        }

        int descriptor = OpenNative(absolutePath, OpenPath | OpenDirectory | OpenNoFollow | OpenCloseOnExec);
        if (descriptor < 0)
        {
            throw Failure("linux_vault_root_descriptor_open_failed");
        }

        return new SafeFileHandle(new nint(descriptor), ownsHandle: true);
    }

    internal static SafeFileHandle OpenRelative(SafeFileHandle root, string relativePath, bool directory,
        bool directoryMetadataProbe = false)
    {
        RequireSupportedPlatform();
        if (relativePath != "."
            && !FsusBlog.Shared.Contracts.ArticleVault.ArticleVaultPathStructureValidator
                .ValidateRelativePath(relativePath).IsValid)
        {
            throw new LinuxVaultWatcherException("linux_vault_descriptor_relative_path_invalid");
        }

        var how = new OpenHow
        {
            _flags = (ulong)(OpenCloseOnExec | OpenNoFollow
                | (directory ? OpenDirectory | (directoryMetadataProbe ? 0 : OpenPath)
                    : OpenNonBlocking | OpenNoControllingTerminal)),
            _resolve = ResolveBeneath | ResolveNoSymlinks | ResolveNoMountCrossing
        };
        bool added = false;
        try
        {
            root.DangerousAddRef(ref added);
            long descriptor = OpenAt2(OpenAt2SystemCall, checked((int)root.DangerousGetHandle()),
                relativePath, in how, (nuint)Marshal.SizeOf<OpenHow>());
            if (descriptor < 0)
            {
                throw Failure("linux_vault_openat2_failed");
            }

            var handle = new SafeFileHandle(new nint(descriptor), ownsHandle: true);
            try
            {
                DescriptorIdentity identity = Identify(handle);
                ushort expectedType = directory ? DirectoryType : RegularFileType;
                if ((identity.Mode & FileTypeMask) != expectedType)
                {
                    throw new LinuxVaultWatcherException("linux_vault_descriptor_kind_invalid");
                }

                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally
        {
            if (added)
            {
                root.DangerousRelease();
            }
        }
    }

    internal static void RequireOrdinalDirectorySemantics(SafeFileHandle root, string directoryRelativePath)
    {
        // O_PATH cannot service ioctl. This private read-only directory descriptor is used only
        // for metadata; no directory entries or source bytes are read through it.
        using SafeFileHandle directory = OpenRelative(root, directoryRelativePath, directory: true,
            directoryMetadataProbe: true);
        if (ReadInodeFlags(directory, GetInodeFlags, out int flags) != 0)
        {
            throw Failure("linux_vault_directory_semantics_unavailable");
        }

        if ((flags & CaseFoldFlag) != 0)
        {
            throw new LinuxVaultWatcherException("linux_vault_directory_casefold_unsupported");
        }
    }

    internal static DescriptorIdentity Identify(SafeFileHandle descriptor)
    {
        RequireSupportedPlatform();
        // SafeHandle marshalling pins the descriptor for the whole native statx call.
        if (StatDescriptor(descriptor, string.Empty, AtEmptyPath | AtNoFollow,
            RequiredStatMask, out Statx status) != 0)
        {
            throw Failure("linux_vault_descriptor_identity_unavailable");
        }

        if ((status._mask & RequiredStatMask) != RequiredStatMask)
        {
            throw new LinuxVaultWatcherException("linux_vault_descriptor_identity_incomplete");
        }

        return new DescriptorIdentity(status._deviceMajor, status._deviceMinor, status._mountIdentity,
            status._inode, status._mode);
    }

    private static void RequireSupportedPlatform()
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("linux_vault_descriptor_platform_unsupported");
        }
    }

    private static LinuxVaultWatcherException Failure(string defaultReason)
    {
        int error = Marshal.GetLastPInvokeError();
        string reason = error switch
        {
            1 or 13 => "linux_vault_descriptor_permission_denied",
            2 => "linux_vault_descriptor_path_missing",
            11 => "linux_vault_descriptor_resolution_raced",
            18 => "linux_vault_descriptor_mount_or_escape",
            38 => "linux_vault_openat2_or_statx_unavailable",
            40 => "linux_vault_descriptor_symlink_rejected",
            _ => defaultReason
        };
        return new LinuxVaultWatcherException(reason);
    }

    internal readonly record struct DescriptorIdentity(
        uint DeviceMajor,
        uint DeviceMinor,
        ulong MountIdentity,
        ulong Inode,
        ushort Mode)
    {
        internal bool SameObject(DescriptorIdentity other)
            => DeviceMajor == other.DeviceMajor && DeviceMinor == other.DeviceMinor
                && MountIdentity == other.MountIdentity && Inode == other.Inode
                && (Mode & FileTypeMask) == (other.Mode & FileTypeMask);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct OpenHow
    {
        internal ulong _flags;
        internal ulong _mode;
        internal ulong _resolve;
    }

    // Linux UAPI statx has a fixed 256-byte layout on the admitted 64-bit architectures.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct Statx
    {
        [FieldOffset(0)] internal uint _mask;
        [FieldOffset(28)] internal ushort _mode;
        [FieldOffset(32)] internal ulong _inode;
        [FieldOffset(136)] internal uint _deviceMajor;
        [FieldOffset(140)] internal uint _deviceMinor;
        [FieldOffset(144)] internal ulong _mountIdentity;
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenNative([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "syscall", SetLastError = true)]
    private static extern long OpenAt2(long number, int rootDescriptor,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string relativePath, in OpenHow how, nuint size);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatDescriptor(SafeFileHandle descriptor,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out Statx status);

    [DllImport("libc", EntryPoint = "ioctl", SetLastError = true)]
    private static extern int ReadInodeFlags(SafeFileHandle descriptor, nuint request, out int flags);
}
