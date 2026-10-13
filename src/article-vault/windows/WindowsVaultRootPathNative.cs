using System.Runtime.InteropServices;
using System.Text;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>Opens one NTFS name relative to a held parent; never follows reparse points.</summary>
internal static class WindowsVaultRootPathNative
{
    private const uint ReadAttributes = 0x80;
    private const uint Synchronize = 0x100000;
    private const uint OpenReparsePoint = 0x200000;
    private const uint DontReparse = 0x1000;
    private const uint CaseInsensitive = 0x40;

    internal sealed record Facts(string FinalPath, uint Volume, string VolumeIdentity, ulong FileId, bool Directory);

    internal static SafeFileHandle OpenDrive(string path)
    {
        SafeFileHandle handle = CreateFile(path, 1 | ReadAttributes | Synchronize, 3, 0, 3,
            0x02000000 | 0x00200000 | 0x40000000, 0);
        if (handle.IsInvalid)
        {
            handle.Dispose();
            throw Failure("windows_vault_root_open_failed");
        }

        return handle;
    }

    internal static SafeFileHandle OpenRelative(SafeFileHandle parent, string segment, bool directory, bool readControl = false)
    {
        nint nameBuffer = Marshal.StringToHGlobalUni(segment);
        nint namePointer = 0;
        bool retained = false;
        try
        {
            var name = new UnicodeString
            {
                _length = checked((ushort)(segment.Length * 2)),
                _maximumLength = checked((ushort)(segment.Length * 2)),
                _buffer = nameBuffer
            };
            namePointer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            Marshal.StructureToPtr(name, namePointer, false);
            parent.DangerousAddRef(ref retained);
            var attributes = new ObjectAttributes
            {
                _length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                _rootDirectory = parent.DangerousGetHandle(),
                _objectName = namePointer,
                _attributes = DontReparse | CaseInsensitive
            };
            uint access = ReadAttributes | Synchronize | (directory ? 1u : 0u) | (readControl ? 0x80000000u : 0u);
            // Selected root/descendants use ordinary ACL checks, never backup-intent privilege.
            uint options = OpenReparsePoint | (directory ? 1u : 0x40u) | (readControl ? 0x20u : 0u);
            int status = NtCreateFile(out SafeFileHandle handle, access, ref attributes, out _, 0, 0, readControl ? 1u : 3u, 1,
                options, 0, 0);
            if (status < 0)
            {
                handle.Dispose();
                if (status is unchecked((int)0xC0000034) or unchecked((int)0xC000003A))
                {
                    throw new FileNotFoundException("windows_vault_path_missing");
                }

                throw Failure("windows_vault_relative_open_failed");
            }

            return handle;
        }
        finally
        {
            if (retained)
            {
                parent.DangerousRelease();
            }

            Marshal.FreeHGlobal(namePointer);
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    internal static Facts Inspect(SafeFileHandle handle)
    {
        if (!GetFileInformation(handle, out FileInformation information)
            || (information._attributes & 0x400) != 0)
        {
            throw Failure("windows_vault_reparse_or_identity_unavailable");
        }

        var filesystem = new StringBuilder(64);
        if (!GetVolumeInformation(handle, 0, 0, out uint volume, out _, out _, filesystem, 64)
            || filesystem.ToString() != "NTFS" || volume != information._volumeSerial)
        {
            throw Failure("windows_vault_filesystem_unsupported");
        }

        bool directory = (information._attributes & 0x10) != 0;
        if (!directory && information._numberOfLinks != 1)
        {
            throw Failure("windows_vault_hardlink_alias_rejected");
        }

        if (directory && (!GetCaseInformation(handle, 23, out uint flags, sizeof(uint)) || flags != 0))
        {
            throw Failure("windows_vault_case_semantics_unsupported");
        }

        var path = new StringBuilder(32768);
        uint length = GetFinalPath(handle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity || !path.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal)
            || path.ToString().StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
        {
            throw Failure("windows_vault_final_path_unavailable");
        }

        var volumePath = new StringBuilder(32768);
        uint volumeLength = GetFinalPath(handle, volumePath, (uint)volumePath.Capacity, 1);
        string volumeName = volumePath.ToString();
        int volumeEnd = volumeName.IndexOf("}\\", StringComparison.Ordinal);
        if (volumeLength == 0 || volumeLength >= volumePath.Capacity || volumeEnd < 0
            || !volumeName.StartsWith("\\\\?\\Volume{", StringComparison.Ordinal)
            || !Guid.TryParse(volumeName.AsSpan(11, volumeEnd - 11), out _))
        {
            throw Failure("windows_vault_volume_identity_unavailable");
        }

        return new Facts(Path.TrimEndingDirectorySeparator(path.ToString()[4..]), volume, volumeName[..(volumeEnd + 1)],
            ((ulong)information._fileIndexHigh << 32) | information._fileIndexLow, directory);
    }

    internal static SafeFileHandle Duplicate(SafeFileHandle handle)
    {
        nint process = GetCurrentProcess();
        if (!DuplicateHandle(process, handle, process, out SafeFileHandle duplicate, 0, false, 2))
        {
            duplicate.Dispose();
            throw Failure("windows_vault_handle_duplicate_failed");
        }

        return duplicate;
    }

    private static IOException Failure(string code) => new(code);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        internal ushort _length;
        internal ushort _maximumLength;
        internal nint _buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        internal uint _length;
        internal nint _rootDirectory;
        internal nint _objectName;
        internal uint _attributes;
        internal nint _securityDescriptor;
        internal nint _securityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        internal nint _status;
        internal nuint _information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint _attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME _creationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME _lastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME _lastWriteTime;
        internal uint _volumeSerial;
        internal uint _fileSizeHigh;
        internal uint _fileSizeLow;
        internal uint _numberOfLinks;
        internal uint _fileIndexHigh;
        internal uint _fileIndexLow;
    }

    [DllImport("ntdll.dll", SetLastError = false)]
    private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
        out IoStatusBlock status, nint allocationSize, uint fileAttributes, uint share, uint disposition,
        uint options, nint extendedAttributes, uint extendedAttributesLength);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        nint attributes, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformation(SafeFileHandle handle, out FileInformation information);

    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCaseInformation(SafeFileHandle handle, int informationClass, out uint information, uint size);

    [DllImport("kernel32.dll", EntryPoint = "GetVolumeInformationByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(SafeFileHandle handle, nint name, uint nameLength,
        out uint serial, out uint maximumComponent, out uint flags, StringBuilder filesystem, uint filesystemLength);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPath(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(nint sourceProcess, SafeFileHandle source, nint targetProcess,
        out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
}
