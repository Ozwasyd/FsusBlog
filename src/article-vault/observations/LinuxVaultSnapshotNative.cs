using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>Observes metadata only on a descriptor already issued by the canonical root scope.</summary>
internal static class LinuxVaultSnapshotNative
{
    private const uint RequiredMask = 0x17df;

    internal static Observation Observe(SafeFileHandle descriptor)
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("vault_snapshot_native_platform_unsupported");
        }

        if (StatDescriptor(descriptor, string.Empty, 0x1000 | 0x100, RequiredMask, out Status status) != 0
            || (status._mask & RequiredMask) != RequiredMask)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_descriptor_metadata_unavailable");
        }

        if ((status._mode & 0xf000) != 0x8000 || status._size > ArticleVaultSnapshotAssessor.MaxSourceBytes)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_descriptor_kind_or_size_rejected");
        }

        byte[] permissions = new byte[12];
        BinaryPrimitives.WriteUInt32LittleEndian(permissions, status._mode);
        BinaryPrimitives.WriteUInt32LittleEndian(permissions.AsSpan(4), status._uid);
        BinaryPrimitives.WriteUInt32LittleEndian(permissions.AsSpan(8), status._gid);
        string identity = string.Create(System.Globalization.CultureInfo.InvariantCulture,
            $"device{status._deviceMajor}_{status._deviceMinor}_mount{status._mountIdentity}_inode{status._inode}");
        var metadata = new VaultFileMetadataObservation(identity, checked((long)status._size),
            Convert.ToHexStringLower(SHA256.HashData(permissions)), true, (status._mode & 0x124) != 0);
        return new(metadata, status._links, status._changedSeconds, status._changedNanoseconds,
            status._modifiedSeconds, status._modifiedNanoseconds);
    }

    internal sealed record Observation(VaultFileMetadataObservation Metadata, uint Links,
        long ChangedSeconds, uint ChangedNanoseconds, long ModifiedSeconds, uint ModifiedNanoseconds);

    // Linux statx is a fixed UAPI layout on the two admitted architectures. Atime is excluded:
    // the source reader itself changes it and it cannot establish content or editor completion.
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

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatDescriptor(SafeFileHandle descriptor,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out Status status);
}
