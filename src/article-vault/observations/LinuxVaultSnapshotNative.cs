using System.Buffers.Binary;
using System.Runtime.ExceptionServices;
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
    private const int BreakSignal = 29;
    private const int SetLease = 1024;
    private const int GetLease = 1025;
    private const int ReadLock = 0;
    private const int Unlock = 2;

    // No process-wide handler, signal disposition, thread-pool mask or kernel settings change.
    // F_SETSIG=0 deliberately uses plain SIGIO: no queued-signal exhaustion fallback. Linux
    // F_OWNER_TID preserves thread-directed delivery even for this legacy signal mode.
    // The dedicated thread stays alive and keeps SIGIO blocked until unlock and close. Thread-directed pending signals die with that thread.
    internal static void WithReadLease(Func<SafeFileHandle> openDescriptor,
        Action<SafeFileHandle, Action> read, CancellationToken cancellationToken)
    {
        ExceptionDispatchInfo? failure = null;
        var worker = new Thread(() =>
        {
            try
            {
                RequirePlatform();
                SignalSet signals = default;
                if (EmptySignalSet(ref signals) != 0 || AddSignal(ref signals, BreakSignal) != 0
                    || BlockSignals(0, ref signals, IntPtr.Zero) != 0)
                {
                    throw new LinuxVaultWatcherException("vault_snapshot_lease_signal_setup_failed");
                }

                cancellationToken.ThrowIfCancellationRequested();
                using SafeFileHandle descriptor = openDescriptor();
                bool pinned = false;
                try
                {
                    // Scope disposal may close the managed handle concurrently. Hold the actual
                    // fd until cleanup so an unlock can never act on a recycled descriptor number.
                    descriptor.DangerousAddRef(ref pinned);
                    int fd = checked((int)descriptor.DangerousGetHandle());
                    try
                    {
                        if (Observe(descriptor).OwnerUid != EffectiveUserId())
                        {
                            throw new LinuxVaultWatcherException("vault_snapshot_lease_same_uid_required");
                        }

                        var owner = new SignalOwner { _type = 0, _identity = ThreadIdentity() };
                        if (SetOwner(fd, 15, ref owner) != 0 || Control(fd, 10, 0) != 0)
                        {
                            throw new LinuxVaultWatcherException("vault_snapshot_lease_signal_setup_failed");
                        }

                        if (Control(fd, SetLease, ReadLock) != 0)
                        {
                            int error = Marshal.GetLastPInvokeError();
                            throw new LinuxVaultWatcherException(error == 11
                                ? "vault_snapshot_lease_writer_present"
                                : "vault_snapshot_lease_unsupported_or_denied");
                        }

                        void Check()
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            // F_GETLEASE returns the downgrade TARGET while a break is pending,
                            // and UNLCK after forced expiry. Absence of SIGIO proves nothing.
                            if (Control(fd, GetLease, 0) != ReadLock || HasPendingBreakSignal(ref signals))
                            {
                                throw new LinuxVaultWatcherException("vault_snapshot_lease_broken");
                            }
                        }

                        Check();
                        read(descriptor, Check);
                        Check();
                        if (Control(fd, SetLease, Unlock) != 0 || Control(fd, GetLease, 0) != Unlock)
                        {
                            throw new LinuxVaultWatcherException("vault_snapshot_lease_release_failed");
                        }

                        // Unlock serializes with the kernel break callback. A break arriving
                        // between the final GETLEASE and unlock is rejected here before delivery.
                        if (HasPendingBreakSignal(ref signals))
                        {
                            throw new LinuxVaultWatcherException("vault_snapshot_lease_broken");
                        }

                        cancellationToken.ThrowIfCancellationRequested();
                    }
                    finally
                    {
                        // Closing this unique open description is the fallback if unlock fails.
                        // This also covers acquisition failure, cancellation and read exceptions.
                        descriptor.Dispose();
                    }
                }
                finally
                {
                    if (pinned)
                    {
                        descriptor.DangerousRelease();
                    }

                    // Do not consume signals: sigtimedwait/signalfd could steal a different
                    // component's process-pending SIGIO. Thread-pending SIGIO is discarded by
                    // thread exit; process-pending signals remain available to their receivers.
                    // Never restore/unblock SIGIO on this retiring dedicated thread.
                }
            }
            catch (Exception exception)
            {
                failure = ExceptionDispatchInfo.Capture(exception);
            }
        });
        worker.Start();
        worker.Join();
        failure?.Throw();
    }

    private static bool HasPendingBreakSignal(ref SignalSet signals)
    {
        if (PendingSignals(ref signals) != 0)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_lease_signal_read_failed");
        }

        int pending = ContainsSignal(ref signals, BreakSignal);
        if (pending < 0)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_lease_signal_read_failed");
        }

        return pending != 0;
    }

    private static void RequirePlatform()
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("vault_snapshot_native_platform_unsupported");
        }
    }

    internal static Observation Observe(SafeFileHandle descriptor)
    {
        RequirePlatform();
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
            status._modifiedSeconds, status._modifiedNanoseconds, status._uid);
    }

    internal sealed record Observation(VaultFileMetadataObservation Metadata, uint Links,
        long ChangedSeconds, uint ChangedNanoseconds, long ModifiedSeconds, uint ModifiedNanoseconds, uint OwnerUid);

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

    [StructLayout(LayoutKind.Sequential, Size = 128)]
    private struct SignalSet
    {
        private ulong _bits;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SignalOwner
    {
        internal int _type;
        internal int _identity;
    }

    [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
    private static extern int Control(int descriptor, int command, int argument);

    [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
    private static extern int SetOwner(int descriptor, int command, ref SignalOwner owner);

    [DllImport("libc", EntryPoint = "gettid")]
    private static extern int ThreadIdentity();

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint EffectiveUserId();

    [DllImport("libc", EntryPoint = "sigemptyset", SetLastError = true)]
    private static extern int EmptySignalSet(ref SignalSet signals);

    [DllImport("libc", EntryPoint = "sigaddset", SetLastError = true)]
    private static extern int AddSignal(ref SignalSet signals, int signal);

    [DllImport("libc", EntryPoint = "pthread_sigmask")]
    private static extern int BlockSignals(int how, ref SignalSet signals, IntPtr previous);

    [DllImport("libc", EntryPoint = "sigpending", SetLastError = true)]
    private static extern int PendingSignals(ref SignalSet signals);

    [DllImport("libc", EntryPoint = "sigismember", SetLastError = true)]
    private static extern int ContainsSignal(ref SignalSet signals, int signal);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatDescriptor(SafeFileHandle descriptor,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out Status status);
}
