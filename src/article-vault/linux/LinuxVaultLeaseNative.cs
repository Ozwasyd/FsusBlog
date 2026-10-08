using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Owns Linux lease-control locks and current-user permission observations only.</summary>
internal static partial class LinuxVaultLeaseNative
{
    internal const int DirectoryFlags = 0x10000 | 0x20000 | 0x80000;
    internal const int LeaseFlags = 2 | 0x800 | 0x20000 | 0x80000;

    [LibraryImport("libc", EntryPoint = "geteuid")]
    internal static partial uint CurrentUser();

    [LibraryImport("libc", EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int OpenAt(int directory, string name, int flags);

    [LibraryImport("libc", EntryPoint = "flock", SetLastError = true)]
    internal static partial int Lock(int descriptor, int operation);

    [LibraryImport("libc", EntryPoint = "getsockopt", SetLastError = true)]
    private static partial int SocketPeer(int descriptor, int level, int option, out PeerIdentity peer, ref uint length);

    [LibraryImport("libc", EntryPoint = "socket", SetLastError = true)]
    private static partial int SocketCreate(int family, int type, int protocol);

    [LibraryImport("libc", EntryPoint = "bind", SetLastError = true)]
    private static unsafe partial int SocketBind(int descriptor, byte* address, uint length);

    [LibraryImport("libc", EntryPoint = "clock_gettime", SetLastError = true)]
    private static partial int Clock(int clock, out ClockValue value);

    [LibraryImport("libc", EntryPoint = "statx", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Stat(int descriptor, string path, int flags, uint mask, out FileIdentity identity);

    [LibraryImport("libc", EntryPoint = "fstatfs", SetLastError = true)]
    private static partial int Filesystem(int descriptor, out FilesystemIdentity identity);

    internal static SafeFileHandle Own(int descriptor)
        => descriptor >= 0 ? new((nint)descriptor, ownsHandle: true)
            : throw new InvalidDataException("writer_lease_control_open_blocked");

    internal static int Descriptor(SafeFileHandle handle) => checked((int)handle.DangerousGetHandle());

    internal static FileIdentity Observe(SafeFileHandle handle)
    {
        if (Stat(Descriptor(handle), string.Empty, 0x1000, 0x10f, out FileIdentity identity) != 0
            || (identity._mask & 0x10f) != 0x10f)
        {
            throw new InvalidDataException("writer_lease_permissions_unavailable");
        }

        return identity;
    }

    internal static void RequirePrivate(SafeFileHandle handle, bool directory)
    {
        FileIdentity identity = Observe(handle);
        uint type = directory ? 0x4000u : 0x8000u;
        uint permissions = directory ? 0x1c0u : 0x180u;
        if (identity._uid != CurrentUser() || (identity._mode & 0xf000) != type
            || (identity._mode & 0xfff) != permissions || (!directory && identity._links != 1))
        {
            throw new InvalidDataException("writer_lease_permissions_blocked");
        }

        if (Filesystem(Descriptor(handle), out FilesystemIdentity filesystem) != 0
            || filesystem._type is not (0x01021994 or 0xef53 or 0x9123683e or 0x58465342 or 0xf2f52010))
        {
            throw new InvalidDataException("writer_lease_control_filesystem_unsupported");
        }
    }

    internal static long BootMilliseconds()
    {
        if (Clock(7, out ClockValue value) != 0 || value._seconds < 0 || value._nanoseconds is < 0 or >= 1000000000)
        {
            throw new InvalidDataException("writer_lease_boot_clock_unavailable");
        }

        return checked(value._seconds * 1000 + value._nanoseconds / 1000000);
    }

    internal static FileIdentity RequirePrivateSocket(string path)
    {
        FileIdentity identity = ObserveSocket(path);
        if ((identity._mode & 0xfff) != 0x180)
        {
            throw new InvalidDataException("agent_ipc_socket_permissions_blocked");
        }

        return identity;
    }

    internal static FileIdentity ObserveSocket(string path)
    {
        if (Stat(-100, path, 0x100, 0x10f, out FileIdentity identity) != 0
            || (identity._mask & 0x10f) != 0x10f || identity._uid != CurrentUser()
            || (identity._mode & 0xf000) != 0xc000 || identity._links != 1)
        {
            throw new InvalidDataException("agent_ipc_socket_identity_blocked");
        }

        return identity;
    }

    internal static unsafe Socket CreateLocalListener(string path)
    {
        byte[] name = Encoding.UTF8.GetBytes(path);
        if (name.Length is < 1 or > 107 || path.IndexOf('\0') >= 0)
        {
            throw new InvalidDataException("agent_ipc_endpoint_name_invalid");
        }

        var handle = new SafeSocketHandle((nint)SocketCreate(1, 1 | 0x80000, 0), ownsHandle: true);
        try
        {
            if (handle.IsInvalid)
            {
                throw new InvalidDataException("agent_ipc_native_socket_unavailable");
            }

            Span<byte> address = stackalloc byte[110];
            address.Clear();
            address[0] = 1; // AF_UNIX on the admitted little-endian Linux X64/Arm64 ABI.
            name.CopyTo(address[2..]);
            fixed (byte* pointer = address)
            {
                if (SocketBind(checked((int)handle.DangerousGetHandle()), pointer, checked((uint)name.Length + 3)) != 0)
                {
                    throw new InvalidDataException("agent_ipc_endpoint_exists_or_bind_blocked");
                }
            }

            // Managed Socket.Bind tracks a pathname and unconditionally unlinks it on Dispose.
            // Wrapping an already-bound native handle retains explicit identity-checked cleanup.
            return new Socket(handle);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal static void RequireCurrentUserPeer(Socket socket)
    {
        uint length = 12;
        if (socket.AddressFamily != AddressFamily.Unix || !socket.Connected
            || SocketPeer(checked((int)socket.Handle), 1, 17, out PeerIdentity peer, ref length) != 0
            || length != 12 || peer._uid != CurrentUser() || peer._processIdentity <= 0)
        {
            throw new InvalidDataException("agent_ipc_cross_user_or_remote_peer");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PeerIdentity
    {
        internal int _processIdentity;
        internal uint _uid;
        internal uint _gid;
    }

    [StructLayout(LayoutKind.Explicit, Size = 120)]
    private struct FilesystemIdentity
    {
        [FieldOffset(0)] internal long _type;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ClockValue
    {
        internal long _seconds;
        internal long _nanoseconds;
    }

    // Fixed Linux statx UAPI, independent of libc's architecture-specific stat layout.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    internal struct FileIdentity
    {
        [FieldOffset(0)] internal uint _mask;
        [FieldOffset(16)] internal uint _links;
        [FieldOffset(20)] internal uint _uid;
        [FieldOffset(28)] internal ushort _mode;
        [FieldOffset(32)] internal ulong _inode;
        [FieldOffset(136)] internal uint _deviceMajor;
        [FieldOffset(140)] internal uint _deviceMinor;
    }
}
