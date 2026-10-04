using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Tests.TestInfrastructure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskDurableAdmissionProcessIssue2040Tests(ITestOutputHelper output)
{
    [Theory]
    [Trait("Category", "Process")]
    [InlineData("admitted")]
    [InlineData("in-flight")]
    public async Task RealOwnedChildKill_FreshOwnerReplaysExactProtectedEvent(string phase)
    {
        using var owner = new SecurityRiskIssue2040Owner();
        string invocation = Guid.NewGuid().ToString("N");
        string assembly = typeof(SecurityRiskDurableAdmissionProcessIssue2040Tests).Assembly.Location;
        string assemblyDigest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        string rootDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(owner.Root)));
        var start = new ProcessStartInfo(PublicAotCrashWorkerProgram.ResolveDotNetHostPath())
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add(SecurityRiskAdmissionProcessIssue2040Worker.Command);
        start.ArgumentList.Add(owner.Root);
        start.ArgumentList.Add(invocation);
        start.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        start.ArgumentList.Add(phase);
        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        Task<string> errors = process.StandardError.ReadToEndAsync();
        try
        {
            string? reached = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"security-risk-durable {invocation} {process.Id} {Environment.ProcessId} {assemblyDigest} {rootDigest} {phase}", reached);
            output.WriteLine(reached);
            Assert.False(process.HasExited);
            process.Kill(entireProcessTree: true); // Exact owned child, no disposal/drain/ACK.
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Equal(string.Empty, await errors);
            output.WriteLine($"security-risk-killed pid={process.Id} exit={process.ExitCode} assembly={assemblyDigest}");
            using var restarted = new SecurityRiskIssue2040Owner(owner.Root, deleteRoot: false);
            Assert.Equal(1, restarted.Queue.Snapshot().DurablePendingCount);
            Assert.Equal(1, await restarted.Worker.FlushOnceAsync(CancellationToken.None));
            // The recording store verifies replay only; this is not PostgreSQL qualification.
            Assert.Equal(SecurityRiskIssue2040Owner.Write() with
            {
                Id = invocation
            }, Assert.Single(restarted.Store.Writes));
            Assert.Equal(0, restarted.Queue.Snapshot().OutstandingCount);
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
