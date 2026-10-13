using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Windows.Tests;

/// <summary>Test-only real NTFS fixture. This is not the canonical #2109 root verifier.</summary>
internal sealed class WindowsVaultNtfsFixture : IDisposable
{
    internal WindowsVaultNtfsFixture()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("windows_vault_requires_real_windows_ntfs");
        }

        RootPath = Path.Combine(Path.GetTempPath(), "fsusblog-windows-watcher-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(RootPath);
        try
        {
            using SafeFileHandle handle = OpenDirectory();
            var fileSystem = new StringBuilder(64);
            if (!ReadVolumeInformation(handle, null, 0, out uint serial, out _, out _, fileSystem, 64))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            }

            if (fileSystem.ToString() != "NTFS")
            {
                throw new InvalidDataException("windows_vault_requires_real_ntfs_volume");
            }

            VolumeSerial = serial;
        }
        catch
        {
            Directory.Delete(RootPath, true);
            throw;
        }
    }

    internal string RootPath
    {
        get;
    }

    internal uint VolumeSerial
    {
        get;
    }

    internal WindowsVaultWatcherSession Start(WindowsVaultWatcherOptions? options = null)
    {
        SafeFileHandle handle = OpenDirectory();
        try
        {
            return WindowsVaultWatcherSession.StartNative(handle,
                WindowsVaultRawFactContractTests.Identity(Guid.NewGuid().ToString("N")) with
                {
                    VolumeSerialDiagnostic = VolumeSerial
                }, options ?? new(),
                () => new(WindowsVaultPathDisposition.Source, null),
                _ => new(WindowsVaultPathDisposition.MissingEntry, null));
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal SafeFileHandle OpenDirectory()
    {
        SafeFileHandle handle = OpenNativeDirectory(RootPath, 1, 1 | 2 | 4, 0, 3, 0x02000000 | 0x40000000, 0);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error);
        }

        return handle;
    }

    public void Dispose()
    {
        if (Directory.Exists(RootPath))
        {
            Directory.Delete(RootPath, true);
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenNativeDirectory(string path, uint access, uint share,
        nint attributes, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "GetVolumeInformationByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadVolumeInformation(SafeFileHandle root, StringBuilder? volumeName,
        uint volumeNameLength, out uint serial, out uint maximumComponentLength, out uint flags,
        StringBuilder fileSystemName, uint fileSystemNameLength);
}
