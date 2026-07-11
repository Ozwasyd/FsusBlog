using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Auth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DeploymentRuntimeStateTests
{
    private const string ReleaseId = "20260711010101-0123456789ab";
    private const string Slot = "blue";

    [Fact]
    public void ProductionRuntime_StaysCandidateUntilStartupAndAllReadinessGatesComplete()
    {
        DeploymentRuntimeState state = CreateProductionRuntime();

        DeploymentRuntimeSnapshot starting = state.CreateSnapshot(0);
        Assert.Equal(DeploymentRuntimeModes.Candidate, starting.Mode);
        Assert.Equal(DeploymentLifecycleStates.Starting, starting.State);
        Assert.False(state.CanServeReadiness);
        Assert.False(starting.CanReceiveTraffic);
        Assert.False(starting.CanClaimBackgroundWork);

        state.MarkStartupCompleted();
        state.ReportReadiness(gatesReady: false);
        Assert.Equal(DeploymentLifecycleStates.Candidate, state.CreateSnapshot(0).State);
        Assert.False(state.CanServeReadiness);

        state.ReportReadiness(gatesReady: true);
        DeploymentRuntimeSnapshot ready = state.CreateSnapshot(0);
        Assert.Equal(DeploymentLifecycleStates.Ready, ready.State);
        Assert.True(state.CanServeReadiness);
        Assert.False(ready.CanReceiveTraffic);
        Assert.False(ready.CanAcceptNotificationStream);
    }

    [Fact]
    public void ProductionRuntime_FailsClosedWhenGenerationOrCandidateModeIsInvalid()
    {
        DeploymentRuntimeState missingGeneration = CreateProductionRuntime(generation: null);
        Assert.Equal(DeploymentLifecycleStates.Failed, missingGeneration.CreateSnapshot(0).State);
        Assert.Equal("deployment_generation_missing", missingGeneration.CreateSnapshot(0).LastErrorCode);

        DeploymentRuntimeState invalidMode = CreateProductionRuntime(generation: 7, requestedMode: "active");
        Assert.Equal(DeploymentLifecycleStates.Failed, invalidMode.CreateSnapshot(0).State);
        Assert.Equal("production_instance_must_start_candidate", invalidMode.CreateSnapshot(0).LastErrorCode);
    }

    [Fact]
    public void ActivationAndDrain_UseExactIdentityGenerationCasAndRemainIdempotent()
    {
        DeploymentRuntimeState state = CreateReadyCandidate();

        DeploymentTransitionResult wrongRelease = Activate(state, new("wrong-release", Slot, 7));
        DeploymentTransitionResult wrongSlot = Activate(state, new(ReleaseId, "green", 7));
        DeploymentTransitionResult wrongGeneration = Activate(state, new(ReleaseId, Slot, 8));
        Assert.Equal("deployment_release_mismatch", wrongRelease.ErrorCode);
        Assert.Equal("deployment_slot_mismatch", wrongSlot.ErrorCode);
        Assert.Equal("deployment_generation_mismatch", wrongGeneration.ErrorCode);

        DeploymentTransitionResult activated = Activate(state, ControlRequest());
        Assert.True(activated.Accepted);
        Assert.False(activated.Idempotent);
        Assert.Equal(DeploymentLifecycleStates.Active, activated.Snapshot.State);
        Assert.True(activated.Snapshot.CanReceiveTraffic);

        DeploymentTransitionResult duplicateActivation = Activate(state, ControlRequest());
        Assert.True(duplicateActivation.Accepted);
        Assert.True(duplicateActivation.Idempotent);

        DeploymentTransitionResult drained = BeginDrain(state, ControlRequest());
        Assert.True(drained.Accepted);
        Assert.False(drained.Idempotent);
        Assert.Equal(DeploymentLifecycleStates.Draining, drained.Snapshot.State);
        Assert.False(state.CanServeReadiness);

        DeploymentTransitionResult duplicateDrain = BeginDrain(state, ControlRequest());
        Assert.True(duplicateDrain.Accepted);
        Assert.True(duplicateDrain.Idempotent);
        DeploymentTransitionResult activationAfterDrain = Activate(state, ControlRequest());
        Assert.False(activationAfterDrain.Accepted);
        Assert.Equal("deployment_is_draining", activationAfterDrain.ErrorCode);
    }

    [Fact]
    public async Task Drain_AllowsEnteredHttpRequestToFinishAndRejectsNewRequestsImmediately()
    {
        DeploymentRuntimeState state = CreateActiveRuntime();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var middleware = new DeploymentRequestTrackingMiddleware(async _ =>
        {
            entered.TrySetResult();
            await release.Task;
        });
        var first = new DefaultHttpContext();
        first.Response.Body = new MemoryStream();

        Task firstRequest = middleware.InvokeAsync(first, state);
        await entered.Task;
        Assert.Equal(1, state.CreateSnapshot(0).InFlightHttpRequests);

        DeploymentTransitionResult drain = BeginDrain(state, ControlRequest());
        Assert.True(drain.Accepted);
        var rejected = new DefaultHttpContext();
        rejected.Response.Body = new MemoryStream();
        await middleware.InvokeAsync(rejected, state);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, rejected.Response.StatusCode);
        Assert.Equal("5", rejected.Response.Headers.RetryAfter);
        Assert.Equal(1, state.CreateSnapshot(0).InFlightHttpRequests);

        release.TrySetResult();
        await firstRequest;
        Assert.Equal(0, state.CreateSnapshot(0).InFlightHttpRequests);
    }

    [Fact]
    public async Task HttpCounter_ReturnsToZeroAfterExceptionAndCancellation()
    {
        DeploymentRuntimeState state = CreateActiveRuntime();
        var exceptionMiddleware = new DeploymentRequestTrackingMiddleware(
            _ => Task.FromException(new InvalidOperationException("boom")));
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => exceptionMiddleware.InvokeAsync(new DefaultHttpContext(), state));
        Assert.Equal(0, state.CreateSnapshot(0).InFlightHttpRequests);

        var cancellationMiddleware = new DeploymentRequestTrackingMiddleware(
            _ => Task.FromCanceled(new CancellationToken(canceled: true)));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => cancellationMiddleware.InvokeAsync(new DefaultHttpContext(), state));
        Assert.Equal(0, state.CreateSnapshot(0).InFlightHttpRequests);
    }

    [Fact]
    public void Drain_StopsNewBackgroundClaimsAndReportsExactBlockingComponentsOnTimeout()
    {
        DeploymentRuntimeState state = CreateActiveRuntime();
        Assert.True(state.TryBeginBackgroundClaim(out IDisposable? existingClaim));
        Assert.Equal(1, state.CreateSnapshot(0).ActiveBackgroundClaims);

        BeginDrain(state, ControlRequest());
        Assert.False(state.TryBeginBackgroundClaim(out IDisposable? rejectedClaim));
        Assert.Null(rejectedClaim);
        state.PublishDrainSnapshot(
        [
            new("visit-log", 2, Blocking: true, Status: "pending"),
            new("http-in-flight", 1, Blocking: true, Status: "pending"),
            new("diagnostic-only", 9, Blocking: false, Status: "observed")
        ], timedOut: true);

        DeploymentDrainSnapshot drain = state.CreateSnapshot(0).Drain;
        Assert.True(drain.Requested);
        Assert.True(drain.TimedOut);
        Assert.False(drain.Drained);
        Assert.Equal(["http-in-flight", "visit-log"], drain.Blockers);
        Assert.Equal("deployment_drain_timeout", state.CreateSnapshot(0).LastErrorCode);
        DeploymentTransitionResult repeated = BeginDrain(state, ControlRequest());
        Assert.True(repeated.Accepted);
        Assert.True(repeated.Idempotent);
        Assert.True(repeated.Snapshot.Drain.TimedOut);
        Assert.False(repeated.Snapshot.Drain.Drained);

        existingClaim!.Dispose();
        Assert.Equal(0, state.CreateSnapshot(0).ActiveBackgroundClaims);
    }

    [Fact]
    public void NotificationConnections_AreCountedSeparatelyAndNewHandshakeRegistrationFailsAfterDrain()
    {
        DeploymentRuntimeState state = CreateActiveRuntime();
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance,
            state);
        manager.RegisterConnection("existing", "42", ["article:1"], clientIp: "127.0.0.1");
        Assert.Equal(1, state.CreateSnapshot(manager.ConnectionCount).NotificationStreamConnections);

        BeginDrain(state, ControlRequest());
        NotificationStreamDeploymentUnavailableException error = Assert.Throws<NotificationStreamDeploymentUnavailableException>(
            () => manager.RegisterConnection("new", "42", ["article:1"], clientIp: "127.0.0.1"));
        Assert.Equal("deployment_draining", error.ErrorCode);
        Assert.Equal(1, manager.ConnectionCount);
        manager.RemoveConnection("existing");
        Assert.Equal(0, manager.ConnectionCount);
    }

    [Fact]
    public async Task HostStoppingAndStopAsync_UseTheSameDrainStateAndReachStoppedOnlyAfterDrain()
    {
        DeploymentRuntimeState state = CreateActiveRuntime();
        await using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Deployment:DrainTimeoutSeconds"] = "5" })
            .Build();
        var coordinator = new DeploymentDrainCoordinator(
            state,
            provider,
            configuration,
            TimeProvider.System,
            NullLogger<DeploymentDrainCoordinator>.Instance);
        using var lifetime = new TestHostApplicationLifetime();
        var service = new DeploymentLifecycleHostedService(
            state,
            coordinator,
            lifetime,
            NullLogger<DeploymentLifecycleHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);
        lifetime.StopApplication();
        Assert.Equal(DeploymentLifecycleStates.Draining, state.CreateSnapshot(0).State);
        await service.StopAsync(CancellationToken.None);

        DeploymentRuntimeSnapshot stopped = state.CreateSnapshot(0);
        Assert.Equal(DeploymentLifecycleStates.Stopped, stopped.State);
        Assert.True(stopped.Drain.Drained);
        Assert.False(stopped.Drain.TimedOut);
    }

    [Fact]
    public void PublicReadinessReport_RemainsMinimalWhileTrustedControlRequiresLoopback()
    {
        var report = new ProductionHealthReport(
            "ready",
            DateTimeOffset.Parse("2026-07-11T01:01:01Z"),
            new Dictionary<string, object?>
            {
                ["deployment"] = new { releaseId = ReleaseId, slot = Slot, generation = 7 }
            });
        IReadOnlyDictionary<string, object?> publicReport = ProductionReadinessPublicReport.Create(report);
        Assert.Equal(["checkedAt", "status"], publicReport.Keys.Order(StringComparer.Ordinal).ToArray());
        Assert.DoesNotContain("releaseId", publicReport.Keys);
        Assert.DoesNotContain("slot", publicReport.Keys);
        Assert.DoesNotContain("generation", publicReport.Keys);

        var loopback = new DefaultHttpContext();
        loopback.Connection.RemoteIpAddress = System.Net.IPAddress.Loopback;
        Assert.True(DeploymentControlEndpoints.IsTrustedHostControl(loopback));
        var remote = new DefaultHttpContext();
        remote.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("203.0.113.10");
        Assert.False(DeploymentControlEndpoints.IsTrustedHostControl(remote));
    }

    [Fact]
    public async Task DeploymentControlRoutes_RequireSystemConfigAndFixedIpOnEveryOperation()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        await using WebApplication app = builder.Build();
        app.MapDeploymentControlEndpoints();

        foreach ((string path, string method) in new[]
        {
            ("/api/ops/deployment/status", HttpMethods.Get),
            ("/api/ops/deployment/activate", HttpMethods.Post),
            ("/api/ops/deployment/drain", HttpMethods.Post)
        })
        {
            RouteEndpoint endpoint = Assert.Single(((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>()
                .Where(item => string.Equals(
                    item.RoutePattern.RawText?.TrimStart('/'),
                    path.TrimStart('/'),
                    StringComparison.Ordinal)));
            Assert.Contains(method, Assert.IsAssignableFrom<IHttpMethodMetadata>(
                endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()).HttpMethods);
            AuthorizationPolicy policy = Assert.Single(endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
            ClaimsAuthorizationRequirement permission = Assert.Single(policy.Requirements
                .OfType<ClaimsAuthorizationRequirement>()
                .Where(item => item.ClaimType == AdminPermissions.PermissionClaimType));
            Assert.Contains(AdminPermissions.SystemConfig, permission.AllowedValues ?? []);
            Assert.Equal("fixed_ip", Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        }
    }

    private static DeploymentRuntimeState CreateReadyCandidate()
    {
        DeploymentRuntimeState state = CreateProductionRuntime();
        state.MarkStartupCompleted();
        state.ReportReadiness(gatesReady: true);
        return state;
    }

    private static DeploymentRuntimeState CreateActiveRuntime()
    {
        DeploymentRuntimeState state = CreateReadyCandidate();
        DeploymentTransitionResult result = Activate(state, ControlRequest());
        Assert.True(result.Accepted);
        return state;
    }

    private static DeploymentTransitionResult Activate(DeploymentRuntimeState state, DeploymentControlRequest request)
        => state.Activate(request, state.CreateSnapshot(0));

    private static DeploymentTransitionResult BeginDrain(DeploymentRuntimeState state, DeploymentControlRequest request)
        => state.BeginDrain(request, TimeSpan.FromSeconds(5), state.CreateSnapshot(0));

    private static DeploymentControlRequest ControlRequest() => new(ReleaseId, Slot, 7, 5);

    private static DeploymentRuntimeState CreateProductionRuntime(long? generation = 7, string requestedMode = "candidate")
    {
        var values = new Dictionary<string, string?>
        {
            ["FSUSBLOG_RELEASE_ID"] = ReleaseId,
            ["FSUSBLOG_RELEASE_SLOT"] = Slot,
            ["FSUSBLOG_COMMIT_SHA"] = "0123456789abcdef0123456789abcdef01234567",
            ["FSUSBLOG_IMAGE_DIGEST"] = $"sha256:{new string('a', 64)}",
            ["FSUSBLOG_IMAGE_REF"] = $"ghcr.io/fsusblog/app@sha256:{new string('a', 64)}",
            ["FSUSBLOG_DEPLOYMENT_MODE"] = requestedMode
        };
        if (generation.HasValue)
        {
            values["FSUSBLOG_DEPLOYMENT_GENERATION"] = generation.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        return new DeploymentRuntimeState(
            new ReleaseIdentityProvider(configuration),
            configuration,
            new TestWebHostEnvironment(Environments.Production),
            TimeProvider.System);
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestHostApplicationLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        public CancellationToken ApplicationStarted => _started.Token;
        public CancellationToken ApplicationStopping => _stopping.Token;
        public CancellationToken ApplicationStopped => _stopped.Token;

        public void StopApplication() => _stopping.Cancel();

        public void Dispose()
        {
            _started.Dispose();
            _stopping.Dispose();
            _stopped.Dispose();
        }
    }
}
