using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

// Ordinary factory/reader connection only. No Windows allocation or page operation is invoked.
public sealed class OsWindowsPageGeometryIntegrationTests
{
    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void FactoryUsesTheObservedPageUnitAndPreservesIndependentGeometry(MemoryCapabilityMode mode)
    {
        int systemCalls = 0;
        int largePageCalls = 0;
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(OsPageStrategy.Normal, mode, requested =>
        {
            Assert.Equal(mode, requested);
            return WindowsPageGeometryReader.Observe(requested, true, () =>
            {
                systemCalls++;
                return new WindowsSystemInfo { PageSize = 16384, AllocationGranularity = 65536 };
            }, () =>
            {
                largePageCalls++;
                return 2097152;
            }, TimeProvider.System);
        }, out WindowsPageGeometryObservation? geometry);

        WindowsOsPageNativeApi windows = Assert.IsType<WindowsOsPageNativeApi>(native);
        Assert.Same(geometry, windows.Geometry);
        Assert.Equal(16384, windows.PageBytes);
        Assert.Equal(16384, windows.PageBytes);
        Assert.Equal((nuint)65536, geometry!.AllocationGranularity.Bytes);
        Assert.Equal((nuint)2097152, geometry.MinimumLargePageSize.Bytes);
        Assert.Equal("windows-virtualalloc", windows.Backend);
        Assert.False(windows.UsesExplicitLargePages);
        Assert.Equal(1, systemCalls);
        Assert.Equal(1, largePageCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LargePageAbsenceAndUnknownDoNotBecomeAnExplicitBackend(bool missingApi)
    {
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(OsPageStrategy.Normal, MemoryCapabilityMode.Auto,
            mode => WindowsPageGeometryReader.Observe(mode, true,
                () => new WindowsSystemInfo { PageSize = 4096, AllocationGranularity = 65536 },
                () => missingApi ? throw new EntryPointNotFoundException() : (nuint)0, TimeProvider.System), out var geometry);

        Assert.Equal(4096, Assert.IsType<WindowsOsPageNativeApi>(native).PageBytes);
        Assert.False(native!.UsesExplicitLargePages);
        Assert.Equal(missingApi ? MemoryDetection.Unknown : MemoryDetection.Unsupported,
            geometry!.MinimumLargePageSize.Detection);
        Assert.Equal(missingApi ? null : (nuint?)0, geometry.MinimumLargePageSize.Bytes);
    }

    [Fact]
    public void MissingPageUnitDoesNotFallBackToTheExecutingHostsPageSize()
    {
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(OsPageStrategy.Normal, MemoryCapabilityMode.Auto,
            mode => WindowsPageGeometryReader.Observe(mode, true,
                () => throw new DllNotFoundException(), () => 2097152, TimeProvider.System), out var geometry);

        Assert.Null(native);
        Assert.Equal(MemoryDetection.Unknown, geometry!.PageSize.Detection);
        Assert.Null(geometry.PageSize.Bytes);
        Assert.Equal(MemoryDetection.Present, geometry.MinimumLargePageSize.Detection);
        Assert.Equal((nuint)2097152, geometry.MinimumLargePageSize.Bytes);
    }

    [Theory]
    [InlineData(0U)]
    [InlineData(3U)]
    [InlineData(2147483648U)]
    [InlineData(uint.MaxValue)]
    public void UnusableRawPageUnitsRefuseConstructionWithoutTruncatingTheObservation(uint bytes)
    {
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(OsPageStrategy.Normal, MemoryCapabilityMode.Auto,
            mode => WindowsPageGeometryReader.Observe(mode, true,
                () => new WindowsSystemInfo { PageSize = bytes, AllocationGranularity = 65536 },
                () => 0, TimeProvider.System), out var geometry);

        Assert.Null(native);
        Assert.Equal(bytes == 0 ? null : (nuint?)bytes, geometry!.PageSize.Bytes);
        Assert.Equal(bytes == 0 ? MemoryDetection.Unknown : MemoryDetection.Present, geometry.PageSize.Detection);
        Assert.Equal((nuint)65536, geometry.AllocationGranularity.Bytes);
    }

    [Theory]
    [InlineData((int)OsPageStrategy.Normal)]
    [InlineData((int)OsPageStrategy.TransparentHint)]
    [InlineData((int)OsPageStrategy.ExplicitLarge)]
    public void DisabledStopsAtTheFactoryBeforeCallingTheRawReader(int strategyValue)
    {
        var strategy = (OsPageStrategy)strategyValue;
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(strategy, MemoryCapabilityMode.Disabled,
            _ => throw new InvalidOperationException("Unexpected reader call."), out var geometry);

        Assert.Null(native);
        Assert.Null(geometry);
        Assert.Null(OsPageNativeApi.Detect(out var actualGeometry, strategy, mode: MemoryCapabilityMode.Disabled));
        Assert.Null(actualGeometry);
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void ExplicitLargeStrategyRemainsUnsupportedBeforeRawDiscovery(MemoryCapabilityMode mode)
    {
        Assert.Null(OsPageNativeApi.DetectWindows(OsPageStrategy.ExplicitLarge, mode,
            _ => throw new InvalidOperationException("Unexpected reader call."), out var geometry));
        Assert.Null(geometry);
    }

    [Fact]
    public void NonWindowsObservationIsPreservedWithoutConstructingAWindowsAdapter()
    {
        IOsPageNativeApi? native = OsPageNativeApi.DetectWindows(OsPageStrategy.Normal, MemoryCapabilityMode.Auto,
            mode => WindowsPageGeometryReader.Observe(mode, false,
                () => throw new InvalidOperationException("Unexpected SDK call."),
                () => throw new InvalidOperationException("Unexpected SDK call."), TimeProvider.System), out var geometry);

        Assert.Null(native);
        Assert.Equal(MemoryDetection.Unsupported, geometry!.PageSize.Detection);
        Assert.Null(geometry.PageSize.Bytes);
        Assert.Equal("platform:non-windows", geometry.PageSize.Source);
    }

    [Fact]
    public void InvalidFactoryArgumentsFailBeforeRawDiscovery()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => OsPageNativeApi.DetectWindows((OsPageStrategy)99,
            MemoryCapabilityMode.Auto, _ => throw new InvalidOperationException("Unexpected reader call."), out _));
        Assert.Throws<ArgumentOutOfRangeException>(() => OsPageNativeApi.DetectWindows(OsPageStrategy.Normal,
            (MemoryCapabilityMode)99, _ => throw new InvalidOperationException("Unexpected reader call."), out _));
    }
}
