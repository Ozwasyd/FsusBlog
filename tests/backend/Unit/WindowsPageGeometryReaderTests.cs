using System.Reflection;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

// Ordinary ABI and synthetic mapping controls only; these do not qualify a Windows backend.
public sealed class WindowsPageGeometryReaderTests
{
    private static readonly DateTimeOffset s_observedAt = new(2026, 10, 9, 0, 0, 0, TimeSpan.Zero);
    private static readonly TimeProvider s_clock = new FixedClock();

    [Fact]
    public void SystemInfoLayoutMatchesSdkFieldWidthsAndPointerAlignment()
    {
        Assert.Contains(IntPtr.Size, new[] { 4, 8 });
        bool wide = IntPtr.Size == 8;
        Assert.Equal(wide ? 48 : 36, Marshal.SizeOf<WindowsSystemInfo>());
        AssertOffset(nameof(WindowsSystemInfo.ProcessorArchitecture), 0);
        AssertOffset(nameof(WindowsSystemInfo.Reserved), 2);
        AssertOffset(nameof(WindowsSystemInfo.PageSize), 4);
        AssertOffset(nameof(WindowsSystemInfo.MinimumApplicationAddress), 8);
        AssertOffset(nameof(WindowsSystemInfo.MaximumApplicationAddress), wide ? 16 : 12);
        AssertOffset(nameof(WindowsSystemInfo.ActiveProcessorMask), wide ? 24 : 16);
        AssertOffset(nameof(WindowsSystemInfo.NumberOfProcessors), wide ? 32 : 20);
        AssertOffset(nameof(WindowsSystemInfo.ProcessorType), wide ? 36 : 24);
        AssertOffset(nameof(WindowsSystemInfo.AllocationGranularity), wide ? 40 : 28);
        AssertOffset(nameof(WindowsSystemInfo.ProcessorLevel), wide ? 44 : 32);
        AssertOffset(nameof(WindowsSystemInfo.ProcessorRevision), wide ? 46 : 34);

        AssertFieldType(nameof(WindowsSystemInfo.ProcessorArchitecture), typeof(ushort));
        AssertFieldType(nameof(WindowsSystemInfo.Reserved), typeof(ushort));
        AssertFieldType(nameof(WindowsSystemInfo.PageSize), typeof(uint));
        AssertFieldType(nameof(WindowsSystemInfo.MinimumApplicationAddress), typeof(nint));
        AssertFieldType(nameof(WindowsSystemInfo.MaximumApplicationAddress), typeof(nint));
        AssertFieldType(nameof(WindowsSystemInfo.ActiveProcessorMask), typeof(nuint));
        AssertFieldType(nameof(WindowsSystemInfo.NumberOfProcessors), typeof(uint));
        AssertFieldType(nameof(WindowsSystemInfo.ProcessorType), typeof(uint));
        AssertFieldType(nameof(WindowsSystemInfo.AllocationGranularity), typeof(uint));
        AssertFieldType(nameof(WindowsSystemInfo.ProcessorLevel), typeof(ushort));
        AssertFieldType(nameof(WindowsSystemInfo.ProcessorRevision), typeof(ushort));
    }

    [Fact]
    public void ImportsUseExactKernel32ExportsAndSdkSignatures()
    {
        MethodInfo systemInfo = AssertImport("GetNativeSystemInfo");
        Assert.Equal(typeof(void), systemInfo.ReturnType);
        ParameterInfo parameter = Assert.Single(systemInfo.GetParameters());
        Assert.True(parameter.IsOut);
        Assert.Equal(typeof(WindowsSystemInfo).MakeByRefType(), parameter.ParameterType);

        MethodInfo largePageMinimum = AssertImport("GetLargePageMinimum");
        Assert.Equal(typeof(nuint), largePageMinimum.ReturnType);
        Assert.Empty(largePageMinimum.GetParameters());
        ParameterInfo mode = Assert.Single(typeof(WindowsPageGeometryReader)
            .GetMethods(BindingFlags.Static | BindingFlags.NonPublic)
            .Single(method => method.Name == "Observe" && method.GetParameters().Length == 1).GetParameters());
        Assert.Equal(MemoryCapabilityMode.Auto, mode.DefaultValue);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void DisabledMakesZeroNativeCalls(bool isWindows)
    {
        int systemCalls = 0;
        int largePageCalls = 0;
        WindowsPageGeometryObservation observation = WindowsPageGeometryReader.Observe(MemoryCapabilityMode.Disabled,
            isWindows, () =>
            {
                systemCalls++;
                throw new InvalidOperationException("Unexpected native call.");
            }, () =>
            {
                largePageCalls++;
                throw new InvalidOperationException("Unexpected native call.");
            }, s_clock);

        Assert.Equal(0, systemCalls);
        Assert.Equal(0, largePageCalls);
        AssertUnobserved(observation, MemoryDetection.Unknown, "policy:Disabled");
        AssertUnobserved(WindowsPageGeometryReader.Observe(MemoryCapabilityMode.Disabled), MemoryDetection.Unknown,
            "policy:Disabled", checkClock: false);
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void NonWindowsIsUnsupportedAndMakesZeroNativeCalls(MemoryCapabilityMode mode)
    {
        WindowsPageGeometryObservation observation = WindowsPageGeometryReader.Observe(mode, false,
            () => throw new InvalidOperationException("Unexpected native call."),
            () => throw new InvalidOperationException("Unexpected native call."), s_clock);
        AssertUnobserved(observation, MemoryDetection.Unsupported, "platform:non-windows");
        if (!OperatingSystem.IsWindows())
        {
            AssertUnobserved(WindowsPageGeometryReader.Observe(mode), MemoryDetection.Unsupported,
                "platform:non-windows", checkClock: false);
        }
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void EnabledObservationReadsEachApiOnceAndKeepsByteGranularitiesDistinct(MemoryCapabilityMode mode)
    {
        int systemCalls = 0;
        int largePageCalls = 0;
        WindowsPageGeometryObservation observation = WindowsPageGeometryReader.Observe(mode, true, () =>
        {
            systemCalls++;
            return new WindowsSystemInfo { PageSize = 4096, AllocationGranularity = 65536, ProcessorArchitecture = ushort.MaxValue };
        }, () =>
        {
            largePageCalls++;
            return 2 * 1024 * 1024;
        }, s_clock);

        Assert.Equal(1, systemCalls);
        Assert.Equal(1, largePageCalls);
        AssertValue(observation.PageSize, MemoryDetection.Present, 4096, "GetNativeSystemInfo");
        AssertValue(observation.AllocationGranularity, MemoryDetection.Present, 65536, "GetNativeSystemInfo");
        AssertValue(observation.MinimumLargePageSize, MemoryDetection.Present, 2097152, "GetLargePageMinimum");
        Assert.Equal(s_observedAt, observation.ObservedAt);
    }

    [Fact]
    public void ReturnedLargePageZeroIsUnsupportedRatherThanMissingOrSuccessful()
    {
        WindowsPageGeometryObservation observation = Observe(() => new() { PageSize = 4096, AllocationGranularity = 65536 }, () => 0);
        AssertValue(observation.MinimumLargePageSize, MemoryDetection.Unsupported, 0, "GetLargePageMinimum");
        Assert.Equal(MemoryDetection.Present, observation.PageSize.Detection);
        Assert.Equal(MemoryDetection.Present, observation.AllocationGranularity.Detection);
    }

    [Theory]
    [InlineData(0U, 65536U)]
    [InlineData(4096U, 0U)]
    [InlineData(0U, 0U)]
    public void UnreportedSystemSizesStayIndependentlyUnknown(uint pageSize, uint allocationGranularity)
    {
        WindowsPageGeometryObservation observation = Observe(() => new() { PageSize = pageSize, AllocationGranularity = allocationGranularity }, () => 2097152);
        AssertValue(observation.PageSize, pageSize == 0 ? MemoryDetection.Unknown : MemoryDetection.Present,
            pageSize == 0 ? null : (nuint)pageSize, "GetNativeSystemInfo");
        AssertValue(observation.AllocationGranularity, allocationGranularity == 0 ? MemoryDetection.Unknown : MemoryDetection.Present,
            allocationGranularity == 0 ? null : (nuint)allocationGranularity, "GetNativeSystemInfo");
        Assert.Equal(MemoryDetection.Present, observation.MinimumLargePageSize.Detection);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void UnavailableLargePageApiStaysUnknownWithoutErasingSystemSizes(int failure)
    {
        WindowsPageGeometryObservation observation = Observe(() => new() { PageSize = 4096, AllocationGranularity = 65536 },
            () => throw LoaderFailure(failure));
        AssertValue(observation.MinimumLargePageSize, MemoryDetection.Unknown, null, "GetLargePageMinimum");
        AssertValue(observation.PageSize, MemoryDetection.Present, 4096, "GetNativeSystemInfo");
        AssertValue(observation.AllocationGranularity, MemoryDetection.Present, 65536, "GetNativeSystemInfo");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void UnavailableSystemInfoApiStaysUnknownWithoutErasingReturnedLargePageZero(int failure)
    {
        WindowsPageGeometryObservation observation = Observe(() => throw LoaderFailure(failure), () => 0);
        AssertValue(observation.PageSize, MemoryDetection.Unknown, null, "GetNativeSystemInfo");
        AssertValue(observation.AllocationGranularity, MemoryDetection.Unknown, null, "GetNativeSystemInfo");
        AssertValue(observation.MinimumLargePageSize, MemoryDetection.Unsupported, 0, "GetLargePageMinimum");
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void MissingBothApisDoesNotFabricateAnySize(MemoryCapabilityMode mode)
    {
        WindowsPageGeometryObservation observation = WindowsPageGeometryReader.Observe(mode, true,
            () => throw new DllNotFoundException(), () => throw new DllNotFoundException(), s_clock);
        AssertValue(observation.PageSize, MemoryDetection.Unknown, null, "GetNativeSystemInfo");
        AssertValue(observation.AllocationGranularity, MemoryDetection.Unknown, null, "GetNativeSystemInfo");
        AssertValue(observation.MinimumLargePageSize, MemoryDetection.Unknown, null, "GetLargePageMinimum");
        Assert.Equal(s_observedAt, observation.ObservedAt);
    }

    [Fact]
    public void UnsignedSizesArePreservedWithoutSignedOrDwordTruncation()
    {
        nuint largePageSize = nuint.MaxValue;
        WindowsPageGeometryObservation observation = Observe(() => new() { PageSize = uint.MaxValue, AllocationGranularity = uint.MaxValue }, () => largePageSize);
        Assert.Equal((nuint)uint.MaxValue, observation.PageSize.Bytes);
        Assert.Equal((nuint)uint.MaxValue, observation.AllocationGranularity.Bytes);
        Assert.Equal(largePageSize, observation.MinimumLargePageSize.Bytes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void InvalidModeIsRejectedBeforeAnyNativeCall(bool isWindows)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => WindowsPageGeometryReader.Observe((MemoryCapabilityMode)99,
            isWindows, () => throw new InvalidOperationException("Unexpected native call."),
            () => throw new InvalidOperationException("Unexpected native call."), s_clock));
    }

    [Fact]
    public void NonLoaderFailuresAreNotHiddenAsMissingInformation()
    {
        Assert.Throws<InvalidOperationException>(() => Observe(() => throw new InvalidOperationException(), () => 0));
        Assert.Throws<InvalidOperationException>(() => Observe(() => new(), () => throw new InvalidOperationException()));
    }

    private static WindowsPageGeometryObservation Observe(Func<WindowsSystemInfo> systemInfo, Func<nuint> largePageMinimum)
        => WindowsPageGeometryReader.Observe(MemoryCapabilityMode.Auto, true, systemInfo, largePageMinimum, s_clock);

    private static void AssertOffset(string field, int offset)
        => Assert.Equal(offset, Marshal.OffsetOf<WindowsSystemInfo>(field).ToInt32());

    private static void AssertFieldType(string field, Type expected)
        => Assert.Equal(expected, typeof(WindowsSystemInfo).GetField(field)!.FieldType);

    private static MethodInfo AssertImport(string export)
    {
        MethodInfo method = typeof(WindowsPageGeometryReader).GetMethod(export, BindingFlags.Static | BindingFlags.NonPublic)!;
        DllImportAttribute import = method.GetCustomAttribute<DllImportAttribute>()!;
        Assert.Equal("kernel32.dll", import.Value);
        Assert.Equal(export, import.EntryPoint);
        Assert.True(import.ExactSpelling);
        Assert.False(import.SetLastError);
        Assert.Equal(CallingConvention.Winapi, import.CallingConvention);
        Assert.Equal(DllImportSearchPath.System32, method.GetCustomAttribute<DefaultDllImportSearchPathsAttribute>()!.Paths);
        return method;
    }

    private static void AssertValue(WindowsPageGeometryValue value, MemoryDetection detection, nuint? bytes, string export)
    {
        Assert.Equal(detection, value.Detection);
        Assert.Equal(bytes, value.Bytes);
        Assert.Equal($"kernel32.dll!{export}", value.Source);
    }

    private static void AssertUnobserved(WindowsPageGeometryObservation observation, MemoryDetection detection, string source, bool checkClock = true)
    {
        Assert.All(new[] { observation.PageSize, observation.AllocationGranularity, observation.MinimumLargePageSize }, value =>
        {
            Assert.Equal(detection, value.Detection);
            Assert.Null(value.Bytes);
            Assert.Equal(source, value.Source);
        });
        if (checkClock)
        {
            Assert.Equal(s_observedAt, observation.ObservedAt);
        }
    }

    private static Exception LoaderFailure(int failure) => failure switch
    {
        0 => new DllNotFoundException(),
        1 => new EntryPointNotFoundException(),
        _ => new BadImageFormatException()
    };

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_observedAt;
    }
}
