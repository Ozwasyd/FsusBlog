using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct EmptySuccessPod
{
    public readonly byte Ok;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MutationIdPod
{
    public readonly long Id;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct NameMutationRequestPod
{
    public readonly Utf8Fixed128 Name;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct StringMutationRequestPod
{
    public readonly Utf8SliceRef Value;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ApiErrorPod
{
    public readonly byte Code;
    public readonly byte Category;
    public readonly ushort Reserved0;
    public readonly int HttpStatus;
    public readonly Utf8Fixed256 Message;
    public readonly Utf8Fixed256 Details;
    public readonly Utf8Fixed64 TraceId;
}
