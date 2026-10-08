using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal interface IGpuMetalApi
{
    void RetainReference();
    void ReleaseReference();
    GpuDeviceIdentity Identity(nint device, Version osVersion, Architecture architecture);
    ulong MaximumBufferLength(nint device);
    void RetainObject(nint value);
    void ReleaseObject(nint value);
    nint CreateQueue(nint device);
    nint CreateBuffer(nint device, ulong bytes, bool shared, bool cpuReadback);
    ulong AllocatedSize(nint buffer);
    nint Contents(nint buffer);
    nint CreateCommand(nint queue);
    void EncodeCopy(nint command, nint source, nint destination, ulong bytes);
    void Commit(nint command);
    ulong Status(nint command);
}

/// <summary>64-bit macOS 14 Objective-C/Metal ABI. Every delegate uses its actual fixed native signature.</summary>
/// <remarks>API source: Apple metal-cpp macOS14/iOS17, commit 807c2cf7d2df9d30117d1031049af75733f535a2,
/// Metal/MTLDevice.hpp, MTLBlitCommandEncoder.hpp, MTLCommandBuffer.hpp, MTLResource.hpp and Foundation/NSTypes.hpp.
/// NS::UInteger is pointer-width; only the explicitly bound 64-bit profiles use ulong here.</remarks>
internal sealed class GpuMetalNativeApi : IGpuMetalApi
{
    private readonly IGpuNativeLibrary _metal;
    private readonly IGpuNativeLibrary _objectiveC;
    private readonly CopyDevices _copyDevices;
    private readonly RegisterSelector _registerSelector;
    private readonly PoolPush _poolPush;
    private readonly PoolPop _poolPop;
    private readonly SendPointer _pointer;
    private readonly SendInteger _integer;
    private readonly SendBoolean _boolean;
    private readonly SendResponds _responds;
    private readonly SendIndex _index;
    private readonly SendBuffer _buffer;
    private readonly SendVoid _void;
    private readonly SendCopy _copy;
    private readonly Dictionary<string, nint> _selectors = new(StringComparer.Ordinal);
    private nint _devices;
    private int _references = 1;

    public GpuMetalNativeApi(IGpuNativeLibrary metal, IGpuNativeLibrary objectiveC)
    {
        _metal = metal;
        _objectiveC = objectiveC;
        _copyDevices = metal.Bind<CopyDevices>("MTLCopyAllDevices");
        _registerSelector = objectiveC.Bind<RegisterSelector>("sel_registerName");
        _poolPush = objectiveC.Bind<PoolPush>("objc_autoreleasePoolPush");
        _poolPop = objectiveC.Bind<PoolPop>("objc_autoreleasePoolPop");
        _pointer = objectiveC.Bind<SendPointer>("objc_msgSend");
        _integer = objectiveC.Bind<SendInteger>("objc_msgSend");
        _boolean = objectiveC.Bind<SendBoolean>("objc_msgSend");
        _responds = objectiveC.Bind<SendResponds>("objc_msgSend");
        _index = objectiveC.Bind<SendIndex>("objc_msgSend");
        _buffer = objectiveC.Bind<SendBuffer>("objc_msgSend");
        _void = objectiveC.Bind<SendVoid>("objc_msgSend");
        _copy = objectiveC.Bind<SendCopy>("objc_msgSend");
        foreach (string selector in new[] { "respondsToSelector:", "count", "objectAtIndex:", "retain", "release",
            "registryID", "name", "UTF8String", "hasUnifiedMemory", "maxBufferLength", "newCommandQueue",
            "newBufferWithLength:options:", "allocatedSize", "contents", "commandBuffer", "blitCommandEncoder",
            "copyFromBuffer:sourceOffset:toBuffer:destinationOffset:size:", "endEncoding", "commit", "status" })
        {
            _selectors.Add(selector, Nonzero(_registerSelector(selector), "register-selector"));
        }
    }

    public int DeviceCount
    {
        get; private set;
    }

    public int Discover(int maximumDevices)
    {
        using var pool = Pool();
        _devices = _copyDevices();
        if (_devices == 0)
        {
            throw new GpuDriverException("copy-all-metal-devices", -1);
        }
        Require(_devices, "count", "objectAtIndex:");
        ulong count = _integer(_devices, Selector("count"));
        if (count > (ulong)maximumDevices)
        {
            throw new GpuMetalDeviceLimitException();
        }
        DeviceCount = checked((int)count);
        return DeviceCount;
    }

    public nint GetDevice(int index)
    {
        if ((uint)index >= (uint)DeviceCount)
        {
            throw new ArgumentOutOfRangeException(nameof(index));
        }
        return Nonzero(_index(_devices, Selector("objectAtIndex:"), (ulong)index), "get-metal-device");
    }

    public GpuDeviceIdentity Identity(nint device, Version osVersion, Architecture architecture)
    {
        using var pool = Pool();
        Require(device, "registryID", "name", "hasUnifiedMemory", "maxBufferLength", "newCommandQueue",
            "newBufferWithLength:options:");
        ulong registry = _integer(device, Selector("registryID"));
        if (registry == 0)
        {
            throw new GpuDriverException("metal-registry-identity-missing", -1);
        }
        nint name = Nonzero(_pointer(device, Selector("name")), "metal-name");
        Require(name, "UTF8String");
        string text = Marshal.PtrToStringUTF8(Nonzero(_pointer(name, Selector("UTF8String")), "metal-name-utf8"))
            ?? throw new GpuDriverException("metal-name-utf8", -1);
        return new($"Metal/macOS14/{architecture}", $"{osVersion}/registry:{registry:x16}", text, 1400,
            _boolean(device, Selector("hasUnifiedMemory")) != 0);
    }

    public ulong MaximumBufferLength(nint device) => _integer(device, Selector("maxBufferLength"));
    public void RetainReference() => Interlocked.Increment(ref _references);

    public void ReleaseReference()
    {
        if (Interlocked.Decrement(ref _references) == 0)
        {
            if (_devices != 0)
            {
                ReleaseObject(_devices);
            }
            _objectiveC.Dispose();
            _metal.Dispose();
        }
    }

    public void RetainObject(nint value) => Nonzero(_pointer(value, Selector("retain")), "retain-metal-object");
    public void ReleaseObject(nint value) => _void(value, Selector("release"));

    public nint CreateQueue(nint device)
    {
        using var pool = Pool();
        nint queue = Nonzero(_pointer(device, Selector("newCommandQueue")), "new-metal-queue");
        try
        {
            Require(queue, "commandBuffer");
            return queue;
        }
        catch
        {
            ReleaseObject(queue);
            throw;
        }
    }

    public nint CreateBuffer(nint device, ulong bytes, bool shared, bool cpuReadback)
    {
        using var pool = Pool();
        // MTLResourceStorageModePrivate = 2 << 4; shared upload uses CPUCacheModeWriteCombined = 1.
        ulong options = shared ? cpuReadback ? 0UL : 1UL : 32UL;
        nint buffer = _buffer(device, Selector("newBufferWithLength:options:"), bytes, options);
        if (buffer == 0)
        {
            // newBuffer returns nil when allocation cannot be made; no object was created.
            throw new GpuAllocationRejectedException();
        }
        try
        {
            Require(buffer, "allocatedSize");
            if (shared)
            {
                Require(buffer, "contents");
            }
            return buffer;
        }
        catch
        {
            ReleaseObject(buffer);
            throw;
        }
    }

    public nint Contents(nint buffer) => Nonzero(_pointer(buffer, Selector("contents")), "metal-shared-contents");
    public ulong AllocatedSize(nint buffer) => _integer(buffer, Selector("allocatedSize"));

    public nint CreateCommand(nint queue)
    {
        using var pool = Pool();
        nint command = Nonzero(_pointer(queue, Selector("commandBuffer")), "metal-command-buffer");
        Require(command, "blitCommandEncoder", "commit", "status");
        // commandBuffer is autoreleased; retain explicitly before the scoped pool drains.
        RetainObject(command);
        return command;
    }

    public void EncodeCopy(nint command, nint source, nint destination, ulong bytes)
    {
        using var pool = Pool();
        nint encoder = Nonzero(_pointer(command, Selector("blitCommandEncoder")), "metal-blit-encoder");
        Require(encoder, "copyFromBuffer:sourceOffset:toBuffer:destinationOffset:size:", "endEncoding");
        try
        {
            _copy(encoder, Selector("copyFromBuffer:sourceOffset:toBuffer:destinationOffset:size:"),
                source, 0, destination, 0, bytes);
        }
        finally
        {
            _void(encoder, Selector("endEncoding"));
        }
    }

    public void Commit(nint command)
    {
        using var pool = Pool();
        _void(command, Selector("commit"));
    }

    public ulong Status(nint command) => _integer(command, Selector("status"));

    private void Require(nint value, params string[] selectors)
    {
        foreach (string selector in selectors)
        {
            if (_responds(value, Selector("respondsToSelector:"), Selector(selector)) == 0)
            {
                throw new EntryPointNotFoundException($"Metal object lacks required selector {selector}.");
            }
        }
    }

    private nint Selector(string selector) => _selectors[selector];
    private AutoreleasePool Pool() => new(_poolPop, Nonzero(_poolPush(), "metal-autorelease-pool"));
    private static nint Nonzero(nint value, string operation)
        => value != 0 ? value : throw new GpuDriverException(operation, -1);

    private readonly struct AutoreleasePool(PoolPop pop, nint handle) : IDisposable
    {
        public void Dispose() => pop(handle);
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint CopyDevices();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint RegisterSelector([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint PoolPush();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void PoolPop(nint pool);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint SendPointer(nint value, nint selector);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate ulong SendInteger(nint value, nint selector);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate byte SendBoolean(nint value, nint selector);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate byte SendResponds(nint value, nint selector, nint argument);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint SendIndex(nint value, nint selector, ulong index);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate nint SendBuffer(nint value, nint selector, ulong length, ulong options);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SendVoid(nint value, nint selector);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SendCopy(nint value, nint selector, nint source, ulong sourceOffset,
        nint destination, ulong destinationOffset, ulong bytes);
}
