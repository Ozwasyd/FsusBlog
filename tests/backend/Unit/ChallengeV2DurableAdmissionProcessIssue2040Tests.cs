using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Process")]
public sealed class ChallengeV2DurableAdmissionProcessIssue2040Tests
{
    [Theory]
    [InlineData(false, "admission")]
    [InlineData(true, "admission")]
    [InlineData(false, "in-flight")]
    [InlineData(true, "in-flight")]
    public async Task RealChildKillAfterProtectedAdmissionOrDequeue_RecoversBothClocksAndIdentity(bool high, string window)
    {
        string root = Path.Combine(ChallengeV2Issue2040Owner.TemporaryRoot, $"fsusblog-challenge-issue2040-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            await using (ChallengeV2OwnedProcess child = await ChallengeV2OwnedProcess.StartAsync(root, high, window))
            {
                await child.ReadyAsync(window == "admission" ? "admitted" : "in-flight");
                Assert.Single(Directory.GetFiles(root, "*.json", SearchOption.AllDirectories));
                await child.KillAsync();
            }
            using var recovered = new ChallengeV2Issue2040Owner(root: root, deleteRoot: false);
            Assert.Equal(1, recovered.Queue.LaneSnapshot(high).DurablePendingCount);
            Assert.Equal(0, recovered.Queue.LaneSnapshot(!high).DurablePendingCount);
            Assert.True(recovered.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
            ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery!.Attempt);
            Assert.True(Guid.TryParse(delivery.Attempt.AttemptId, out _));
            Assert.Equal(prepared.CreatedAtUtc, delivery.Attempt.AttemptedAtUtc);
            Assert.Equal(1, await recovered.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
            Assert.Equal(prepared, ChallengeV2DurableDelivery.GetRequired(Assert.Single(recovered.Recording!.Attempts)));
            Assert.Equal(0, recovered.Queue.Snapshot().OutstandingCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}

/// <summary>Exact child ownership, handshake and reaping; not an independent test runner.</summary>
internal sealed class ChallengeV2OwnedProcess : IAsyncDisposable
{
    private readonly Process _process;
    private readonly string _invocation;
    private readonly string _assemblyDigest;
    private readonly Task<string> _stderr;
    internal Process Process => _process;

    private ChallengeV2OwnedProcess(Process process, string invocation, string assemblyDigest)
    {
        _process = process;
        _invocation = invocation;
        _assemblyDigest = assemblyDigest;
        _stderr = process.StandardError.ReadToEndAsync();
    }

    internal static async Task<ChallengeV2OwnedProcess> StartAsync(string root, bool high, string window, string? connection = null)
    {
        string assembly = typeof(ChallengeV2AdmissionProcessIssue2040Worker).Assembly.Location;
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        string invocation = Guid.NewGuid().ToString("N");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = AppContext.BaseDirectory
        };
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add(ChallengeV2AdmissionProcessIssue2040Worker.Command);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add(invocation);
        start.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        start.ArgumentList.Add(high.ToString(CultureInfo.InvariantCulture));
        start.ArgumentList.Add(window);
        if (connection is not null)
        {
            start.Environment["FSUSBLOG_CHALLENGE_PROCESS_DATABASE"] = connection;
        }
        var process = new Process { StartInfo = start };
        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("challenge_process_start_failed");
        }
        return new(process, invocation, digest);
    }

    internal async Task ReadyAsync(string expectedState)
    {
        string? line;
        do
        {
            line = await _process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(line);
            string[] fields = line.Split(' ');
            Assert.Equal(4, fields.Length);
            Assert.Equal(_invocation, fields[1]);
            Assert.Equal(_process.Id.ToString(CultureInfo.InvariantCulture), fields[2]);
            Assert.Equal(_assemblyDigest, fields[3]);
            Assert.False(_process.HasExited);
        }
        while (!line.StartsWith($"challenge-{expectedState} ", StringComparison.Ordinal));
    }

    internal async Task KillAsync()
    {
        Assert.False(_process.HasExited);
        _process.Kill(entireProcessTree: true);
        await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotEqual(0, _process.ExitCode);
        Assert.Equal(string.Empty, await _stderr);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            await _stderr;
        }
        finally
        {
            _process.Dispose();
        }
    }
}
