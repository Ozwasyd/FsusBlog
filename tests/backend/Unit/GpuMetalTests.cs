using System.Linq.Expressions;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests;

// Isolated custody tests; these do not qualify macOS, Metal, or actual GPU execution.
public sealed class GpuMetalTests
{
    [Fact]
    public void DisabledDoesNotLoadFrameworksEvenWithAbsentPolicy()
    {
        var loader = new Loader();
        GpuNativeDiscoveryResult result = GpuMetalDiscovery.Discover(MemoryCapabilityMode.Disabled, null!, loader);
        Assert.Equal(GpuDiscoveryOutcome.Disabled, result.Outcome);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
        Assert.Empty(result.Sessions);
        Assert.Equal(0, loader.Loads);
    }

    [Fact]
    public void NonMacOSDoesNotLoadFrameworks()
    {
        if (OperatingSystem.IsMacOS())
        {
            return;
        }
        var loader = new Loader();
        var policy = new GpuMetalLoadPolicy(["/approved/Metal"], ["/approved/libobjc"],
            [new Version(14, 0, 0)], Architecture.Arm64, 2);
        Assert.Equal(GpuDiscoveryOutcome.UnsupportedPlatform,
            GpuMetalDiscovery.Discover(MemoryCapabilityMode.Auto, policy, loader).Outcome);
        Assert.Equal(0, loader.Loads);
    }

    [Fact]
    public void PolicyCopiesListsAndRejectsUnboundOsArchitecturePathsAndLimits()
    {
        string[] paths = ["/approved/Metal"];
        Version[] versions = [new(14, 2, 1)];
        var policy = new GpuMetalLoadPolicy(paths, ["/approved/libobjc"], versions, Architecture.X64, 2);
        paths[0] = "/other/Metal";
        versions[0] = new(15, 0, 0);
        Assert.Equal("/approved/Metal", Assert.Single(policy.ApprovedMetalPaths));
        Assert.Equal(new Version(14, 2, 1), Assert.Single(policy.ApprovedOsVersions));
        Assert.Throws<ArgumentException>(() => new GpuMetalLoadPolicy(["Metal"], ["/objc"],
            [new Version(14, 0, 0)], Architecture.X64, 1));
        Assert.Throws<ArgumentException>(() => new GpuMetalLoadPolicy(["/a/../Metal"], ["/objc"],
            [new Version(14, 0, 0)], Architecture.X64, 1));
        Assert.Throws<ArgumentException>(() => new GpuMetalLoadPolicy(["/Metal"], ["/objc"],
            [new Version(14, 0)], Architecture.X64, 1));
        Assert.Throws<ArgumentException>(() => new GpuMetalLoadPolicy(["/Metal"], ["/objc"],
            [new Version(15, 0, 0)], Architecture.X64, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => new GpuMetalLoadPolicy(["/Metal"], ["/objc"],
            [new Version(14, 0, 0)], Architecture.X86, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => new GpuMetalLoadPolicy(["/Metal"], ["/objc"],
            [new Version(14, 0, 0)], Architecture.X64, 0));
    }

    [Fact]
    public void UploadAndReadbackUseOpaquePrivateHandlesAndRealSharedContents()
    {
        using var api = new Api();
        using var session = Session(api);
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress upload = session.AllocateHost(4, cpuReadback: false);
        GpuHostAddress readback = session.AllocateHost(4, cpuReadback: true);
        Assert.True(session.Identity.SharesHostCapacity);
        Assert.NotEqual(device.Value, unchecked((ulong)upload.Value));
        Assert.Equal(1, api.PrivateAllocations);
        Assert.Equal(new[] { false, true }, api.HostReadbackAttributes);
        session.WriteHost(upload, [1, 2, 3, 4]);
        GpuSubmission first = session.SubmitUpload(upload, device, 4);
        Assert.Equal(GpuCompletion.Complete, session.Query(first));
        session.ReleaseSubmission(first);
        GpuSubmission second = session.SubmitReadback(device, readback, 4);
        session.ReleaseSubmission(second);
        byte[] output = new byte[4];
        session.ReadHost(readback, output);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, output);
        session.FreeHost(upload);
        session.FreeHost(readback);
        session.FreeDevice(device);
        Assert.Equal(2, api.ReleasedCommands);
    }

    [Theory]
    [InlineData(0UL)]
    [InlineData(1UL)]
    [InlineData(2UL)]
    [InlineData(3UL)]
    public void PendingCommandRetainsAllHoldsAndBlocksHostReuse(ulong status)
    {
        using var api = new Api { CommandStatus = status };
        using var session = Session(api);
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress host = session.AllocateHost(4, false);
        GpuSubmission submission = session.SubmitUpload(host, device, 4);
        Assert.Equal(GpuCompletion.Pending, session.Query(submission));
        Assert.Throws<InvalidOperationException>(() => session.FreeHost(host));
        Assert.Throws<InvalidOperationException>(() => session.FreeDevice(device));
        Assert.Throws<InvalidOperationException>(() => session.WriteHost(host, [9]));
        Assert.Throws<InvalidOperationException>(() => session.ReadHost(host, new byte[1]));
        Assert.Throws<InvalidOperationException>(() => session.ReleaseSubmission(submission));
        Assert.Throws<InvalidOperationException>(() => session.Dispose());
        Assert.Equal(0, api.ReleasedCommands);
        api.CommandStatus = 4;
        session.ReleaseSubmission(submission);
        session.FreeHost(host);
        session.FreeDevice(device);
    }

    [Theory]
    [InlineData(5UL)]
    [InlineData(99UL)]
    public void ErrorOrUnknownStatusPermanentlyQuarantinesNativeObjects(ulong status)
    {
        using var api = new Api { CommandStatus = status };
        var session = Session(api);
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress host = session.AllocateHost(4, false);
        GpuSubmission submission = session.SubmitUpload(host, device, 4);
        Assert.Equal(GpuCompletion.Uncertain, session.Query(submission));
        api.CommandStatus = 4;
        Assert.Equal(GpuCompletion.Uncertain, session.Query(submission));
        Assert.Throws<InvalidOperationException>(() => session.FreeHost(host));
        Assert.Throws<InvalidOperationException>(() => session.FreeDevice(device));
        Assert.Throws<InvalidOperationException>(() => session.ReleaseSubmission(submission));
        Assert.Throws<InvalidOperationException>(() => session.AllocateDevice(4));
        Assert.Throws<InvalidOperationException>(() => session.Dispose());
        Assert.Equal(0, api.ReleasedCommands);
        Assert.Equal(1, api.References);
    }

    [Fact]
    public void ThrowAfterCommitRetainsBuffersQueueDeviceAndLibrary()
    {
        using var api = new Api { ThrowAfterCommit = true };
        var session = Session(api);
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress host = session.AllocateHost(4, false);
        Assert.Throws<GpuDriverException>(() => session.SubmitUpload(host, device, 4));
        Assert.Throws<InvalidOperationException>(() => session.FreeHost(host));
        Assert.Throws<InvalidOperationException>(() => session.FreeDevice(device));
        Assert.Throws<InvalidOperationException>(() => session.Dispose());
        Assert.Equal(0, api.ReleasedCommands);
        Assert.Equal(0, api.ReleasedQueueOrDevice);
        Assert.Equal(1, api.References);
    }

    [Fact]
    public void BoundsAndOwnershipAreCheckedBeforeNativeSubmission()
    {
        using var api = new Api { MaximumLength = 4 };
        using var session = Session(api);
        Assert.Throws<ArgumentOutOfRangeException>(() => session.AllocateDevice(5));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.AllocateHost(0, false));
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress host = session.AllocateHost(4, false);
        Assert.Throws<ArgumentOutOfRangeException>(() => session.WriteHost(host, new byte[5]));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.SubmitUpload(host, device, 5));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.SubmitUpload(new(42), device, 4));
        Assert.Equal(0, api.CommandsCreated);
        session.FreeHost(host);
        session.FreeDevice(device);
    }

    [Fact]
    public void MissingMaximumLengthDoesNotBecomeAnUnlimitedGrant()
    {
        using var api = new Api { MaximumLength = 0 };
        Assert.Throws<GpuDriverException>(() => Session(api));
        Assert.Equal(0, api.References);
        Assert.Equal(0, api.CommandsCreated);
    }

    [Theory]
    [InlineData(32UL)]
    [InlineData(0UL)]
    public void PhysicalCapacityComesFromNativeResourceAndMissingSignalRemainsUnknown(ulong nativeCapacity)
    {
        using var api = new Api { ReportedCapacity = nativeCapacity };
        using var session = Session(api);
        GpuDeviceAddress device = session.AllocateDevice(4);
        GpuHostAddress host = session.AllocateHost(4, false);
        ulong? expected = nativeCapacity == 0 ? null : nativeCapacity;
        Assert.Equal(expected, session.ObservedDeviceCapacity(device));
        Assert.Equal(expected, session.ObservedHostCapacity(host));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.ObservedDeviceCapacity(new(99)));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.ObservedHostCapacity(new(99)));
        session.FreeHost(host);
        session.FreeDevice(device);
        Assert.Throws<ArgumentOutOfRangeException>(() => session.ObservedDeviceCapacity(device));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.ObservedHostCapacity(host));
    }

    [Fact]
    public void NativeDispatchUsesBoundSymbolsAttributesAndRetainedCommands()
    {
        using var library = new DispatchLibrary();
        var api = new GpuMetalNativeApi(library, library);
        Assert.Equal(1, api.Discover(2));
        Assert.Equal((nint)100, api.GetDevice(0));
        Assert.True(api.Identity(100, new Version(14, 0, 0), Architecture.Arm64).SharesHostCapacity);
        api.CreateBuffer(100, 8, shared: false, cpuReadback: false);
        api.CreateBuffer(100, 8, shared: true, cpuReadback: false);
        api.CreateBuffer(100, 8, shared: true, cpuReadback: true);
        Assert.Equal(new ulong[] { 32, 1, 0 }, library.BufferOptions);
        Assert.Equal(24UL, api.AllocatedSize(201));
        nint command = api.CreateCommand(api.CreateQueue(100));
        api.EncodeCopy(command, 201, 202, 8);
        api.Commit(command);
        Assert.Equal(4UL, api.Status(command));
        Assert.Contains((command, "retain"), library.ObjectCalls);
        Assert.Equal(new object[] { (nint)201, 0UL, (nint)202, 0UL, 8UL }, library.CopyArguments);
        api.ReleaseObject(command);
        api.ReleaseReference();
        Assert.Equal(library.PoolPushes, library.PoolPops);
        Assert.Contains("MTLCopyAllDevices", library.Symbols);
        Assert.Contains("sel_registerName", library.Symbols);
        Assert.Contains("objc_msgSend", library.Symbols);
        Assert.Equal(2, library.LibraryDisposals);
    }

    [Fact]
    public void NativeDiscoveryCountLimitStopsBeforeCreatingDeviceObjects()
    {
        using var library = new DispatchLibrary { DeviceCount = 3 };
        var api = new GpuMetalNativeApi(library, library);
        Assert.Throws<GpuMetalDeviceLimitException>(() => api.Discover(2));
        Assert.DoesNotContain(library.ObjectCalls, call => call.Selector == "objectAtIndex:");
        api.ReleaseReference();
        Assert.Contains(((nint)10, "release"), library.ObjectCalls);
        Assert.Equal(library.PoolPushes, library.PoolPops);
    }

    [Fact]
    public void MissingSelectorDoesNotSilentlyInventUnifiedMemorySignal()
    {
        using var library = new DispatchLibrary { MissingSelector = "hasUnifiedMemory" };
        var api = new GpuMetalNativeApi(library, library);
        api.Discover(2);
        Assert.Throws<EntryPointNotFoundException>(() => api.Identity(100, new Version(14, 0, 0), Architecture.X64));
        api.ReleaseReference();
        Assert.Equal(library.PoolPushes, library.PoolPops);
    }

    private static GpuMetalSession Session(Api api) => new(api, 1, new Version(14, 0, 0), Architecture.Arm64);

    private sealed class Loader : IGpuNativeLibraryLoader
    {
        public int Loads
        {
            get; private set;
        }
        public IGpuNativeLibrary? TryLoad(string path)
        {
            Loads++;
            throw new InvalidOperationException("Disabled/unsupported discovery must never load.");
        }
    }

    private sealed class DispatchLibrary : IGpuNativeLibrary
    {
        private readonly Dictionary<string, nint> _selectors = new(StringComparer.Ordinal);
        private nint _name = Marshal.StringToCoTaskMemUTF8("simulated Metal");
        public string AbsolutePath => "/approved/unit";
        public ulong DeviceCount { get; init; } = 1;
        public string? MissingSelector
        {
            get; init;
        }
        public List<string> Symbols { get; } = new();
        public List<(nint Object, string Selector)> ObjectCalls { get; } = new();
        public List<ulong> BufferOptions { get; } = new();
        public object[]? CopyArguments
        {
            get; private set;
        }
        public int LibraryDisposals
        {
            get; private set;
        }
        public int PoolPushes
        {
            get; private set;
        }
        public int PoolPops
        {
            get; private set;
        }

        public T Bind<T>(string symbol) where T : Delegate
        {
            Symbols.Add(symbol);
            var invoke = typeof(T).GetMethod("Invoke")!;
            ParameterExpression[] parameters = invoke.GetParameters()
                .Select(parameter => Expression.Parameter(parameter.ParameterType, parameter.Name)).ToArray();
            var call = Expression.Call(Expression.Constant(this), nameof(Dispatch), null,
                Expression.Constant(symbol), Expression.NewArrayInit(typeof(object),
                    parameters.Select(parameter => Expression.Convert(parameter, typeof(object)))));
            Expression body = invoke.ReturnType == typeof(void) ? Expression.Block(call, Expression.Empty())
                : Expression.Convert(call, invoke.ReturnType);
            return Expression.Lambda<T>(body, parameters).Compile();
        }

        public object? Dispatch(string symbol, object[] arguments)
        {
            if (symbol == "MTLCopyAllDevices")
            {
                return (nint)10;
            }
            if (symbol == "sel_registerName")
            {
                string name = (string)arguments[0];
                nint selector = (nint)(_selectors.Count + 1);
                _selectors.Add(name, selector);
                return selector;
            }
            if (symbol == "objc_autoreleasePoolPush")
            {
                PoolPushes++;
                return (nint)500;
            }
            if (symbol == "objc_autoreleasePoolPop")
            {
                PoolPops++;
                return null;
            }
            nint receiver = (nint)arguments[0];
            string member = _selectors.Single(pair => pair.Value == (nint)arguments[1]).Key;
            ObjectCalls.Add((receiver, member));
            switch (member)
            {
                case "respondsToSelector:":
                    string requested = _selectors.Single(pair => pair.Value == (nint)arguments[2]).Key;
                    return (byte)(requested == MissingSelector ? 0 : 1);
                case "count":
                    return DeviceCount;
                case "objectAtIndex:":
                    return (nint)(100 + (long)(ulong)arguments[2]);
                case "registryID":
                    return 1234UL;
                case "hasUnifiedMemory":
                    return (byte)1;
                case "maxBufferLength":
                    return 1024UL;
                case "allocatedSize":
                    return 24UL;
                case "name":
                    return (nint)40;
                case "UTF8String":
                    return _name;
                case "newCommandQueue":
                    return (nint)50;
                case "newBufferWithLength:options:":
                    BufferOptions.Add((ulong)arguments[3]);
                    return (nint)(200 + BufferOptions.Count);
                case "commandBuffer":
                    return (nint)60;
                case "blitCommandEncoder":
                    return (nint)70;
                case "copyFromBuffer:sourceOffset:toBuffer:destinationOffset:size:":
                    CopyArguments = arguments.Skip(2).ToArray();
                    return null;
                case "retain":
                    return receiver;
                case "status":
                    return 4UL;
                case "release":
                case "endEncoding":
                case "commit":
                    return null;
                default:
                    throw new InvalidOperationException(member);
            }
        }

        public void Dispose()
        {
            LibraryDisposals++;
            if (_name != 0)
            {
                Marshal.FreeCoTaskMem(_name);
                _name = 0;
            }
        }
    }

    private sealed class Api : IGpuMetalApi, IDisposable
    {
        private readonly Dictionary<nint, nint> _buffers = new();
        private readonly Dictionary<nint, (nint Source, nint Destination, int Bytes)> _commands = new();
        private long _next = 10;
        public ulong MaximumLength { get; init; } = 1024;
        public ulong ReportedCapacity { get; init; } = 32;
        public ulong CommandStatus { get; set; } = 4;
        public bool ThrowAfterCommit
        {
            get; init;
        }
        public int PrivateAllocations
        {
            get; private set;
        }
        public List<bool> HostReadbackAttributes { get; } = new();
        public int ReleasedCommands
        {
            get; private set;
        }
        public int ReleasedQueueOrDevice
        {
            get; private set;
        }
        public int References
        {
            get; private set;
        }
        public int CommandsCreated
        {
            get; private set;
        }
        public void RetainReference() => References++;
        public void ReleaseReference() => References--;
        public GpuDeviceIdentity Identity(nint device, Version version, Architecture architecture)
            => new("Metal/unit", "unit", "simulated", 1400, true);
        public ulong MaximumBufferLength(nint device) => MaximumLength;
        public void RetainObject(nint value)
        {
        }
        public nint CreateQueue(nint device) => 2;

        public nint CreateBuffer(nint device, ulong bytes, bool shared, bool cpuReadback)
        {
            nint handle = (nint)(++_next);
            _buffers.Add(handle, Marshal.AllocHGlobal(checked((int)bytes)));
            if (shared)
            {
                HostReadbackAttributes.Add(cpuReadback);
            }
            else
            {
                PrivateAllocations++;
            }
            return handle;
        }

        public nint Contents(nint buffer) => _buffers[buffer];
        public ulong AllocatedSize(nint buffer) => ReportedCapacity;
        public nint CreateCommand(nint queue)
        {
            CommandsCreated++;
            nint command = (nint)(++_next);
            _commands.Add(command, default);
            return command;
        }

        public void EncodeCopy(nint command, nint source, nint destination, ulong bytes)
            => _commands[command] = (source, destination, checked((int)bytes));

        public unsafe void Commit(nint command)
        {
            (nint source, nint destination, int bytes) = _commands[command];
            new ReadOnlySpan<byte>((void*)_buffers[source], bytes).CopyTo(new Span<byte>((void*)_buffers[destination], bytes));
            if (ThrowAfterCommit)
            {
                throw new GpuDriverException("commit", -1);
            }
        }

        public ulong Status(nint command) => CommandStatus;
        public void ReleaseObject(nint value)
        {
            if (_buffers.Remove(value, out nint memory))
            {
                Marshal.FreeHGlobal(memory);
            }
            else if (_commands.Remove(value))
            {
                ReleasedCommands++;
            }
            else
            {
                ReleasedQueueOrDevice++;
            }
        }

        public void Dispose()
        {
            // Only simulated CPU fixtures are reclaimed here; no native DMA exists in these tests.
            foreach (nint memory in _buffers.Values)
            {
                Marshal.FreeHGlobal(memory);
            }
            _buffers.Clear();
        }
    }
}
