using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DelegateSyntax;

internal class GpuCudaNativeApi
{
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

internal class GpuHipNativeApi
{
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

internal class GpuMetalNativeApi
{
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

internal class Case0
{
    internal delegate int Init(uint flags);
}

internal class Case1
{
    private delegate nint CopyDevices();
}

internal class Case2
{
    private delegate void PoolPop(nint pool);
}

internal class Case3
{
    private delegate ulong SendInteger(nint value);
}

internal class Case4
{
    private delegate byte SendBoolean(nint value);
}

internal class Case5
{
    internal delegate System.Int32 ReadValue();
}

internal class Case6
{
    internal delegate global::System.Collections.Generic.Dictionary<string, int[]> ReadValues();
}

internal class Case7
{
    internal delegate TResult Convert<in T, out TResult>(T value);
}

internal class Case8
{
    internal delegate int?[] ReadValues();
}

internal class Case9
{
    internal delegate (int Left, System.Int32 Right) ReadPair();
}

internal class Case10
{
    internal delegate ref int ReadValue();
}

internal class Case11
{
    internal delegate ref readonly int ReadValue();
}

internal class Case12
{
    internal delegate ref readonly (int Left, int Right) ReadPair();
}

internal class Case13
{
    internal unsafe delegate int* ReadPointer();
}

internal class Case14
{
    internal unsafe delegate delegate* unmanaged[Cdecl]<int, void> ReadCallback();
}

internal class Case15
{
    internal delegate int @ReadValue();
}

internal class Case16
{
    [System.Obsolete] internal delegate int ReadValue();
}

internal class Case17
{
    internal delegate
        ref readonly
        int
        ReadValue
        ();
}

internal class Case18
{
    internal delegate TResult
        Convert<
            in T,
            out TResult>
        (T value);
}

internal class Case19
{
    private delegate nint RegisterSelector([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPUTF8Str)] string name);
}

internal class Case20
{
    private delegate void SendCopy(nint value, nint selector, nint source, ulong sourceOffset,
        nint destination, ulong destinationOffset, ulong bytes);
}

