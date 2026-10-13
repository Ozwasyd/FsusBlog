using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>Owns one cancellable overlapped ReadDirectoryChangesW operation on a supplied directory handle.</summary>
internal static class WindowsDirectoryChangesNative
{
    internal const int OperationAborted = 995;
    internal const int NotifyEnumerationRequired = 1022;
    private const int IoPending = 997;
    private const uint NotifyFilter = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40 | 0x100;

    internal static unsafe void Observe(SafeFileHandle directory, int bufferBytes,
        CancellationToken cancellationToken, Action<byte[]> receive, Action<int> failure, Action operationQueued)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("windows_vault_requires_real_windows_ntfs");
        }

        using SafeFileHandle completion = CreateCompletionEvent(0, true, false, null);
        if (completion.IsInvalid)
        {
            failure(Marshal.GetLastPInvokeError());
            return;
        }

        nint buffer = Marshal.AllocHGlobal(bufferBytes);
        nint operation = 0;
        try
        {
            operation = Marshal.AllocHGlobal(sizeof(NativeOverlapped));
            while (!cancellationToken.IsCancellationRequested)
            {
                *(NativeOverlapped*)operation = new NativeOverlapped
                {
                    EventHandle = completion.DangerousGetHandle()
                };
                if (!ResetCompletionEvent(completion))
                {
                    failure(Marshal.GetLastPInvokeError());
                    return;
                }

                bool started = ReadDirectoryChanges(directory, buffer, (uint)bufferBytes,
                    true, NotifyFilter, 0, operation, 0);
                int error = started ? 0 : Marshal.GetLastPInvokeError();
                if (!started && error != IoPending)
                {
                    failure(error);
                    return;
                }

                // Register after starting: an already-cancelled token immediately cancels this operation.
                // Dispose registration before freeing OVERLAPPED/buffer; drain cancelled I/O before reuse.
                using (cancellationToken.Register(() => CancelOperation(directory, operation)))
                {
                    operationQueued();
                    if (!GetOperationResult(directory, operation, out uint bytesTransferred, true))
                    {
                        error = Marshal.GetLastPInvokeError();
                        if (error == OperationAborted && cancellationToken.IsCancellationRequested)
                        {
                            return;
                        }

                        failure(error);
                        return;
                    }

                    if (bytesTransferred == 0)
                    {
                        failure(NotifyEnumerationRequired);
                        continue;
                    }

                    if (bytesTransferred > bufferBytes)
                    {
                        failure(NotifyEnumerationRequired);
                        return;
                    }

                    var bytes = new byte[bytesTransferred];
                    Marshal.Copy(buffer, bytes, 0, bytes.Length);
                    receive(bytes);
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(operation);
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void CancelOperation(SafeFileHandle directory, nint operation)
    {
        _ = CancelIo(directory, operation);
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateCompletionEvent(nint attributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState, string? name);

    [DllImport("kernel32.dll", EntryPoint = "ResetEvent", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ResetCompletionEvent(SafeFileHandle completion);

    [DllImport("kernel32.dll", EntryPoint = "ReadDirectoryChangesW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadDirectoryChanges(SafeFileHandle directory, nint buffer,
        uint bufferLength, [MarshalAs(UnmanagedType.Bool)] bool watchSubtree, uint notifyFilter,
        nint bytesReturned, nint operation, nint completionRoutine);

    [DllImport("kernel32.dll", EntryPoint = "GetOverlappedResult", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOperationResult(SafeFileHandle directory, nint operation,
        out uint bytesTransferred, [MarshalAs(UnmanagedType.Bool)] bool wait);

    [DllImport("kernel32.dll", EntryPoint = "CancelIoEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelIo(SafeFileHandle directory, nint operation);
}
