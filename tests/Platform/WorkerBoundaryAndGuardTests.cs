using System.Diagnostics;
using System.Runtime.InteropServices;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Core.Tests;
using FsusBlog.V2.Platform.Extensions;

namespace FsusBlog.V2.Platform.Tests;

public sealed class WorkerBoundaryAndGuardTests
{
    [Fact]
    public void LinuxWorkerUnitFailsClosedOutsideLinuxArm64()
    {
        if (OperatingSystem.IsLinux() && RuntimeInformation.ProcessArchitecture == Architecture.Arm64 && BitConverter.IsLittleEndian)
            return;
        var error = Assert.Throws<ExtensionRejectedException>(() =>
            LinuxWorkerUnit.Open("probe", "plugin", new(3, 4, 134217728, 24)));
        Assert.Equal("plugin-isolation-unavailable", error.Code);
    }

    [Fact]
    public async Task WorkerProcessReapsRunningAndExitedChildProcesses()
    {
        if (OperatingSystem.IsWindows() || !File.Exists("/bin/sleep")) return;
        using var child = Process.Start(new ProcessStartInfo("/bin/sleep")
        {
            UseShellExecute = false,
            ArgumentList = { "30" }
        })!;
        try
        {
            Assert.False(child.HasExited);
            await WorkerProcess.ReapAsync(child, entireProcessTree: true, TimeSpan.FromSeconds(5));
            Assert.True(child.HasExited);
            // Calling ReapAsync on an already-exited process succeeds cleanly.
            await WorkerProcess.ReapAsync(child, entireProcessTree: true, TimeSpan.FromSeconds(2));
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit();
            }
        }
    }

    [Fact]
    public void CoreBoundaryGuardRejectsActualPlatformAssemblyWithMigratedSystemImplementations()
    {
        var platformAssemblyPath = typeof(NativeUnixFile).Assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(platformAssemblyPath));

        var violations = CorePlatformBoundaryGuard.InspectAssembly(platformAssemblyPath);

        Assert.Contains(violations, item => item.Rule == "pinvoke-impl" && item.Subject.StartsWith("FsusBlog.V2.Platform.NativeUnixFile.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "pinvoke-impl" && item.Subject.StartsWith("FsusBlog.V2.Platform.MediaObjectDirectory.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "pinvoke-impl" && item.Subject.StartsWith("FsusBlog.V2.Platform.Extensions.LinuxWorkerUnit.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "method-body-call" &&
            item.Subject.StartsWith("FsusBlog.V2.Platform.NativePublicationSigningKey.", StringComparison.Ordinal) &&
            item.Detail.StartsWith("System.IO.FileStream.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "method-body-call" &&
            item.Subject.StartsWith("FsusBlog.V2.Platform.Extensions.ExtensionDisk.", StringComparison.Ordinal) &&
            item.Detail.StartsWith("System.IO.File.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "method-body-call" &&
            item.Subject.StartsWith("FsusBlog.V2.Platform.Extensions.LinuxWorkerUnit+", StringComparison.Ordinal) &&
            item.Detail.StartsWith("System.Diagnostics.Process.", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "method-body-call" &&
            item.Subject.StartsWith("FsusBlog.V2.Platform.Extensions.LinuxPluginRunner.", StringComparison.Ordinal) &&
            item.Detail.StartsWith("System.Environment.", StringComparison.Ordinal));
    }
}
