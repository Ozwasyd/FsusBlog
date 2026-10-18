using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

// INTEROP: HIP 6 runtime, Linux x64. No version-dependent hipDeviceProp_t struct is marshalled.
// Source: https://github.com/ROCm/HIP/blob/rocm-6.2.4/include/hip/hip_runtime_api.h
internal sealed class GpuHipNativeApi : GpuNativeApi
{
    public override string Backend => "HIP";
    private readonly GetInt _count;
    private readonly GetInt _getDevice;
    private readonly SetDevice _setDevice;
    private readonly GetText _name;
    private readonly GetText _pci;
    private readonly Attribute _attribute;
    private readonly Allocate _allocate;
    private readonly Handle _free;
    private readonly HostAllocate _hostAllocate;
    private readonly Handle _hostFree;
    private readonly CreateHandle _streamCreate;
    private readonly CreateHandle _eventCreate;
    private readonly Handle _streamDestroy;
    private readonly Handle _eventDestroy;
    private readonly Copy _copy;
    private readonly RecordEvent _record;
    private readonly Handle _query;
    private readonly PeerAccess _canPeer;
    private readonly EnablePeerAccess _enablePeer;
    private readonly SetDevice _disablePeer;
    private readonly PeerCopy _copyPeer;

    public GpuHipNativeApi(IGpuNativeLibrary library, GpuNativeLoadPolicy policy) : base(library)
    {
        GetInt version = Bind<GetInt>("hipRuntimeGetVersion");
        Check(version(out int actual), "hipRuntimeGetVersion");
        VerifyVersion(policy, actual);
        Init init = Bind<Init>("hipInit");
        Check(init(0), "hipInit");
        _count = Bind<GetInt>("hipGetDeviceCount");
        _getDevice = Bind<GetInt>("hipGetDevice");
        _setDevice = Bind<SetDevice>("hipSetDevice");
        _name = Bind<GetText>("hipDeviceGetName");
        _pci = Bind<GetText>("hipDeviceGetPCIBusId");
        _attribute = Bind<Attribute>("hipDeviceGetAttribute");
        _allocate = Bind<Allocate>("hipMalloc");
        _free = Bind<Handle>("hipFree");
        _hostAllocate = Bind<HostAllocate>("hipHostMalloc");
        _hostFree = Bind<Handle>("hipHostFree");
        _streamCreate = Bind<CreateHandle>("hipStreamCreateWithFlags");
        _eventCreate = Bind<CreateHandle>("hipEventCreateWithFlags");
        _streamDestroy = Bind<Handle>("hipStreamDestroy");
        _eventDestroy = Bind<Handle>("hipEventDestroy");
        _copy = Bind<Copy>("hipMemcpyAsync");
        _record = Bind<RecordEvent>("hipEventRecord");
        _query = Bind<Handle>("hipEventQuery");
        _canPeer = Bind<PeerAccess>("hipDeviceCanAccessPeer");
        _enablePeer = Bind<EnablePeerAccess>("hipDeviceEnablePeerAccess");
        _disablePeer = Bind<SetDevice>("hipDeviceDisablePeerAccess");
        _copyPeer = Bind<PeerCopy>("hipMemcpyPeerAsync");
    }

    public override int GetDeviceCount()
    {
        Check(_count(out int count), "hipGetDeviceCount");
        if (count < 0)
        {
            throw new GpuDriverException("hipGetDeviceCount", 1);
        }
        return count;
    }
    public override GpuDeviceIdentity GetIdentity(int device)
    {
        var name = new StringBuilder(256);
        var pci = new StringBuilder(64);
        Check(_name(name, name.Capacity, device), "hipDeviceGetName");
        Check(_pci(pci, pci.Capacity, device), "hipDeviceGetPCIBusId");
        // HIP's integrated attribute is 16, unlike CUDA's 18.
        Check(_attribute(out int integrated, 16, device), "hipDeviceGetAttribute:Integrated");
        return new(Backend, pci.ToString(), name.ToString(), Version, integrated != 0);
    }
    // HIP AMD uses its primary device context. Session ownership never resets global runtime state.
    public override int CreateContext(int device, out nint context)
    {
        context = 0;
        return 0;
    }
    public override void DestroyContext(int device, nint context)
    {
    }
    public override nint Enter(int device, nint context)
    {
        Check(_getDevice(out int previous), "hipGetDevice");
        Check(_setDevice(device), "hipSetDevice");
        return previous;
    }
    public override void Exit(nint token) => Check(_setDevice(checked((int)token)), "hipSetDevice:restore");
    public override GpuDeviceAddress AllocateDevice(long bytes)
    {
        int status = _allocate(out nint address, checked((nuint)bytes));
        RejectOutOfMemory(status);
        Check(status, "hipMalloc");
        return new(unchecked((ulong)address));
    }
    public override void FreeDevice(GpuDeviceAddress address) => Check(_free(unchecked((nint)address.Value)), "hipFree");
    public override GpuHostAddress AllocateHost(long bytes, bool readback)
    {
        int status = _hostAllocate(out nint address, checked((nuint)bytes), readback ? 0u : 4u);
        RejectOutOfMemory(status);
        Check(status, "hipHostMalloc");
        return new(address);
    }
    public override void FreeHost(GpuHostAddress address) => Check(_hostFree(address.Value), "hipHostFree");
    public override nint CreateStream()
    {
        Check(_streamCreate(out nint stream, 1), "hipStreamCreateWithFlags");
        return stream;
    }
    public override nint CreateEvent()
    {
        Check(_eventCreate(out nint result, 2), "hipEventCreateWithFlags");
        return result;
    }
    public override void DestroyStream(nint stream) => Check(_streamDestroy(stream), "hipStreamDestroy");
    public override void DestroyEvent(nint @event) => Check(_eventDestroy(@event), "hipEventDestroy");
    public override void CopyUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes, nint stream)
        => Check(_copy(unchecked((nint)destination.Value), source.Value, checked((nuint)bytes), 1, stream), "hipMemcpyAsync:upload");
    public override void CopyReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes, nint stream)
        => Check(_copy(destination.Value, unchecked((nint)source.Value), checked((nuint)bytes), 2, stream), "hipMemcpyAsync:readback");
    public override void Record(nint @event, nint stream) => Check(_record(@event, stream), "hipEventRecord");
    public override int Query(nint @event) => _query(@event);
    public override MemoryDetection CanPeer(int source, int destination)
    {
        int status = _canPeer(out int accessible, source, destination);
        return status == 0 ? (accessible != 0 ? MemoryDetection.Present : MemoryDetection.Unsupported) : MemoryDetection.Faulted;
    }
    public override bool EnablePeer(int destination, nint destinationContext)
    {
        int status = _enablePeer(destination, 0);
        if (status != 704)
        {
            Check(status, "hipDeviceEnablePeerAccess");
        }
        return status == 0;
    }
    public override void DisablePeer(int destination, nint destinationContext)
        => Check(_disablePeer(destination), "hipDeviceDisablePeerAccess");
    public override void CopyPeer(GpuDeviceAddress source, int sourceDevice, nint sourceContext,
        GpuDeviceAddress destination, int destinationDevice, nint destinationContext, long bytes, nint stream)
        => Check(_copyPeer(unchecked((nint)destination.Value), destinationDevice,
            unchecked((nint)source.Value), sourceDevice, checked((nuint)bytes), stream), "hipMemcpyPeerAsync");

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Init(uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetInt(out int value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int SetDevice(int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int GetText([Out] StringBuilder text, int length, int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Attribute(out int value, int attribute, int device);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Handle(nint handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Allocate(out nint address, nuint bytes);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int HostAllocate(out nint address, nuint bytes, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int CreateHandle(out nint handle, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int Copy(nint destination, nint source, nuint bytes, int kind, nint stream);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int RecordEvent(nint @event, nint stream);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int PeerAccess(out int accessible, int source, int destination);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int EnablePeerAccess(int peerDevice, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int PeerCopy(nint destination, int destinationDevice, nint source, int sourceDevice, nuint bytes, nint stream);
}
