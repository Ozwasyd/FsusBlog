using System.Diagnostics;
using System.Runtime.InteropServices;
using FsusBlog.V2.Core.Tests;
using static FsusBlog.V2.Tests.SignedExtensionFixture;

namespace FsusBlog.V2.Platform.Tests;

public sealed class WorkerBoundaryAndGuardTests
{
    [Fact]
    public void LinuxWorkerUnitFailsClosedOutsideLinuxArm64()
    {
        if (OperatingSystem.IsLinux() && RuntimeInformation.ProcessArchitecture == Architecture.Arm64 && BitConverter.IsLittleEndian)
            return;
        AssertRejected("plugin-isolation-unavailable", () => LinuxWorkerUnit.Open("probe", "plugin", new(3, 4, 134217728, 24)));
    }

    [Fact]
    public async Task WorkerProcessReapsRunningAndExitedChildProcesses()
    {
        if (OperatingSystem.IsWindows() || !File.Exists("/bin/sleep")) return;
        using var child = Process.Start(new ProcessStartInfo("/bin/sleep") { UseShellExecute = false, ArgumentList = { "30" } })!;
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
            if (!child.HasExited) { child.Kill(entireProcessTree: true); child.WaitForExit(); }
        }
    }

    [Fact]
    public void CoreBoundaryGuardRejectsActualPlatformAssemblyWithMigratedSystemImplementations()
    {
        var platformAssemblyPath = typeof(NativeUnixFile).Assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(platformAssemblyPath));
        var violations = CorePlatformBoundaryGuard.InspectAssembly(platformAssemblyPath);
        foreach (var (rule, subject, detail) in new (string, string, string?)[]
        {
            ("pinvoke-impl", "FsusBlog.V2.Platform.NativeUnixFile.", null),
            ("pinvoke-impl", "FsusBlog.V2.Platform.MediaObjectDirectory.", null),
            ("pinvoke-impl", "FsusBlog.V2.Platform.Extensions.LinuxWorkerUnit.", null),
            ("method-body-call", "FsusBlog.V2.Platform.NativePublicationSigningKey.", "System.IO.FileStream."),
            ("method-body-call", "FsusBlog.V2.Platform.Extensions.ExtensionDisk.", "System.IO.File."),
            ("method-body-call", "FsusBlog.V2.Platform.Extensions.LinuxWorkerUnit+", "System.Diagnostics.Process."),
            ("method-body-call", "FsusBlog.V2.Platform.Extensions.LinuxPluginRunner.", "System.Environment."),
        })
        {
            Assert.Contains(violations, item => item.Rule == rule && item.Subject.StartsWith(subject, StringComparison.Ordinal) &&
                (detail is null || item.Detail.StartsWith(detail, StringComparison.Ordinal)));
        }
    }
}
