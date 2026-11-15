using System.Runtime.InteropServices;

internal static class LinuxWorkerBoundary
{
    private const int Seccomp = 277;
    private const uint AuditArm64 = 0xc00000b7;
    private const uint Permit = 0x7fff0000;
    private const uint KillProcess = 0x80000000;
    private const uint Deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM

    internal static unsafe bool Seal()
    {
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.Arm64 || !BitConverter.IsLittleEndian ||
            Environment.GetEnvironmentVariable("FSUSBLOG_PURE_PLUGIN_WORKER") != "1" ||
            Prctl(21, 0, 0, 0, 0) != 2 || Prctl(39, 0, 0, 0, 0) != 1 ||
            !DeniedSocket(1) || !DeniedSocket(2) || !Hidden("/etc/passwd") || !Hidden("/sys/fs/cgroup")) return false;

        // Bubblewrap's first filter permits the one exec that initializes CoreCLR. After initialization,
        // synchronize a second filter across all existing threads before reading the control pipe.
        Span<Instruction> code = [
            new(0x20, 0, 0, 4),
            new(0x15, 1, 0, AuditArm64),
            new(0x06, 0, 0, KillProcess),
            new(0x20, 0, 0, 0),
            new(0x15, 2, 0, 221), // execve
            new(0x15, 1, 0, 281), // execveat
            new(0x15, 0, 1, Seccomp),
            new(0x06, 0, 0, Deny),
            new(0x06, 0, 0, Permit)
        ];
        fixed (Instruction* first = code)
        {
            var filter = new Filter((ushort)code.Length, first);
            // SECCOMP_SET_MODE_FILTER with SECCOMP_FILTER_FLAG_TSYNC.
            return Syscall(Seccomp, 1, 1, ref filter) == 0 && ExecIsDenied();
        }
    }

    private static bool ExecIsDenied() => Exec("/fsus-unavailable", 0, 0) == -1 && Marshal.GetLastPInvokeError() == 1;

    private static bool DeniedSocket(int family)
    {
        var fd = Socket(family, 1, 0);
        if (fd < 0) return Marshal.GetLastPInvokeError() == 1;
        _ = Close(fd);
        return false;
    }

    private static bool Hidden(string path)
    {
        var fd = Open(path, 0);
        if (fd < 0) return Marshal.GetLastPInvokeError() == 2;
        _ = Close(fd);
        return false;
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct Instruction(ushort Code, byte True, byte False, uint Operand);

    [StructLayout(LayoutKind.Sequential)]
    private readonly unsafe struct Filter(ushort count, Instruction* start)
    {
        public readonly ushort Count = count;
        public readonly Instruction* Start = start;
    }

    [DllImport("libc", EntryPoint = "prctl")]
    private static extern int Prctl(int option, nuint first, nuint second, nuint third, nuint fourth);

    [DllImport("libc", EntryPoint = "syscall", SetLastError = true)]
    private static extern nint Syscall(nint number, uint operation, uint flags, ref Filter filter);

    [DllImport("libc", EntryPoint = "socket", SetLastError = true)]
    private static extern int Socket(int domain, int type, int protocol);

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "close")]
    private static extern int Close(int descriptor);

    [DllImport("libc", EntryPoint = "execve", SetLastError = true)]
    private static extern int Exec([MarshalAs(UnmanagedType.LPUTF8Str)] string path, nint args, nint environment);
}
