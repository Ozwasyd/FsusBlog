using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Server.Infrastructure.Memory.Disk;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>
/// Linux descriptor-relative filesystem boundary. No-follow traversal and inode/device
/// identity checks are the containment proof; a textual prefix is never that proof.
/// </summary>
internal sealed class LinuxOwnedSpillDirectory : IDisposable
{
    private const int DirectoryFlag = 0x10000;
    private const int NoFollowFlag = 0x20000;
    private const int CloseOnExecFlag = 0x80000;
    private const int EmptyPathFlag = 0x1000;
    private const uint StatxMask = 0x7ff;
    private const ushort DirectoryType = 0x4000;
    private const ushort RegularType = 0x8000;
    private const ushort TypeMask = 0xf000;
    private readonly string _path;
    private readonly SafeFileHandle _directory;
    private readonly FileIdentity _identity;

    internal LinuxOwnedSpillDirectory(string path)
    {
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("Owned spill descriptor boundary requires Linux x64/arm64 qualification.");
        }
        ArgumentNullException.ThrowIfNull(path);
        if (path.Length > 4096 || !Path.IsPathFullyQualified(path) || path.Split('/').Any(part => part is "." or ".."))
        {
            throw new ArgumentException("An absolute owner-selected root without traversal is required.", nameof(path));
        }
        _path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        _directory = OpenDirectory(_path);
        try
        {
            _identity = Inspect(_directory);
            RequireOwned(_identity, DirectoryType);
        }
        catch
        {
            _directory.Dispose();
            throw;
        }
    }

    internal void Validate()
    {
        ObjectDisposedException.ThrowIf(_directory.IsClosed, this);
        using SafeFileHandle current = OpenDirectory(_path);
        FileIdentity currentIdentity = Inspect(current);
        FileIdentity heldIdentity = Inspect(_directory);
        RequireOwned(currentIdentity, DirectoryType);
        RequireOwned(heldIdentity, DirectoryType);
        if (currentIdentity.DeviceMajor != _identity.DeviceMajor || currentIdentity.DeviceMinor != _identity.DeviceMinor
            || currentIdentity.Inode != _identity.Inode || heldIdentity.Inode != _identity.Inode
            || heldIdentity.DeviceMajor != _identity.DeviceMajor || heldIdentity.DeviceMinor != _identity.DeviceMinor)
        {
            throw new DiskFileSystemException("use replaced spill root", 0, DiskFileSystemFailure.OwnershipChanged);
        }
    }

    internal FileStream Create(string name)
    {
        Validate();
        int descriptor = OpenAt(_directory, name, 2 | 0x40 | 0x80 | NoFollowFlag | CloseOnExecFlag, 0x180);
        return StreamFromDescriptor(descriptor, FileAccess.ReadWrite);
    }

    internal FileStream Read(string name)
    {
        Validate();
        int descriptor = OpenAt(_directory, name, NoFollowFlag | CloseOnExecFlag, 0);
        return StreamFromDescriptor(descriptor, FileAccess.Read);
    }

    internal IEnumerable<string> EnumerateNames(int maximumExaminedEntries)
    {
        if (maximumExaminedEntries <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumExaminedEntries));
        }
        Validate();
        bool held = false;
        try
        {
            _directory.DangerousAddRef(ref held);
            // Keep the descriptor alive across lazy enumeration to prevent fd reuse
            // redirecting /proc resolution after concurrent disposal.
            int examined = 0;
            var options = new EnumerationOptions
            {
                AttributesToSkip = 0,
                BufferSize = 4096,
                IgnoreInaccessible = false,
                RecurseSubdirectories = false,
                ReturnSpecialDirectories = false
            };
            foreach (string path in Directory.EnumerateFileSystemEntries($"/proc/self/fd/{_directory.DangerousGetHandle()}", "*", options))
            {
                if (++examined > maximumExaminedEntries)
                {
                    throw new DiskFileSystemException("scan bounded spill root", 0, DiskFileSystemFailure.ScanBudgetRejected);
                }
                Validate();
                yield return Path.GetFileName(path);
            }
        }
        finally
        {
            if (held)
            {
                _directory.DangerousRelease();
            }
        }
    }

    internal void Rename(string source, string destination)
    {
        Validate();
        using FileStream proof = Read(source);
        if (RenameAt(_directory, source, _directory, destination, 1) != 0)
        {
            ThrowNative("publish spill file");
        }
    }

    internal void Delete(string name)
    {
        Validate();
        // Only ENOENT from this anchored leaf lookup proves physical absence.
        // ENOENT from root revalidation must never release a retained file's charge.
        int descriptor = OpenAt(_directory, name, NoFollowFlag | CloseOnExecFlag, 0);
        if (descriptor < 0 && Marshal.GetLastPInvokeError() == 2)
        {
            return;
        }
        using FileStream proof = StreamFromDescriptor(descriptor, FileAccess.Read);
        if (UnlinkAt(_directory, name, 0) != 0 && Marshal.GetLastPInvokeError() != 2)
        {
            ThrowNative("delete owned spill file");
        }
    }

    internal LinuxDiskSample Sample()
    {
        Validate();
        if (FileSystemStats(_directory, out FileSystemStat fileSystem) != 0
            || VolumeStats(_directory, out VolumeStat volume) != 0)
        {
            ThrowNative("sample owned volume");
        }
        long bytes;
        long inodes;
        try
        {
            bytes = checked((long)volume.AvailableBlocks * (long)volume.FragmentSize);
            inodes = checked((long)volume.AvailableFiles);
        }
        catch (OverflowException exception)
        {
            throw new IOException("Filesystem counters exceed supported bounds.", exception);
        }
        DiskBackingKind backing = fileSystem.Type switch
        {
            0x01021994 or 0x858458f6 or 0x958458f6 => DiskBackingKind.MemoryBacked,
            0xef53 or 0x58465342 or 0x9123683e or 0x2fc12fc1 => DiskBackingKind.Independent,
            // Overlay, FUSE and other unresolved layers may be backed by host memory.
            // Their free-space counters alone cannot certify independent escape capacity.
            _ => DiskBackingKind.Unknown
        };
        return new($"linux-device:{_identity.DeviceMajor}:{_identity.DeviceMinor}", bytes, inodes,
            backing, (volume.Flags & 1) != 0);
    }

    public void Dispose() => _directory.Dispose();

    private static SafeFileHandle OpenDirectory(string absolutePath)
    {
        int descriptor = Open("/", DirectoryFlag | NoFollowFlag | CloseOnExecFlag, 0);
        if (descriptor < 0)
        {
            ThrowNative("open filesystem root");
        }
        var cursor = new SafeFileHandle(descriptor, ownsHandle: true);
        try
        {
            foreach (string part in absolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                int child = OpenAt(cursor, part, DirectoryFlag | NoFollowFlag | CloseOnExecFlag, 0);
                if (child < 0)
                {
                    ThrowNative("open root component without following links");
                }
                var next = new SafeFileHandle(child, ownsHandle: true);
                cursor.Dispose();
                cursor = next;
            }
            return cursor;
        }
        catch
        {
            cursor.Dispose();
            throw;
        }
    }

    private static FileStream StreamFromDescriptor(int descriptor, FileAccess access)
    {
        if (descriptor < 0)
        {
            ThrowNative("open owned spill file");
        }
        var handle = new SafeFileHandle(descriptor, ownsHandle: true);
        try
        {
            RequireOwned(Inspect(handle), RegularType);
            return new FileStream(handle, access, bufferSize: 1, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static FileIdentity Inspect(SafeFileHandle handle)
    {
        if (Statx(handle, "", EmptyPathFlag, StatxMask, out FileIdentity identity) != 0)
        {
            ThrowNative("inspect filesystem identity");
        }
        if ((identity.Mask & 0x10f) != 0x10f)
        {
            throw new IOException("Filesystem did not return required type/mode/link/inode identity.");
        }
        return identity;
    }

    private static void RequireOwned(FileIdentity identity, ushort type)
    {
        if ((identity.Mode & TypeMask) != type || identity.UserId != EffectiveUserId()
            || (identity.Mode & 0x12) != 0 || (type == RegularType && identity.LinkCount != 1))
        {
            throw new UnauthorizedAccessException("Spill resource must be owned, unshared, and not writable by group or others.");
        }
    }

    private static void ThrowNative(string action)
    {
        int error = Marshal.GetLastPInvokeError();
        // The native errno survives in HResult without placing payload/path contents in diagnostics.
        DiskFileSystemFailure kind = error switch
        {
            28 => DiskFileSystemFailure.SpaceOrInodesExhausted,
            122 => DiskFileSystemFailure.QuotaExceeded,
            30 => DiskFileSystemFailure.ReadOnly,
            1 or 13 => DiskFileSystemFailure.PermissionDenied,
            _ => DiskFileSystemFailure.Unavailable
        };
        throw new DiskFileSystemException(action, error, kind);
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct FileIdentity
    {
        [FieldOffset(0)] internal uint Mask;
        [FieldOffset(16)] internal uint LinkCount;
        [FieldOffset(20)] internal uint UserId;
        [FieldOffset(28)] internal ushort Mode;
        [FieldOffset(32)] internal ulong Inode;
        [FieldOffset(136)] internal uint DeviceMajor;
        [FieldOffset(140)] internal uint DeviceMinor;
    }

    [StructLayout(LayoutKind.Explicit, Size = 120)]
    private struct FileSystemStat
    {
        [FieldOffset(0)] internal long Type;
    }

    [StructLayout(LayoutKind.Sequential, Size = 112)]
    private struct VolumeStat
    {
        internal ulong BlockSize;
        internal ulong FragmentSize;
        internal ulong Blocks;
        internal ulong FreeBlocks;
        internal ulong AvailableBlocks;
        internal ulong Files;
        internal ulong FreeFiles;
        internal ulong AvailableFiles;
        internal ulong FileSystemId;
        internal ulong Flags;
        internal ulong NameMaximum;
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open(string path, int flags, uint mode);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(SafeFileHandle directory, string name, int flags, uint mode);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(SafeFileHandle directory, string name, int flags, uint mask, out FileIdentity identity);
    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint EffectiveUserId();
    [DllImport("libc", EntryPoint = "renameat2", SetLastError = true)]
    private static extern int RenameAt(SafeFileHandle oldDirectory, string oldName, SafeFileHandle newDirectory, string newName, uint flags);
    [DllImport("libc", EntryPoint = "unlinkat", SetLastError = true)]
    private static extern int UnlinkAt(SafeFileHandle directory, string name, int flags);
    [DllImport("libc", EntryPoint = "fstatfs", SetLastError = true)]
    private static extern int FileSystemStats(SafeFileHandle file, out FileSystemStat statistics);
    [DllImport("libc", EntryPoint = "fstatvfs", SetLastError = true)]
    private static extern int VolumeStats(SafeFileHandle file, out VolumeStat statistics);
}

internal sealed record LinuxDiskSample(string CapacityIdentity, long AvailableBytes, long AvailableInodes,
    DiskBackingKind Backing, bool ReadOnly);
