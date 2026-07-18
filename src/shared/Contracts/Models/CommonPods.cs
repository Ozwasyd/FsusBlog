using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>EmptySuccess</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct EmptySuccessPod
{
    public readonly byte Ok;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MutationId</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MutationIdPod
{
    public readonly long Id;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>NameMutationRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct NameMutationRequestPod
{
    public readonly Utf8Fixed128 Name;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>StringMutationRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct StringMutationRequestPod
{
    public readonly Utf8SliceRef Value;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyCredentialFriendlyNameUpdateRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyCredentialFriendlyNameUpdateRequestPod
{
    public readonly Utf8SliceRef FriendlyName;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ApiError</c> wire contract.
/// </summary>
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
