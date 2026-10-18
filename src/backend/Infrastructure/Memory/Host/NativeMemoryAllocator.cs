using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

// OWNERSHIP: The backend alone pairs BCL allocation and release. Alignment 1
// means ordinary allocation; a pin never implies locked pages or registration.
internal interface INativeMemoryAllocator
{
    nint Allocate(int capacity, int alignment);
    void ClearAndFree(nint address, int capacity, int alignment);
}

internal sealed class NativeMemoryAllocator : INativeMemoryAllocator
{
    internal static NativeMemoryAllocator Instance { get; } = new();

    public unsafe nint Allocate(int capacity, int alignment)
        => (nint)(alignment == 1
            ? NativeMemory.Alloc((nuint)capacity)
            : NativeMemory.AlignedAlloc((nuint)capacity, (nuint)alignment));

    public unsafe void ClearAndFree(nint address, int capacity, int alignment)
    {
        NativeMemory.Clear((void*)address, (nuint)capacity);
        if (alignment == 1)
        {
            NativeMemory.Free((void*)address);
        }
        else
        {
            NativeMemory.AlignedFree((void*)address);
        }
    }
}
