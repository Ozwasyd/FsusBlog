using System.Diagnostics;
using System.Globalization;

using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuditDurableAdmissionProcessIssue2040Tests
{
    [Fact]
    [Trait("Category", "Process")]
    public async Task SuccessfulAdmissionThenKillWithoutDrain_FreshProcessOwnerFindsPendingDelivery()
    {
        using var parentOwner = new AuditDurableTestOwner();
        string invocation = Guid.NewGuid().ToString("N");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(typeof(AuditDurableAdmissionProcessIssue2040Tests).Assembly.Location);
        start.ArgumentList.Add(AuditDurableAdmissionProcessWorker.Command);
        start.ArgumentList.Add(parentOwner.Root);
        start.ArgumentList.Add(invocation);
        start.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        Task<string> errors = process.StandardError.ReadToEndAsync();
        try
        {
            string? accepted = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"audit-durable-admitted {invocation} {process.Id} 1", accepted);
            Assert.False(process.HasExited);
            process.Kill(entireProcessTree: true); // Real kill; no worker drain or finally block.
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Equal(string.Empty, await errors);
            using var freshOwner = new AuditDurableTestOwner(parentOwner.Root, deleteRoot: false);
            Assert.Equal(1, freshOwner.Channel.Snapshot().DurablePendingCount);
            await freshOwner.Worker.ReplayPendingOnceAsync(CancellationToken.None);
            Assert.Equal(0, freshOwner.Channel.Snapshot().OutstandingCount);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
    }
}
