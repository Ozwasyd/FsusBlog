using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal readonly record struct OsPageCall(bool Succeeded, int Error);

// PLATFORM: Only dedicated page owners call these adapters. No general-allocator
// pointer is rounded into a page range, and no machine-global policy is changed.
internal interface IOsPageNativeApi
{
    int PageBytes
    {
        get;
    }
    string Backend
    {
        get;
    }
    bool UsesExplicitLargePages
    {
        get;
    }
    nint Reserve(nuint bytes, out int error);
    OsPageCall Commit(nint address, nuint bytes);
    OsPageCall Protect(nint address, nuint bytes, bool writable);
    OsPageCall Decommit(nint address, nuint bytes);
    OsPageCall Lock(nint address, nuint bytes);
    OsPageCall Unlock(nint address, nuint bytes);
    OsPageCall HintTransparentLargePages(nint address, nuint bytes);
    OsPageCall Release(nint address, nuint bytes);
}

internal enum OsPageStrategy
{
    Normal,
    TransparentHint,
    ExplicitLarge
}

internal static class OsPageNativeApi
{
    // Detection alone never certifies release qualification or online activation.
    public static IOsPageNativeApi? Detect(OsPageStrategy strategy = OsPageStrategy.Normal,
        int explicitPageBytes = 2097152, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
        => Detect(out _, strategy, explicitPageBytes, mode);

    // Raw Windows geometry remains available even when no adapter can be built.
    // It is not a qualification, permission or resource-admission receipt.
    public static IOsPageNativeApi? Detect(out WindowsPageGeometryObservation? windowsGeometry,
        OsPageStrategy strategy = OsPageStrategy.Normal, int explicitPageBytes = 2097152,
        MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        windowsGeometry = null;
        if (!Enum.IsDefined(strategy))
        {
            throw new ArgumentOutOfRangeException(nameof(strategy));
        }
        if (MemoryCapabilityPolicy.Validate(mode) == MemoryCapabilityMode.Disabled)
        {
            return null;
        }
        if (strategy == OsPageStrategy.ExplicitLarge && explicitPageBytes == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(explicitPageBytes));
        }
        if (OperatingSystem.IsLinux())
        {
            return new LinuxOsPageNativeApi(strategy == OsPageStrategy.ExplicitLarge ? explicitPageBytes : 0);
        }
        return OperatingSystem.IsWindows()
            ? DetectWindows(strategy, mode, WindowsPageGeometryReader.Observe, out windowsGeometry) : null;
    }

    internal static IOsPageNativeApi? DetectWindows(OsPageStrategy strategy, MemoryCapabilityMode mode,
        Func<MemoryCapabilityMode, WindowsPageGeometryObservation> observe,
        out WindowsPageGeometryObservation? windowsGeometry)
    {
        windowsGeometry = null;
        if (!Enum.IsDefined(strategy))
        {
            throw new ArgumentOutOfRangeException(nameof(strategy));
        }
        if (MemoryCapabilityPolicy.Validate(mode) == MemoryCapabilityMode.Disabled
            || strategy == OsPageStrategy.ExplicitLarge)
        {
            return null;
        }
        ArgumentNullException.ThrowIfNull(observe);
        windowsGeometry = observe(mode);
        return WindowsOsPageNativeApi.TryCreate(windowsGeometry);
    }
}

internal sealed class LinuxOsPageNativeApi : IOsPageNativeApi
{
    private readonly int _explicitPageBytes;
    private readonly int _mappingFlags;

    public LinuxOsPageNativeApi(int explicitHugePageBytes = 0)
    {
        if (explicitHugePageBytes != 0 && (explicitHugePageBytes < Environment.SystemPageSize
            || (explicitHugePageBytes & (explicitHugePageBytes - 1)) != 0))
        {
            throw new ArgumentOutOfRangeException(nameof(explicitHugePageBytes));
        }
        _explicitPageBytes = explicitHugePageBytes;
        _mappingFlags = 0x22;
        if (explicitHugePageBytes != 0)
        {
            // MAP_HUGETLB and the explicit page-size order use the existing pool.
            // Failure never changes that pool, permissions or VM configuration.
            _mappingFlags |= 0x40000 | (System.Numerics.BitOperations.Log2((uint)explicitHugePageBytes) << 26);
        }
    }

    public int PageBytes => _explicitPageBytes == 0 ? Environment.SystemPageSize : _explicitPageBytes;
    public string Backend => UsesExplicitLargePages ? "linux-mmap-hugetlb" : "linux-mmap";
    public bool UsesExplicitLargePages => _explicitPageBytes != 0;

    public nint Reserve(nuint bytes, out int error)
    {
        nint address = Map(0, bytes, 0, _mappingFlags, -1, 0); // private anonymous, PROT_NONE
        error = address == -1 ? Marshal.GetLastPInvokeError() : 0;
        return address == -1 ? 0 : address;
    }

    public OsPageCall Commit(nint address, nuint bytes) => Result(ProtectPages(address, bytes, 3));
    public OsPageCall Protect(nint address, nuint bytes, bool writable)
        => Result(ProtectPages(address, bytes, writable ? 3 : 1));

    public OsPageCall Decommit(nint address, nuint bytes)
    {
        // PROT_NONE precedes DONTNEED. On discard failure keep the range
        // inaccessible; never restore access to content whose state is uncertain.
        OsPageCall protection = Result(ProtectPages(address, bytes, 0));
        return protection.Succeeded ? Result(Advise(address, bytes, 4)) : protection;
    }

    public OsPageCall Lock(nint address, nuint bytes) => Result(LockPages(address, bytes));
    public OsPageCall Unlock(nint address, nuint bytes) => Result(UnlockPages(address, bytes));
    public OsPageCall HintTransparentLargePages(nint address, nuint bytes)
        => UsesExplicitLargePages ? new(false, 95) : Result(Advise(address, bytes, 14));
    public OsPageCall Release(nint address, nuint bytes) => Result(Unmap(address, bytes));

    private static OsPageCall Result(int result)
        => new(result == 0, result == 0 ? 0 : Marshal.GetLastPInvokeError());

    [DllImport("libc", EntryPoint = "mmap", SetLastError = true)]
    private static extern nint Map(nint address, nuint length, int protection, int flags, int descriptor, nint offset);
    [DllImport("libc", EntryPoint = "mprotect", SetLastError = true)]
    private static extern int ProtectPages(nint address, nuint length, int protection);
    [DllImport("libc", EntryPoint = "madvise", SetLastError = true)]
    private static extern int Advise(nint address, nuint length, int advice);
    [DllImport("libc", EntryPoint = "mlock", SetLastError = true)]
    private static extern int LockPages(nint address, nuint length);
    [DllImport("libc", EntryPoint = "munlock", SetLastError = true)]
    private static extern int UnlockPages(nint address, nuint length);
    [DllImport("libc", EntryPoint = "munmap", SetLastError = true)]
    private static extern int Unmap(nint address, nuint length);
}

internal sealed class WindowsOsPageNativeApi : IOsPageNativeApi
{
    private WindowsOsPageNativeApi(WindowsPageGeometryObservation geometry, int pageBytes)
    {
        Geometry = geometry;
        PageBytes = pageBytes;
    }

    public WindowsPageGeometryObservation Geometry
    {
        get;
    }
    public int PageBytes
    {
        get;
    }
    public string Backend => "windows-virtualalloc";
    public bool UsesExplicitLargePages => false;

    internal static WindowsOsPageNativeApi? TryCreate(WindowsPageGeometryObservation geometry)
    {
        ArgumentNullException.ThrowIfNull(geometry);
        // Preserve the raw observation while refusing an unknown or unusable page
        // unit. Reservation alignment and minimum large-page size are separate.
        if (geometry.PageSize.Detection != MemoryDetection.Present
            || geometry.PageSize.Bytes is not nuint bytes || bytes == 0
            || bytes > int.MaxValue || (bytes & (bytes - 1)) != 0)
        {
            return null;
        }
        return new(geometry, checked((int)bytes));
    }

    public nint Reserve(nuint bytes, out int error)
    {
        nint address = Allocate(0, bytes, 0x2000, 1); // MEM_RESERVE, PAGE_NOACCESS
        error = address == 0 ? Marshal.GetLastPInvokeError() : 0;
        return address;
    }

    public OsPageCall Commit(nint address, nuint bytes)
    {
        nint allocated = Allocate(address, bytes, 0x1000, 4);
        return new(allocated == address, allocated == address ? 0 : Marshal.GetLastPInvokeError());
    }

    public OsPageCall Protect(nint address, nuint bytes, bool writable)
        => Result(ProtectPages(address, bytes, writable ? 4U : 2U, out _));
    public OsPageCall Decommit(nint address, nuint bytes) => Result(Free(address, bytes, 0x4000));
    public OsPageCall Lock(nint address, nuint bytes) => Result(LockPages(address, bytes));
    public OsPageCall Unlock(nint address, nuint bytes) => Result(UnlockPages(address, bytes));
    public OsPageCall HintTransparentLargePages(nint address, nuint bytes) => new(false, 50);
    public OsPageCall Release(nint address, nuint bytes) => Result(Free(address, 0, 0x8000));

    private static OsPageCall Result(bool result)
        => new(result, result ? 0 : Marshal.GetLastPInvokeError());

    [DllImport("kernel32.dll", EntryPoint = "VirtualAlloc", SetLastError = true)]
    private static extern nint Allocate(nint address, nuint size, uint allocationType, uint protection);
    [DllImport("kernel32.dll", EntryPoint = "VirtualProtect", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProtectPages(nint address, nuint size, uint protection, out uint oldProtection);
    [DllImport("kernel32.dll", EntryPoint = "VirtualFree", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Free(nint address, nuint size, uint freeType);
    [DllImport("kernel32.dll", EntryPoint = "VirtualLock", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LockPages(nint address, nuint size);
    [DllImport("kernel32.dll", EntryPoint = "VirtualUnlock", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnlockPages(nint address, nuint size);
}
