using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal sealed record WindowsPageGeometryValue(MemoryDetection Detection, nuint? Bytes, string Source);

// AllocationGranularity is reservation-base alignment; PageSize is the ordinary page unit.
internal sealed record WindowsPageGeometryObservation(
    WindowsPageGeometryValue PageSize,
    WindowsPageGeometryValue AllocationGranularity,
    WindowsPageGeometryValue MinimumLargePageSize,
    DateTimeOffset ObservedAt);

// ABI: Microsoft win32metadata 76c04c2021ef4a831a6f1e06d9566002d746139b,
// generation/WinSDK/RecompiledIdlHeaders/um/sysinfoapi.h, SYSTEM_INFO.
// The first two WORDs represent the four-byte union's architecture/reserved view.
// Sequential layout follows the caller's pointer width; do not force a 64-bit size.
[StructLayout(LayoutKind.Sequential)]
internal struct WindowsSystemInfo
{
    public ushort ProcessorArchitecture;
    public ushort Reserved;
    public uint PageSize;
    public nint MinimumApplicationAddress;
    public nint MaximumApplicationAddress;
    public nuint ActiveProcessorMask;
    public uint NumberOfProcessors;
    public uint ProcessorType;
    public uint AllocationGranularity;
    public ushort ProcessorLevel;
    public ushort ProcessorRevision;
}

// PROVENANCE: Raw sizes in bytes, not allocation success, privilege, qualification,
// admission or ownership evidence. GetNativeSystemInfo can describe ARM64 emulation;
// the ABI's architecture fields are deliberately not exposed as hardware identity.
internal static class WindowsPageGeometryReader
{
    private const string SystemInfoSource = "kernel32.dll!GetNativeSystemInfo";
    private const string LargePageSource = "kernel32.dll!GetLargePageMinimum";

    internal static WindowsPageGeometryObservation Observe(MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
        => Observe(mode, OperatingSystem.IsWindows(), ReadSystemInfo, GetLargePageMinimum, TimeProvider.System);

    // The ordinary delegate seam tests mapping and call suppression without loading Windows APIs.
    internal static WindowsPageGeometryObservation Observe(MemoryCapabilityMode mode, bool isWindows,
        Func<WindowsSystemInfo> readSystemInfo, Func<nuint> readLargePageMinimum, TimeProvider clock)
    {
        MemoryCapabilityPolicy.Validate(mode);
        ArgumentNullException.ThrowIfNull(readSystemInfo);
        ArgumentNullException.ThrowIfNull(readLargePageMinimum);
        ArgumentNullException.ThrowIfNull(clock);

        if (mode == MemoryCapabilityMode.Disabled)
        {
            return Unobserved(MemoryDetection.Unknown, "policy:Disabled", clock.GetUtcNow());
        }
        if (!isWindows)
        {
            return Unobserved(MemoryDetection.Unsupported, "platform:non-windows", clock.GetUtcNow());
        }

        WindowsPageGeometryValue pageSize = new(MemoryDetection.Unknown, null, SystemInfoSource);
        WindowsPageGeometryValue allocationGranularity = new(MemoryDetection.Unknown, null, SystemInfoSource);
        try
        {
            WindowsSystemInfo info = readSystemInfo();
            pageSize = SystemSize(info.PageSize);
            allocationGranularity = SystemSize(info.AllocationGranularity);
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            // Missing loader/API information remains Unknown, independently of the other API.
        }

        WindowsPageGeometryValue minimumLargePageSize = new(MemoryDetection.Unknown, null, LargePageSource);
        try
        {
            nuint bytes = readLargePageMinimum();
            // A real zero return is documented as unsupported. It is distinct from no observation.
            minimumLargePageSize = new(bytes == 0 ? MemoryDetection.Unsupported : MemoryDetection.Present, bytes, LargePageSource);
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            // Do not replace an unavailable API with a fabricated zero or a successful capability.
        }

        return new(pageSize, allocationGranularity, minimumLargePageSize, clock.GetUtcNow());
    }

    private static WindowsPageGeometryValue SystemSize(uint bytes)
        => new(bytes == 0 ? MemoryDetection.Unknown : MemoryDetection.Present, bytes == 0 ? null : (nuint)bytes, SystemInfoSource);

    private static WindowsPageGeometryObservation Unobserved(MemoryDetection detection, string source, DateTimeOffset observedAt)
        => new(new(detection, null, source), new(detection, null, source), new(detection, null, source), observedAt);

    private static WindowsSystemInfo ReadSystemInfo()
    {
        GetNativeSystemInfo(out WindowsSystemInfo info);
        return info;
    }

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", EntryPoint = "GetNativeSystemInfo", ExactSpelling = true)]
    private static extern void GetNativeSystemInfo(out WindowsSystemInfo systemInfo);

    // ABI: Same pinned SDK, um/memoryapi.h. SIZE_T is unsigned and pointer-sized.
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("kernel32.dll", EntryPoint = "GetLargePageMinimum", ExactSpelling = true)]
    private static extern nuint GetLargePageMinimum();
}
