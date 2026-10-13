using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.MacOS;

internal static partial class FSEventsNative
{
    private const string Library = "FsusBlog.ArticleVault.MacOS";

    [LibraryImport(Library, EntryPoint = "FsusVaultMacOpen", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint Open(string root, out ulong fileId, out uint device, out int caseSensitive, out int error);

    [LibraryImport(Library, EntryPoint = "FsusVaultMacVolume")]
    internal static partial void Volume(MacVaultNativeHandle handle, [Out] byte[] buffer);

    [LibraryImport(Library, EntryPoint = "FsusVaultMacInspect", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial int Inspect(MacVaultNativeHandle handle, string path, out ulong fileId, out int missing);

    [LibraryImport(Library, EntryPoint = "FsusVaultMacReadManifest")]
    internal static partial int ReadManifest(MacVaultNativeHandle handle, [Out] byte[] buffer, int capacity, out int length);

    [LibraryImport(Library, EntryPoint = "FsusVaultMacStart")]
    internal static partial int Start(MacVaultNativeHandle handle, nint callback, nint context, int maxBatch);

    [LibraryImport(Library, EntryPoint = "FsusVaultMacClose")]
    internal static partial void Close(nint handle);

    internal static string Reason(int error) => error switch
    {
        1 => "mac_vault_filesystem_unsupported",
        2 => "mac_vault_root_invalid",
        3 => "mac_vault_path_blocked",
        4 => "mac_vault_permission_blocked",
        5 => "mac_vault_mount_changed",
        6 => "mac_vault_root_lost",
        7 => "mac_vault_control_manifest_invalid",
        8 => "mac_vault_stream_failed",
        9 => "mac_vault_native_bound_exceeded",
        _ => "mac_vault_native_error"
    };
}

// The handle owns both native resources and the weak managed callback context. Native close drains
// its serial callback queue before the context can be freed, including on finalizer cleanup.
internal sealed class MacVaultNativeHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private nint _context;

    internal MacVaultNativeHandle(nint pointer) : base(true) => SetHandle(pointer);

    internal nint SetCallbackTarget(MacVaultWatcherSession session)
    {
        _context = GCHandle.ToIntPtr(GCHandle.Alloc(new WeakReference<MacVaultWatcherSession>(session)));
        return _context;
    }

    protected override bool ReleaseHandle()
    {
        FSEventsNative.Close(handle);
        if (_context != 0)
        {
            GCHandle.FromIntPtr(_context).Free();
        }

        return true;
    }
}
