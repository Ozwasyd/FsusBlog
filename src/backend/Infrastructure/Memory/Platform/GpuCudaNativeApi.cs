using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

// INTEROP: CUDA 12 Driver API, Linux x64, exact _v2 exports for size_t/device pointers.
// Source: https://docs.nvidia.com/cuda/archive/12.6.3/cuda-driver-api/index.html
internal sealed class GpuCudaNativeApi : GpuNativeApi
{
    public override string Backend => "CUDA";
    private readonly GetInt _count;
    private readonly GetDevice _device;
    private readonly GetText _name;
    private readonly GetText _pci;
    private readonly Attribute _attribute;
    private readonly RetainContext _retain;
    private readonly ReleaseContext _release;
    private readonly Handle _push;
    private readonly GetHandle _pop;
    private readonly DeviceAlloc _allocate;
    private readonly DeviceFree _free;
    private readonly HostAlloc _hostAllocate;
    private readonly Handle _hostFree;
    private readonly CreateHandle _streamCreate;
    private readonly CreateHandle _eventCreate;
    private readonly Handle _streamDestroy;
    private readonly Handle _eventDestroy;
    private readonly Upload _upload;
    private readonly Readback _readback;
    private readonly RecordEvent _record;
    private readonly Handle _query;
    private readonly PeerAccess _canPeer;
    private readonly EnablePeerAccess _enablePeer;
    private readonly Handle _disablePeer;
    private readonly PeerCopy _copyPeer;

    public GpuCudaNativeApi(IGpuNativeLibrary library, GpuNativeLoadPolicy policy) : base(library)
    {
        GetInt version = Bind<GetInt>("cuDriverGetVersion");
        Check(version(out int actual), "cuDriverGetVersion");
        VerifyVersion(policy, actual);
        Init init = Bind<Init>("cuInit");
        Check(init(0), "cuInit");
        _count = Bind<GetInt>("cuDeviceGetCount");
        _device = Bind<GetDevice>("cuDeviceGet");
        _name = Bind<GetText>("cuDeviceGetName");
        _pci = Bind<GetText>("cuDeviceGetPCIBusId");
        _attribute = Bind<Attribute>("cuDeviceGetAttribute");
        _retain = Bind<RetainContext>("cuDevicePrimaryCtxRetain");
        _release = Bind<ReleaseContext>("cuDevicePrimaryCtxRelease_v2");
        _push = Bind<Handle>("cuCtxPushCurrent_v2");
        _pop = Bind<GetHandle>("cuCtxPopCurrent_v2");
        _allocate = Bind<DeviceAlloc>("cuMemAlloc_v2");
        _free = Bind<DeviceFree>("cuMemFree_v2");
        _hostAllocate = Bind<HostAlloc>("cuMemHostAlloc");
        _hostFree = Bind<Handle>("cuMemFreeHost");
        _streamCreate = Bind<CreateHandle>("cuStreamCreate");
        _eventCreate = Bind<CreateHandle>("cuEventCreate");
        _streamDestroy = Bind<Handle>("cuStreamDestroy_v2");
        _eventDestroy = Bind<Handle>("cuEventDestroy_v2");
        _upload = Bind<Upload>("cuMemcpyHtoDAsync_v2");
        _readback = Bind<Readback>("cuMemcpyDtoHAsync_v2");
        _record = Bind<RecordEvent>("cuEventRecord");
        _query = Bind<Handle>("cuEventQuery");
        _canPeer = Bind<PeerAccess>("cuDeviceCanAccessPeer");
        _enablePeer = Bind<EnablePeerAccess>("cuCtxEnablePeerAccess");
        _disablePeer = Bind<Handle>("cuCtxDisablePeerAccess");
        _copyPeer = Bind<PeerCopy>("cuMemcpyPeerAsync");
    }

    private int Device(int ordinal)
    {
        Check(_device(out int device, ordinal), "cuDeviceGet");
        return device;
    }
    public override int GetDeviceCount()
    {
        Check(_count(out int count), "cuDeviceGetCount");
        if (count < 0)
        {
            throw new GpuDriverException("cuDeviceGetCount", 1);
        }
        return count;
    }
    public override GpuDeviceIdentity GetIdentity(int device)
    {
        int nativeDevice = Device(device);
        var name = new StringBuilder(256);
        var pci = new StringBuilder(64);
        Check(_name(name, name.Capacity, nativeDevice), "cuDeviceGetName");
        Check(_pci(pci, pci.Capacity, nativeDevice), "cuDeviceGetPCIBusId");
        Check(_attribute(out int integrated, 18, nativeDevice), "cuDeviceGetAttribute:Integrated");
        return new(Backend, pci.ToString(), name.ToString(), Version, integrated != 0);
    }
    public override int CreateContext(int device, out nint context) => _retain(out context, Device(device));
    public override void DestroyContext(int device, nint context) => Check(_release(Device(device)), "cuDevicePrimaryCtxRelease_v2");
    public override nint Enter(int device, nint context)
    {
        Check(_push(context), "cuCtxPushCurrent_v2");
        return context;
    }
    public override void Exit(nint token)
    {
        Check(_pop(out nint popped), "cuCtxPopCurrent_v2");
        if (popped != token)
        {
            throw new GpuDriverException("cuCtxPopCurrent_v2:identity", 201);
        }
    }
    public override GpuDeviceAddress AllocateDevice(long bytes)
    {
        int status = _allocate(out ulong address, checked((nuint)bytes));
        RejectOutOfMemory(status);
        Check(status, "cuMemAlloc_v2");
        return new(address);
    }
    public override void FreeDevice(GpuDeviceAddress address) => Check(_free(address.Value), "cuMemFree_v2");
    public override GpuHostAddress AllocateHost(long bytes, bool readback)
    {
        int status = _hostAllocate(out nint address, checked((nuint)bytes), readback ? 0u : 4u);
        RejectOutOfMemory(status);
        Check(status, "cuMemHostAlloc");
        return new(address);
    }
    public override void FreeHost(GpuHostAddress address) => Check(_hostFree(address.Value), "cuMemFreeHost");
    public override nint CreateStream()
    {
        Check(_streamCreate(out nint stream, 1), "cuStreamCreate");
        return stream;
    }
    public override nint CreateEvent()
    {
        Check(_eventCreate(out nint result, 2), "cuEventCreate");
        return result;
    }
    public override void DestroyStream(nint stream) => Check(_streamDestroy(stream), "cuStreamDestroy_v2");
    public override void DestroyEvent(nint @event) => Check(_eventDestroy(@event), "cuEventDestroy_v2");
    public override void CopyUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes, nint stream)
        => Check(_upload(destination.Value, source.Value, checked((nuint)bytes), stream), "cuMemcpyHtoDAsync_v2");
    public override void CopyReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes, nint stream)
        => Check(_readback(destination.Value, source.Value, checked((nuint)bytes), stream), "cuMemcpyDtoHAsync_v2");
    public override void Record(nint @event, nint stream) => Check(_record(@event, stream), "cuEventRecord");
    public override int Query(nint @event) => _query(@event);
    public override MemoryDetection CanPeer(int source, int destination)
    {
        int status = _canPeer(out int accessible, Device(source), Device(destination));
        return status == 0 ? (accessible != 0 ? MemoryDetection.Present : MemoryDetection.Unsupported) : MemoryDetection.Faulted;
    }
    public override bool EnablePeer(int destination, nint destinationContext)
    {
        int status = _enablePeer(destinationContext, 0);
        if (status != 704)
        {
            Check(status, "cuCtxEnablePeerAccess");
        }
        return status == 0;
    }
    public override void DisablePeer(int destination, nint destinationContext)
        => Check(_disablePeer(destinationContext), "cuCtxDisablePeerAccess");
    public override void CopyPeer(GpuDeviceAddress source, int sourceDevice, nint sourceContext,
        GpuDeviceAddress destination, int destinationDevice, nint destinationContext, long bytes, nint stream)
        => Check(_copyPeer(destination.Value, destinationContext, source.Value, sourceContext,
            checked((nuint)bytes), stream), "cuMemcpyPeerAsync");

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Init(uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetInt(out int value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetDevice(out int device, int ordinal);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetText([Out] StringBuilder text, int length, int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Attribute(out int value, int attribute, int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int RetainContext(out nint context, int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int ReleaseContext(int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Handle(nint handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetHandle(out nint handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int DeviceAlloc(out ulong address, nuint bytes);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int DeviceFree(ulong address);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int HostAlloc(out nint address, nuint bytes, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int CreateHandle(out nint handle, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Upload(ulong destination, nint source, nuint bytes, nint stream);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Readback(nint destination, ulong source, nuint bytes, nint stream);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int RecordEvent(nint @event, nint stream);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int PeerAccess(out int accessible, int source, int destination);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int EnablePeerAccess(nint peerContext, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int PeerCopy(ulong destination, nint destinationContext, ulong source, nint sourceContext, nuint bytes, nint stream);
}
