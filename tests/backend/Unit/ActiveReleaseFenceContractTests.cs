using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ActiveReleaseFenceContractTests
{
    [Fact]
    public void NotificationRestart_PreservesCursor_AndReplayMissForcesFullResync()
    {
        NotificationStreamCloseInstruction restart = NotificationStreamRestartProtocol.Resolve(
            replayMissed: false,
            serviceRestartRequested: true);
        NotificationStreamCloseInstruction replayMiss = NotificationStreamRestartProtocol.Resolve(
            replayMissed: true,
            serviceRestartRequested: true);

        Assert.Equal(1012, restart.CloseCode);
        Assert.Equal("fsus_service_restart", restart.Reason);
        Assert.True(restart.PreserveCursor);
        Assert.False(restart.RequireFullResync);
        Assert.Equal(4009, replayMiss.CloseCode);
        Assert.Equal("fsus_replay_miss", replayMiss.Reason);
        Assert.False(replayMiss.PreserveCursor);
        Assert.True(replayMiss.RequireFullResync);
    }

    [Fact]
    public void ExecutionContext_NestedScopeRestoresPriorGeneration()
    {
        var accessor = new ActiveReleaseExecutionContextAccessor();
        var first = Ticket(41);
        var second = Ticket(42);

        using (accessor.Push(first))
        {
            Assert.Equal(41, accessor.Current?.Generation);
            using (accessor.Push(second))
            {
                Assert.Equal(42, accessor.Current?.Generation);
            }
            Assert.Equal(41, accessor.Current?.Generation);
        }

        Assert.Null(accessor.Current);
    }

    [Fact]
    public async Task CommitGuard_RejectsStaleGenerationBeforeCommitBoundary()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        var accessor = new ActiveReleaseExecutionContextAccessor();
        var ticket = Ticket(42);
        fence.IsCurrentAsync(ticket, true, Arg.Any<CancellationToken>()).Returns(Task.FromResult(false));
        var guard = new ActiveReleaseCommitGuard(fence, accessor);

        using (accessor.Push(ticket))
        {
            await Assert.ThrowsAsync<ActiveReleaseFenceLostException>(() => guard.EnsureCurrentAsync());
        }
    }

    [Fact]
    public void RedisFence_RuntimeProgramRequiresExpectedOwnerAndMonotonicGeneration()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(RedisActiveReleaseFenceStore),
            nameof(RedisActiveReleaseFenceStore.AcquireAsync),
            nameof(RedisActiveReleaseFenceStore.RevokeAsync));

        Assert.Contains("expected_current_required", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("active_release_compare_failed", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("active_release_generation_stale", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("active_release_generation_not_monotonic", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ARGV[9] == '1'", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void CriticalSingletonCommitPaths_UseActiveReleaseCommitGuard()
    {
        Type[] criticalWorkers =
        [
            typeof(ScheduledPublishWorker),
            typeof(ArticleMutationOutboxDispatcher),
            typeof(PowLoadResetWorker),
            typeof(ArticleViewProjectionRepairWorker),
            typeof(CrawlerUpdateWorker),
            typeof(LogCleanupService),
            typeof(PublicAotBackfillWorker),
            typeof(UploadSessionCleanupWorker)
        ];

        Assert.All(criticalWorkers, workerType =>
        {
            Assert.Contains(
                workerType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .SelectMany(static constructor => constructor.GetParameters()),
                static parameter => parameter.ParameterType == typeof(IActiveReleaseCommitGuard));
            string runtimeShape = RuntimeMetadataInspection.DescribeType(workerType);
            Assert.Contains("IActiveReleaseCommitGuard", runtimeShape, StringComparison.Ordinal);
            Assert.Contains("EnsureCurrentAsync", runtimeShape, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task HostContracts_AreStableMachineJsonAndLoopbackAdminOnly()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        await using WebApplication app = builder.Build();
        app.MapActiveReleaseFenceEndpoints();
        app.MapNotificationStreamRestartEndpoints();

        foreach ((string route, string method) in new[]
        {
            (ActiveReleaseFenceEndpoints.AcquirePath, HttpMethods.Post),
            (ActiveReleaseFenceEndpoints.RevokePath, HttpMethods.Post),
            (ActiveReleaseFenceEndpoints.StatusPath, HttpMethods.Get),
            (NotificationStreamRestartEndpoints.RestartPath, HttpMethods.Post),
            (NotificationStreamRestartEndpoints.StatusPath, HttpMethods.Get)
        })
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, method);
            AssertSystemConfigPermission(endpoint);
        }

        string fenceRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ActiveReleaseFenceEndpoints),
            nameof(ActiveReleaseFenceEndpoints.MapActiveReleaseFenceEndpoints));
        string restartRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(NotificationStreamRestartEndpoints),
            nameof(NotificationStreamRestartEndpoints.MapNotificationStreamRestartEndpoints));
        Assert.Contains("DeploymentControlEndpoints.IsTrustedHostControl", fenceRuntime, StringComparison.Ordinal);
        Assert.Contains("DeploymentControlEndpoints.IsTrustedHostControl", restartRuntime, StringComparison.Ordinal);

        using JsonDocument fenceEvidence = await RunDeploymentToolAsync(
            "tools/deployment/active-release-fence.mjs",
            "status",
            ".tmp/deployment/active-release-fence.json");
        using JsonDocument restartEvidence = await RunDeploymentToolAsync(
            "tools/deployment/notification-stream-restart.mjs",
            "status",
            ".tmp/deployment/notification-stream-restart.json");
        Assert.Equal("fsus.active-release-fence-evidence.v1", fenceEvidence.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal("fsus.notification-stream-restart-evidence.v1", restartEvidence.RootElement.GetProperty("schemaVersion").GetString());
    }

    [Fact]
    public void EveryCatalogEntry_DeclaresClassificationIdempotencyDrainFenceAndReplay()
    {
        string json = BackendTestPaths.ReadAllTextFromRoot(
            "tests/backend/Fixtures/background-service-classification.json");
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement services = document.RootElement.GetProperty("services");
        Assert.NotEmpty(services.EnumerateArray());

        foreach (JsonElement service in services.EnumerateArray())
        {
            Assert.Contains(
                service.GetProperty("classification").GetString(),
                new[] { "active-singleton", "multi-consumer-safe", "instance-local" });
            Assert.False(string.IsNullOrWhiteSpace(service.GetProperty("idempotency").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(service.GetProperty("drain").GetString()));
            Assert.InRange(service.GetProperty("maxDrainSeconds").GetInt32(), 1, 300);
            Assert.False(string.IsNullOrWhiteSpace(service.GetProperty("fence").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(service.GetProperty("replaySource").GetString()));
        }
    }

    private static ActiveReleaseExecutionTicket Ticket(long generation)
        => new(
            "20260711010101-0123456789ab",
            "blue",
            generation,
            $"sha256:{new string('a', 64)}",
            "test-process");

    private static void AssertSystemConfigPermission(RouteEndpoint endpoint)
    {
        ClaimsAuthorizationRequirement permission = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(AdminPermissions.SystemConfig, permission.AllowedValues ?? []);
    }

    private static async Task<JsonDocument> RunDeploymentToolAsync(
        string relativeScript,
        string action,
        string expectedRelativeOutput)
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-deployment-tool-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            string adminHeader = Path.Combine(tempRoot, "admin.header");
            await File.WriteAllTextAsync(adminHeader, "Authorization: Bearer test-admin-token\n");
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(adminHeader, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Task server = ServeAcceptedResponseAsync(listener);

            var startInfo = new ProcessStartInfo("node")
            {
                WorkingDirectory = tempRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            startInfo.ArgumentList.Add(BackendTestPaths.FromRoot(relativeScript));
            startInfo.ArgumentList.Add(action);
            startInfo.ArgumentList.Add("--port");
            startInfo.ArgumentList.Add(port.ToString(System.Globalization.CultureInfo.InvariantCulture));
            startInfo.ArgumentList.Add("--admin-header-file");
            startInfo.ArgumentList.Add(adminHeader);
            startInfo.ArgumentList.Add("--origin");
            startInfo.ArgumentList.Add("https://deployment.test");

            using Process process = Process.Start(startInfo)
                ?? throw new InvalidOperationException($"Unable to start {relativeScript}.");
            string stdout = await process.StandardOutput.ReadToEndAsync();
            string stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            await server;

            Assert.Equal(0, process.ExitCode);
            Assert.True(string.IsNullOrWhiteSpace(stderr), stderr);
            using JsonDocument stdoutEvidence = JsonDocument.Parse(stdout);
            Assert.True(stdoutEvidence.RootElement.GetProperty("trustedLoopback").GetBoolean());
            Assert.True(stdoutEvidence.RootElement.GetProperty("authenticatedAdminHeaderPresent").GetBoolean());

            string output = Path.Combine(tempRoot, expectedRelativeOutput.Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(output), $"Expected deployment evidence at {output}.");
            return JsonDocument.Parse(await File.ReadAllTextAsync(output));
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    private static async Task ServeAcceptedResponseAsync(TcpListener listener)
    {
        using TcpClient client = await listener.AcceptTcpClientAsync();
        await using NetworkStream stream = client.GetStream();
        var buffer = new byte[4096];
        var request = new StringBuilder();
        while (!request.ToString().Contains("\r\n\r\n", StringComparison.Ordinal))
        {
            int read = await stream.ReadAsync(buffer);
            if (read == 0)
            {
                break;
            }
            request.Append(Encoding.ASCII.GetString(buffer, 0, read));
        }

        const string body = "{\"accepted\":true,\"status\":\"active\"}";
        string response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n\r\n{body}";
        await stream.WriteAsync(Encoding.UTF8.GetBytes(response));
    }
}
