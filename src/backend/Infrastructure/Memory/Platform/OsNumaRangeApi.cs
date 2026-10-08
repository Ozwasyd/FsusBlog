using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal interface IOsNumaRangeApi
{
    OsPageCall Bind(nint address, nuint bytes, int node);
}

// PLATFORM: mbind sets policy on one still-uncommitted owned mapping, not thread
// affinity. First touch therefore has no dependency on request continuation IDs.
internal sealed class LinuxOsNumaRangeApi : IOsNumaRangeApi
{
    internal unsafe delegate OsPageCall BindCall(nint address, nuint bytes, int mode,
        ulong* nodeMask, nuint maximumNode, uint flags);

    public unsafe OsPageCall Bind(nint address, nuint bytes, int node)
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            return new(false, 95);
        }
        return Bind(address, bytes, node, CallNative);
    }

    internal static unsafe OsPageCall Bind(nint address, nuint bytes, int node, BindCall bind)
    {
        if (node is < 0 or >= 4096)
        {
            return new(false, 95);
        }
        int words = node / 64 + 1;
        ulong* mask = stackalloc ulong[words];
        new Span<ulong>(mask, words).Clear();
        mask[node / 64] = 1UL << (node % 64);
        try
        {
            // Linux get_nodes decrements maxnode before copying its bitmap. Include
            // the target bit after that decrement; at node 4095 this reads 64 words.
            nuint maximumNode = checked((nuint)(node + 2));
            return bind(address, bytes, 2, mask, maximumNode, 0);
        }
        catch (DllNotFoundException)
        {
            return new(false, 95);
        }
        catch (EntryPointNotFoundException)
        {
            return new(false, 95);
        }
    }

    private static unsafe OsPageCall CallNative(nint address, nuint bytes, int mode,
        ulong* nodeMask, nuint maximumNode, uint flags)
    {
        nint result = BindPages(address, bytes, mode, nodeMask, maximumNode, flags);
        return new(result == 0, result == 0 ? 0 : Marshal.GetLastPInvokeError());
    }

    [DllImport("libnuma.so.1", EntryPoint = "mbind", SetLastError = true)]
    private static extern unsafe nint BindPages(nint address, nuint length, int mode,
        ulong* nodeMask, nuint maximumNode, uint flags);
}
