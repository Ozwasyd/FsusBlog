using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

public class NotificationStreamBoundaryTests
{
    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task RestrictedSession_IsRejectedBeforeNotificationAdmission()
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment(),
            ["Seo:BaseUrl=https://example.com"]);
        DefaultHttpContext context = CreateHandshakeContext("https://example.com", "example.com");
        ((ClaimsIdentity)context.User.Identity!).AddClaim(new Claim(
            UserSessionModes.ClaimType,
            UserSessionModes.ToClaimValue(UserSessionMode.Restricted)));

        NotificationStreamHandshakeResult result = await service.ValidateAsync(
            context,
            CancellationToken.None,
            requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status423Locked, result.StatusCode);
        Assert.Equal("restricted_session_not_allowed", result.ErrorCode);
    }

    [Fact]
    public async Task DrainingDeployment_RejectsNewHandshakeBeforeAdmissionWithRetryableCode()
    {
        IConfiguration deploymentConfiguration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_RELEASE_ID"] = "20260711010101-0123456789ab",
                ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = "2026-07-11T01:01:01Z",
                ["FSUSBLOG_RELEASE_SLOT"] = "blue",
                ["FSUSBLOG_COMMIT_SHA"] = "0123456789abcdef0123456789abcdef01234567",
                ["FSUSBLOG_IMAGE_DIGEST"] = $"sha256:{new string('a', 64)}",
                ["FSUSBLOG_IMAGE_REF"] = $"ghcr.io/fsusblog/app@sha256:{new string('a', 64)}",
                ["FSUSBLOG_DEPLOYMENT_MODE"] = "candidate",
                ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "7"
            })
            .Build();
        var deployment = new DeploymentRuntimeState(
            new ReleaseIdentityProvider(deploymentConfiguration),
            deploymentConfiguration,
            new TestWebHostEnvironment(),
            TimeProvider.System);
        deployment.MarkStartupCompleted();
        deployment.ReportReadiness(gatesReady: true);
        var request = new DeploymentControlRequest("20260711010101-0123456789ab", "blue", 7, 5);
        Assert.True(deployment.Activate(request, deployment.CreateSnapshot(0)).Accepted);
        Assert.True(deployment.BeginDrain(request, TimeSpan.FromSeconds(5), deployment.CreateSnapshot(0)).Accepted);
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment(),
            ["NotificationStream:AllowedOrigins:0=https://example.com"],
            deploymentRuntime: deployment);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(
            CreateHandshakeContext("https://example.com", "example.com"),
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        Assert.Equal("deployment_draining", result.ErrorCode);

        var handler = new NotificationStreamHandler(
            service,
            Substitute.For<INotificationStreamSessionService>(),
            new BinaryEnvelopePolicy());
        DefaultHttpContext handlerContext = CreateHandshakeContext("https://example.com", "example.com");
        handlerContext.Response.Body = new MemoryStream();
        await handler.HandleAsync(handlerContext, CancellationToken.None);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, handlerContext.Response.StatusCode);
        Assert.Equal("5", handlerContext.Response.Headers.RetryAfter);
        Assert.Equal("deployment_draining", handlerContext.Response.Headers["X-Fsus-Notification-Stream-Error-Code"]);
    }

    [Fact]
    public void NotificationStreamRoutes_DoNotRegisterSignalROrLegacyHubPipeline()
    {
        string compositionRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(PublicWebRuntime),
            "MapFsusApiRoutes");
        Assert.Contains("/api/notifications/stream/preflight", compositionRuntime, StringComparison.Ordinal);
        Assert.Contains("/api/notifications/stream", compositionRuntime, StringComparison.Ordinal);
        Assert.Contains("INotificationStreamHandler", compositionRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("MapHub", compositionRuntime, StringComparison.Ordinal);

        Assembly serverAssembly = typeof(NotificationStreamHandler).Assembly;
        Assert.DoesNotContain(serverAssembly.GetReferencedAssemblies(), static reference =>
            reference.Name?.Contains("SignalR", StringComparison.OrdinalIgnoreCase) == true);
        Assert.DoesNotContain(serverAssembly.DefinedTypes, static type => type.Name is
            "SignalRInitializer" or "SignalRPoWFilter" or "SnowflakeUserIdProvider");

        var services = new ServiceCollection();
        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());
        Assert.DoesNotContain(services, static descriptor =>
            descriptor.ServiceType.FullName?.Contains("SignalR", StringComparison.OrdinalIgnoreCase) == true
            || descriptor.ServiceType.Name == "IUserIdProvider"
            || descriptor.ImplementationType?.Name == "SnowflakeUserIdProvider");
        Assert.DoesNotContain(typeof(FastUserIdProvider).GetInterfaces(), static contract =>
            contract.Name == "IUserIdProvider");
        Assert.DoesNotContain("HubConnectionContext", RuntimeMetadataInspection.DescribeType(typeof(FastUserIdProvider)), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Admission_AllowsAnonymousWithoutAccountLookup()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync(null, CancellationToken.None);

        Assert.True(result.IsAllowed);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task Admission_DeniesBannedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, StableAccountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            1,
            "blocked",
            false,
            null,
            AccountSubjectHash: StableAccountSubjectHash)));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status423Locked, result.StatusCode);
        Assert.Equal("account_blocked", result.ErrorCode);
        await users.Received(1).GetAccountByIdAsync(42);
    }

    [Fact]
    public async Task Admission_DeniesDeletedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, StableAccountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            2,
            null,
            false,
            null,
            AccountSubjectHash: StableAccountSubjectHash)));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
        Assert.Equal("account_deleted", result.ErrorCode);
    }

    [Fact]
    public async Task Admission_CachesAccountStateAcrossReconnectsButStillChecksBanState()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, StableAccountSubjectHash)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            1,
            "active",
            false,
            null,
            AccountSubjectHash: StableAccountSubjectHash)));
        var admission = new NotificationStreamAdmissionService(blacklist, users, new NotificationStreamAccountAdmissionCache());

        NotificationStreamAdmissionResult first = await admission.ValidateAsync("42", CancellationToken.None);
        NotificationStreamAdmissionResult second = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.True(first.IsAllowed);
        Assert.True(second.IsAllowed);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.Received(2).GetBanStateAsync(42, StableAccountSubjectHash);
    }

    [Fact]
    public async Task AdmissionAccountCache_HighCardinalityRemainsWithinAllBudgetsAndEvictsOldest()
    {
        const int MaxEntries = 128;
        var reader = new GeneratedAccountReader();
        var cache = new NotificationStreamAccountAdmissionCache(
            new NotificationStreamAccountAdmissionCacheOptions
            {
                MaxEntries = MaxEntries,
                MaxLogicalBytes = 1024 * 1024,
                MaxCapacityBytes = 2 * 1024 * 1024
            },
            TimeProvider.System);

        for (int accountId = 1; accountId <= 20_000; accountId++)
        {
            NotificationStreamAccountAdmissionCacheResult result = await cache.GetOrCreateAsync(
                accountId,
                reader,
                CancellationToken.None);
            Assert.Equal(accountId, result.Account?.Id);
        }

        NotificationStreamAccountAdmissionCacheSnapshot snapshot = cache.Snapshot();
        Assert.Equal(MaxEntries, snapshot.Entries);
        Assert.InRange(snapshot.LogicalBytes, 1, snapshot.MaxLogicalBytes);
        Assert.InRange(snapshot.CapacityBytes, snapshot.LogicalBytes, snapshot.MaxCapacityBytes);

        int loadsBeforeProbes = reader.LoadCount;
        NotificationStreamAccountAdmissionCacheResult newest = await cache.GetOrCreateAsync(
            20_000,
            reader,
            CancellationToken.None);
        NotificationStreamAccountAdmissionCacheResult oldest = await cache.GetOrCreateAsync(
            1,
            reader,
            CancellationToken.None);
        Assert.True(newest.Hit);
        Assert.False(oldest.Hit);
        Assert.Equal(loadsBeforeProbes + 1, reader.LoadCount);
    }

    [Fact]
    public async Task AdmissionAccountCache_ConcurrentUniqueLoadsRemainWithinEntryAndByteBudgets()
    {
        var reader = new GeneratedAccountReader(yieldBeforeReturn: true);
        var cache = new NotificationStreamAccountAdmissionCache(
            new NotificationStreamAccountAdmissionCacheOptions
            {
                MaxEntries = 10_000,
                MaxLogicalBytes = 8 * 1024,
                MaxCapacityBytes = 12 * 1024
            },
            TimeProvider.System);

        NotificationStreamAccountAdmissionCacheResult[] results = await Task.WhenAll(
            Enumerable.Range(1, 10_000)
                .Select(accountId => cache.GetOrCreateAsync(accountId, reader, CancellationToken.None)));

        Assert.All(results, static result => Assert.NotNull(result.Account));
        NotificationStreamAccountAdmissionCacheSnapshot snapshot = cache.Snapshot();
        Assert.InRange(snapshot.Entries, 1, snapshot.MaxEntries);
        Assert.True(snapshot.Entries < snapshot.MaxEntries);
        Assert.InRange(snapshot.LogicalBytes, 1, snapshot.MaxLogicalBytes);
        Assert.InRange(snapshot.CapacityBytes, snapshot.LogicalBytes, snapshot.MaxCapacityBytes);
        Assert.Equal(10_000, reader.LoadCount);
    }

    [Fact]
    public async Task AdmissionAccountCache_SnapshotSweepsExpiredEntriesWithoutExtendingTtlOnHit()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 14, 0, 0, 0, TimeSpan.Zero));
        var reader = new GeneratedAccountReader();
        var cache = new NotificationStreamAccountAdmissionCache(
            new NotificationStreamAccountAdmissionCacheOptions(),
            clock);

        _ = await cache.GetOrCreateAsync(42, reader, CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(59));
        Assert.True((await cache.GetOrCreateAsync(42, reader, CancellationToken.None)).Hit);
        clock.Advance(TimeSpan.FromSeconds(2));

        NotificationStreamAccountAdmissionCacheSnapshot expired = cache.Snapshot();
        Assert.Equal(0, expired.Entries);
        Assert.Equal(0, expired.LogicalBytes);
        Assert.Equal(0, expired.CapacityBytes);
        Assert.False((await cache.GetOrCreateAsync(42, reader, CancellationToken.None)).Hit);
        Assert.Equal(2, reader.LoadCount);
    }

    [Fact]
    public void AdmissionAccountCache_BindsExplicitBudgetsFromConfiguration()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{NotificationStreamAccountAdmissionCacheOptions.SectionName}:MaxEntries"] = "17",
                [$"{NotificationStreamAccountAdmissionCacheOptions.SectionName}:MaxLogicalBytes"] = "4096",
                [$"{NotificationStreamAccountAdmissionCacheOptions.SectionName}:MaxCapacityBytes"] = "8192"
            })
            .Build();
        var services = new ServiceCollection();
        services.AddFsusRuntimeInfrastructureServices(configuration);
        using ServiceProvider provider = services.BuildServiceProvider();

        NotificationStreamAccountAdmissionCacheSnapshot snapshot = provider
            .GetRequiredService<NotificationStreamAccountAdmissionCache>()
            .Snapshot();

        Assert.Equal(17, snapshot.MaxEntries);
        Assert.Equal(4096, snapshot.MaxLogicalBytes);
        Assert.Equal(8192, snapshot.MaxCapacityBytes);
    }

    [Fact]
    public async Task Admission_MissingPhysicalSubjectFailsClosedWithoutBanLookup()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            0,
            null,
            false,
            null,
            AccountSubjectHash: null)));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        NotificationStreamAdmissionResult result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
        Assert.Equal("account_subject_invalid", result.ErrorCode);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
    }

    [Fact]
    public void AudienceResolver_DoesNotMapRoleOnlyUserToAdminGroup()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim(ClaimTypes.Role, "admin"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ],
            "test"));
        var resolver = new NotificationStreamAudienceResolver();

        IReadOnlySet<string> groups = resolver.ResolveGroups(principal, "42");

        Assert.Single(groups);
        Assert.Contains(NotificationStreamTargetCollections.ContentFeed, groups);
        Assert.DoesNotContain(NotificationStreamTargetCollections.AdminUsers, groups);
    }

    [Fact]
    public void AudienceResolver_MapsAdminPrincipalToNotificationStreamTargetCollections()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42")
            ],
            "test"));
        var resolver = new NotificationStreamAudienceResolver();

        IReadOnlySet<string> groups = resolver.ResolveGroups(principal, "42");

        Assert.Contains(NotificationStreamTargetCollections.ContentFeed, groups);
        Assert.Contains(NotificationStreamTargetCollections.AdminUsers, groups);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Handshake_DeniesCrossSiteOriginForStreamAndPreflight(bool requireWebSocket)
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"]);
        DefaultHttpContext context = CreateHandshakeContext("https://evil.example", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status403Forbidden, result.StatusCode);
        Assert.Equal("origin_not_allowed", result.ErrorCode);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Handshake_AllowsConfiguredOriginForStreamAndPreflight(bool requireWebSocket)
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"]);
        DefaultHttpContext context = CreateHandshakeContext("https://example.com", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket);

        Assert.True(result.IsSuccess);
        Assert.Equal("42", result.Handshake!.UserId);
    }

    [Fact]
    public async Task Handshake_AdminPrincipalDoesNotUseSysUserAdmission()
    {
        var admission = new CapturingAdmissionService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            admissionService: admission);
        DefaultHttpContext context = CreateHandshakeContext("https://example.com", "example.com");
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42")
            ],
            "test"));

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Null(result.Handshake!.UserId);
        Assert.Contains(NotificationStreamTargetCollections.AdminUsers, result.Handshake.Groups);
        Assert.Equal([null], admission.Requests);
    }

    [Fact]
    public async Task Handshake_AllowsDevelopmentLocalhostOrigin()
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Development },
            []);
        DefaultHttpContext context = CreateHandshakeContext("http://localhost:5173", "localhost:7568");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task Handshake_RuntimeChecksOriginBeforeAnonymousPow()
    {
        MethodInfo validate = typeof(NotificationStreamHandshakeService).GetMethod(nameof(NotificationStreamHandshakeService.ValidateAsync))!;
        (int Offset, MethodBase Method)[] calls = ReadCalledMethods(AsyncMoveNext(validate)).ToArray();
        int validateRequest = Assert.Single(calls, static call =>
            call.Method.DeclaringType == typeof(INotificationStreamHandshakeRequestValidator)
            && call.Method.Name == nameof(INotificationStreamHandshakeRequestValidator.Validate)).Offset;
        int validateRisk = Assert.Single(calls, static call =>
            call.Method.DeclaringType == typeof(INotificationStreamRiskProofPolicy)
            && call.Method.Name == nameof(INotificationStreamRiskProofPolicy.ValidateAsync)).Offset;
        Assert.True(validateRequest < validateRisk);

        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.Contains("notification", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof);
        DefaultHttpContext rejected = CreateAnonymousHandshakeContext("https://evil.example", "example.com");
        AddRiskControlHeaders(rejected);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(rejected, CancellationToken.None, requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal("origin_not_allowed", result.ErrorCode);
        Assert.Empty(proof.ConsumeRequests);
        Assert.Contains("fsus.notification_stream.handshake.origin_validation_elapsed_ms", measurements);
        Assert.Contains("fsus.notification.handshake.origin_cache.elapsed", measurements);
        listener.RecordObservableInstruments();
        Assert.Contains("fsus.notification.handshake.origin_cache.hit_ratio", measurements);

        string runtime = RuntimeMetadataInspection.DescribeType(typeof(NotificationStreamRiskProofPolicy));
        Assert.Contains("PowValidationLogic.ValidateFromQueryAsync", runtime, StringComparison.Ordinal);
        string requestRuntime = RuntimeMetadataInspection.DescribeType(typeof(NotificationStreamHandshakeRequestValidator));
        Assert.Contains("Seo:BaseUrl", requestRuntime, StringComparison.Ordinal);
        Assert.Contains("Fido2:Origins", requestRuntime, StringComparison.Ordinal);
        Assert.Contains("CORS_ALLOWED_HOSTS", requestRuntime, StringComparison.Ordinal);
        Assert.Contains("localhost", requestRuntime, StringComparison.OrdinalIgnoreCase);
        string originRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamHandshakeRequestValidator), "ValidateOrigin");
        Assert.Contains("NotificationStreamOriginSnapshotProvider.get_Current", originRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildAllowedOrigins", originRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildAllowedHosts", originRuntime, StringComparison.Ordinal);

        var registrations = new ServiceCollection();
        registrations.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());
        Assert.Equal(ServiceLifetime.Singleton, Assert.Single(registrations, static descriptor =>
            descriptor.ServiceType == typeof(NotificationStreamOriginSnapshotProvider)).Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, Assert.Single(registrations, static descriptor =>
            descriptor.ServiceType == typeof(NotificationStreamAccountAdmissionCache)).Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(registrations, static descriptor =>
            descriptor.ServiceType == typeof(INotificationStreamHandshakeRequestValidator)).Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(registrations, static descriptor =>
            descriptor.ServiceType == typeof(INotificationStreamRiskProofPolicy)).Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(registrations, static descriptor =>
            descriptor.ServiceType == typeof(INotificationStreamConnectionAdmission)).Lifetime);

        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, StableAccountSubjectHash).Returns(new BanStateSnapshot(false, null, null));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(new UserAccountSnapshot(42, 1, "active", false, null, StableAccountSubjectHash));
        var admission = new NotificationStreamAdmissionService(blacklist, users, new NotificationStreamAccountAdmissionCache());
        await admission.ValidateAsync("42", CancellationToken.None);
        await admission.ValidateAsync("42", CancellationToken.None);
        users.GetAccountByIdAsync(43).Returns((UserAccountSnapshot?)null);
        await admission.ValidateAsync("43", CancellationToken.None);
        Assert.Contains("fsus.notification_stream.admission.account_state_cache", measurements);
        Assert.Contains("fsus.notification_stream.admission.db_read_count", measurements);
        Assert.Contains("fsus.notification_stream.admission.rejected_reason_count", measurements);
    }

    [Fact]
    public async Task Handshake_PreflightConsumesRiskControlHeaderProofAndMintsOneTimeGrant()
    {
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.True(result.IsSuccess);
        Assert.Single(proof.ConsumeRequests);
        Assert.Equal("grant-token", result.PreflightGrantToken);
    }

    [Fact]
    public async Task Handshake_PreflightResumesGrantWhenAtomicExchangeResponseWasLost()
    {
        var proof = new CapturingProofService { AcceptExchange = false };
        var grants = new CapturingPreflightGrantService { ResumeOnCall = 2 };
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof,
            preflightGrantService: grants);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.True(result.IsSuccess);
        Assert.Equal("grant-token", result.PreflightGrantToken);
        Assert.Single(proof.ConsumeRequests);
        Assert.Equal(2, grants.ResumeCalls);
    }

    [Fact]
    public async Task Handshake_PreflightDoesNotCreateGrantForRejectedProof()
    {
        var proof = new CapturingProofService { AcceptExchange = false };
        var grants = new CapturingPreflightGrantService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof,
            preflightGrantService: grants);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("risk_challenge_replayed", result.ErrorCode);
        Assert.Equal(0, grants.CreatedTargets);
    }

    [Fact]
    public async Task Handshake_PreflightGrantPreparationFailureReturnsServiceUnavailable()
    {
        var grants = new CapturingPreflightGrantService { ThrowWhenCreatingTarget = true };
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof: new CapturingProofService(),
            preflightGrantService: grants);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.StatusCode);
        Assert.Equal("risk_challenge_grant_unavailable", result.ErrorCode);
        Assert.Equal(1, grants.CreatedTargets);
    }

    [Fact]
    public async Task Handshake_MultiChallengePolicyConsumesOneAggregateProofWithOrderedMembers()
    {
        var proof = new CapturingProofService();
        SecurityRiskPolicy policy = CreateNotificationRiskPolicy();
        SecurityRiskActionPolicy notification = policy.ActionOverrides[RiskActionNames.NotificationSubscribe] with
        {
            Thresholds = new SecurityRiskActionThresholds(0, 0, 0, 100, 100),
            HardChallengeKinds = ["perceptionLocalizationV2", "sha256PowV1"]
        };
        policy = policy with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.NotificationSubscribe] = notification
            }
        };
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof,
            riskPolicy: policy);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.True(result.IsSuccess);
        SecurityChallengeProofConsumeRequest consumed = Assert.Single(proof.ConsumeRequests);
        Assert.Equal(["perceptionLocalizationV2", "sha256PowV1"], consumed.RequiredKinds);
    }

    [Fact]
    public async Task Handshake_WebSocketConsumesPreflightGrantWithoutReusingProof()
    {
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        context.Request.Headers.Cookie = $"{NotificationStreamRiskProofPolicy.PreflightGrantCookieName}=grant-token";

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Empty(proof.ConsumeRequests);
    }

    [Fact]
    public async Task Handshake_WebSocketAcceptsLegacyPowQueryForAnonymousSubscribe()
    {
        var powService = Substitute.For<IPowService>();
        powService.VerifyAsync(Arg.Any<IPowRequest>(), "198.51.100.17").Returns(Task.FromResult(true));
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof,
            powService);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddLegacyPowQuery(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Empty(proof.ConsumeRequests);
        await powService.Received(1).VerifyAsync(
            Arg.Is<IPowRequest>(request =>
                request.Difficulty == 16 &&
                request.PowSalt == "salt" &&
                request.PowNonce == "nonce" &&
                request.PowSignature == "signature" &&
                request.BrowserFp == "fp"),
            "198.51.100.17");
    }

    [Fact]
    public async Task Handshake_HighRiskAnonymousSubscribeWithoutProofReturnsRiskChallengeRequired()
    {
        var riskSink = new CapturingRiskSink();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            riskSink: riskSink);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("risk_challenge_required", result.ErrorCode);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(0, signal.Score);
        Assert.Equal("challenge_proof_missing", signal.Detail);
    }

    [Fact]
    public void Handshake_RuntimeKeepsLegacyPowCompatibilityAndNotificationRiskAction()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(NotificationStreamRiskProofPolicy),
            nameof(NotificationStreamRiskProofPolicy.ValidateAsync));

        Assert.Contains("PowValidationLogic.ValidateFromQueryAsync", runtime, StringComparison.Ordinal);
        Assert.Contains(RiskActionNames.NotificationSubscribe, runtime, StringComparison.Ordinal);
        Assert.Equal("X-Fsus-Challenge-Proof", typeof(NotificationStreamRiskProofPolicy)
            .GetField("ChallengeProofHeaderName", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetRawConstantValue());
        Assert.Equal("Fsus-Notification-Grant", NotificationStreamRiskProofPolicy.PreflightGrantCookieName);
    }

    [Fact]
    public async Task SessionService_SwallowsAcceptWebSocketFailureAndRemovesConnection()
    {
        var manager = new NotificationStreamConnectionManager(new ConfigurationBuilder().Build(), NullLogger<NotificationStreamConnectionManager>.Instance);
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(Substitute.For<IDatabase>());
        var backlog = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            NullLogger<NotificationStreamBacklogStore>.Instance);
        var service = new NotificationStreamSessionService(manager, backlog, new TestNotificationFrameCodec(), new TestWebHostEnvironment(), NullLogger<NotificationStreamSessionService>.Instance);
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        var handshake = new NotificationStreamHandshake("fsus-aeds.v2", "42", new HashSet<string>(StringComparer.Ordinal));

        Exception? exception = await Record.ExceptionAsync(() => service.RunAsync(context, handshake, CancellationToken.None));

        Assert.Null(exception);
        Assert.Equal(0, manager.ConnectionCount);
    }

    [Fact]
    public async Task BacklogReplay_DoesNotMissGapWhenCursorFloorEntryIsStillRetained()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        database.CreateBatch(Arg.Any<object?>()).Returns(batch);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        batch.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<int?>(),
                Arg.Any<Order>(),
                Arg.Any<CommandFlags>())
            .Returns(
                Task.FromResult(new[] { StreamEntry("100-0", [0x64]) }),
                Task.FromResult(new[] { StreamEntry("51-0", [0x33]) }),
                Task.FromResult(new[] { StreamEntry("50-0", [0x32]) }));
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis), keyScope, NullLogger<NotificationStreamBacklogStore>.Instance);

        NotificationStreamReplayBatch replay = await store.ReplayAsync(new NotificationStreamCursor(50), "42", new HashSet<string>(StringComparer.Ordinal));

        try
        {
            Assert.False(replay.MissedGap);
            Assert.Single(replay.Frames);
        }
        finally
        {
            foreach (SharedNotificationStreamFrame frame in replay.Frames)
            {
                frame.Release();
            }
        }
    }

    [Fact]
    public async Task BacklogReplay_MissedGapRequiresCursorFloorProbe()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        database.CreateBatch(Arg.Any<object?>()).Returns(batch);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        batch.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<int?>(),
                Arg.Any<Order>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                Order order = call.ArgAt<Order>(4);
                StreamEntry[] result = order == Order.Descending
                    ? []
                    : [StreamEntry("100-0", [0x64])];
                return Task.FromResult(result);
            });
        batch.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                default,
                default,
                1,
                Order.Ascending,
                CommandFlags.None)
            .Returns(Task.FromResult(new[] { StreamEntry("100-0", [0x64]) }));
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis), keyScope, NullLogger<NotificationStreamBacklogStore>.Instance);

        NotificationStreamReplayBatch replay = await store.ReplayAsync(
            new NotificationStreamCursor(50),
            "42",
            new HashSet<string>(StringComparer.Ordinal));

        try
        {
            Assert.True(replay.MissedGap);
            Assert.Single(replay.Frames);
        }
        finally
        {
            foreach (SharedNotificationStreamFrame frame in replay.Frames)
            {
                frame.Release();
            }
        }

        object?[][] ranges = batch.ReceivedCalls()
            .Where(static call => call.GetMethodInfo().Name == nameof(IBatch.StreamRangeAsync))
            .Select(static call => call.GetArguments())
            .ToArray();
        Assert.Equal(3, ranges.Length);
        Assert.Contains(ranges, static arguments =>
            arguments[1] is null && arguments[2] is null && Equals(arguments[3], 1) && Equals(arguments[4], Order.Ascending));
        Assert.Contains(ranges, static arguments =>
            string.Equals(arguments[1]?.ToString(), "-", StringComparison.Ordinal)
            && string.Equals(arguments[2]?.ToString(), "50-0", StringComparison.Ordinal)
            && Equals(arguments[3], 1)
            && Equals(arguments[4], Order.Descending));
        batch.Received(1).Execute();
        Assert.DoesNotContain(
            database.ReceivedCalls(),
            static call => call.GetMethodInfo().Name == nameof(IDatabase.StreamRangeAsync));
    }

    [Fact]
    public async Task BacklogReplay_RuntimeBatchesRouteReadsAndRecordsRedisCommandCount()
    {
        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.notification_stream.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<int>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        database.CreateBatch(Arg.Any<object?>()).Returns(batch);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        batch.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<int?>(),
                Arg.Any<Order>(),
                Arg.Any<CommandFlags>())
            .Returns(
                Task.FromResult(new[] { StreamEntry("100-0", [0x64]) }),
                Task.FromResult(new[] { StreamEntry("51-0", [0x33]) }),
                Task.FromResult(new[] { StreamEntry("50-0", [0x32]) }));
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis), keyScope, NullLogger<NotificationStreamBacklogStore>.Instance);

        NotificationStreamReplayBatch replay = await store.ReplayAsync(
            new NotificationStreamCursor(50),
            "42",
            new HashSet<string>(StringComparer.Ordinal));
        NotificationStreamMetrics.RecordPublishFanout(
            2,
            new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed),
            128);
        foreach (SharedNotificationStreamFrame frame in replay.Frames)
            frame.Release();

        batch.Received(1).Execute();
        Assert.Contains("fsus.notification_stream.replay_redis_commands", measurements);
        Assert.Contains("fsus.notification_stream.publish_fanout", measurements);
        Assert.Contains("fsus.notification_stream.publish_allocation_estimate_bytes", measurements);
        string replayRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamBacklogStore), nameof(NotificationStreamBacklogStore.ReplayAsync));
        Assert.Contains("ReadRouteReplaysAsync", replayRuntime, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamMetrics.RecordReplay", replayRuntime, StringComparison.Ordinal);
        Assert.Contains(typeof(NotificationStreamMetrics).GetMethod("RecordReplay", BindingFlags.Public | BindingFlags.Static)!.GetParameters(),
            static parameter => parameter.Name == "redisCommandCount");
    }

    [Fact]
    public async Task BacklogAppend_RuntimeUsesSingleFieldStreamAddWithoutPerPublishNameValueArray()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        database.StreamAddAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue?>(),
                Arg.Any<int?>(),
                Arg.Any<bool>(),
                Arg.Any<CommandFlags>())
            .Returns((RedisValue)"100-0");
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis), keyScope, NullLogger<NotificationStreamBacklogStore>.Instance);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);

        var result = await store.AppendAsync(100, "u:42", frame, CancellationToken.None);
        frame.Release();

        Assert.True(result.IsSuccess);
        var call = Assert.Single(database.ReceivedCalls(), static candidate => candidate.GetMethodInfo().Name == nameof(IDatabase.StreamAddAsync));
        object?[] arguments = call.GetArguments();
        Assert.Equal("f", arguments[1]?.ToString());
        Assert.DoesNotContain(arguments, static argument => argument is NameValueEntry[]);
        Assert.Equal("100-0", arguments[3]?.ToString());
    }

    [Fact]
    public async Task BacklogPublishOrderLocks_AreScopedToSortedStorageRoutesAndReleaseOwnedTokens()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => $"test:{call.Arg<string>()}");
        database.LockTakeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan>(),
                Arg.Any<CommandFlags>())
            .Returns(false, true);
        database.LockReleaseAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis),
            keyScope,
            NullLogger<NotificationStreamBacklogStore>.Instance);

        IReadOnlyList<NotificationStreamPublishOrderLock> locks =
            await store.AcquirePublishOrderLocksAsync("m:20,10", CancellationToken.None);
        bool released = await store.ReleasePublishOrderLocksAsync(locks);

        Assert.Equal(2, locks.Count);
        Assert.EndsWith("publish-order-lock:u:10", locks[0].Key.ToString(), StringComparison.Ordinal);
        Assert.EndsWith("publish-order-lock:u:20", locks[1].Key.ToString(), StringComparison.Ordinal);
        Assert.True(released);
        await database.Received(3).LockTakeAsync(
            Arg.Is<RedisKey>(key => key.ToString().Contains("publish-order-lock:u:", StringComparison.Ordinal)),
            Arg.Any<RedisValue>(),
            Arg.Any<TimeSpan>(),
            Arg.Any<CommandFlags>());
        await database.Received(2).LockReleaseAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<RedisValue>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public void SessionService_RuntimeClosesSocketUnderSendGate()
    {
        string pump = RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamSessionService), "PumpConnectionAsync");
        string close = RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamSessionService), "CloseSocketAsync");

        Assert.Contains("CloseSocketAsync", pump, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamConnection.get_IsClosed", pump, StringComparison.Ordinal);
        Assert.Contains("SemaphoreSlim.WaitAsync", close, StringComparison.Ordinal);
        Assert.Contains("WebSocket.CloseAsync", close, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DrillPublishEndpoint_RuntimeIsTestOnlyAndSecretProtected()
    {
        WebApplicationBuilder productionBuilder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
        await using WebApplication production = productionBuilder.Build();
        production.MapNotificationStreamDrillEndpoints();
        Assert.Empty(FindRoutes(production, "/_fsus/testing/notification-stream/publish"));

        WebApplicationBuilder testBuilder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Test" });
        testBuilder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_notification_drill_contract;Username=test;Password=test",
            ["Jwt:SecretKey"] = "notification-drill-contract-signing-key-at-least-32-bytes",
            ["Jwt:Issuer"] = "NotificationDrillContractTests",
            ["Jwt:Audience"] = "NotificationDrillContractTests",
            ["CORS_ALLOWED_HOSTS"] = "https://console.example.test",
            ["Security:IpHashKey"] = "notification-drill-contract-ip-hash-key"
        });
        testBuilder.Services
            .AddFsusApiFoundation(testBuilder.Configuration)
            .AddFsusRuntimeServices(testBuilder.Configuration);
        testBuilder.Services.RemoveAll<IHostedService>();
        await using WebApplication test = testBuilder.Build();
        test.MapNotificationStreamDrillEndpoints();
        RouteEndpoint endpoint = Assert.Single(FindRoutes(test, "/_fsus/testing/notification-stream/publish"));
        MethodInfo handler = endpoint.Metadata.GetMetadata<MethodInfo>()!;
        Assert.Contains(handler.GetParameters(), static parameter => parameter.ParameterType == typeof(INotificationStreamPublisher));
        Assert.Equal("X-Fsus-Notification-Drill-Secret", typeof(NotificationStreamDrillEndpoints)
            .GetField("DrillSecretHeader", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetRawConstantValue());
        Assert.Contains("NotificationStreamTargetRouteCodec.TryEncode",
            RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamDrillEndpoints), "PublishAsync"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void SessionService_RuntimeGatesDrillSendDelayToDevelopmentOrTest()
    {
        NotificationStreamSessionService production = CreateSessionService(new TestWebHostEnvironment { EnvironmentName = Environments.Production });
        NotificationStreamSessionService test = CreateSessionService(new TestWebHostEnvironment { EnvironmentName = "Test" });
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString("?drillSlowConsumer=true&drillReadDelayMs=75&drillQueueCapacity=64");
        MethodInfo delay = typeof(NotificationStreamSessionService).GetMethod("ResolveDrillSendDelay", BindingFlags.NonPublic | BindingFlags.Instance)!;
        MethodInfo capacity = typeof(NotificationStreamSessionService).GetMethod("ResolveDrillQueueCapacity", BindingFlags.NonPublic | BindingFlags.Instance)!;

        Assert.Null(delay.Invoke(production, [context]));
        Assert.Null(capacity.Invoke(production, [context]));
        Assert.Equal(TimeSpan.FromMilliseconds(75), delay.Invoke(test, [context]));
        Assert.Equal(64, capacity.Invoke(test, [context]));
        string runRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(NotificationStreamSessionService), nameof(NotificationStreamSessionService.RunAsync));
        Assert.Contains("NotificationStreamConnectionManager.RegisterConnection", runRuntime, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamBacklogStore.ReplayAsync", runRuntime, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamSessionService.PumpConnectionAsync", runRuntime, StringComparison.Ordinal);
        Assert.Contains("HttpContextExtensions.GetClientIp", runRuntime, StringComparison.Ordinal);
    }

    private sealed class ThrowingWebSocketFeature : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => true;

        public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
            => Task.FromException<WebSocket>(new IOException("client disconnected before websocket accept completed"));
    }

    private sealed class TestWebHostEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestNotificationFrameCodec : INotificationFrameCodec
    {
        public byte[] EncodeHeartbeatFrame() => [0x01];

        public SharedNotificationStreamFrame EncodeEventFrame<TPayload>(long eventId, NotificationStreamEventType eventType, TPayload payload)
            => SharedNotificationStreamFrame.FromArray([0x01]);
    }

    private static StreamEntry StreamEntry(string id, byte[] payload)
        => new(id, [new NameValueEntry("f", payload)]);

    private static NotificationStreamHandshakeService CreateHandshakeService(
        IWebHostEnvironment environment,
        IEnumerable<string> settings,
        int riskScore = 0,
        CapturingProofService? proof = null,
        IPowService? powService = null,
        INotificationStreamAdmissionService? admissionService = null,
        CapturingRiskSink? riskSink = null,
        DeploymentRuntimeState? deploymentRuntime = null,
        INotificationStreamPreflightGrantService? preflightGrantService = null,
        SecurityRiskPolicy? riskPolicy = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings.Select(static item =>
            {
                int separator = item.IndexOf('=', StringComparison.Ordinal);
                return new KeyValuePair<string, string?>(
                    item[..separator],
                    item[(separator + 1)..]);
            }))
            .Build();
        var requestValidator = new NotificationStreamHandshakeRequestValidator(
            new NotificationStreamOriginSnapshotProvider(configuration),
            environment,
            deploymentRuntime);
        var riskProofPolicy = new NotificationStreamRiskProofPolicy(
            powService ?? Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()),
            new FixedRiskScoreReader(riskScore),
            new FixedRiskPolicyProvider(riskPolicy ?? CreateNotificationRiskPolicy()),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            proof ?? new CapturingProofService(),
            riskSink ?? new CapturingRiskSink(),
            NullLoggerFactory.Instance,
            preflightGrantService ?? new CapturingPreflightGrantService());
        var connectionAdmission = new NotificationStreamConnectionAdmission(
            admissionService ?? new AllowingAdmissionService(),
            new NotificationStreamAudienceResolver());
        return new NotificationStreamHandshakeService(requestValidator, riskProofPolicy, connectionAdmission);
    }

    private static DefaultHttpContext CreateHandshakeContext(string origin, string host)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        context.Request.Headers.Origin = origin;
        context.Request.Headers.Host = host;
        context.Request.Headers.SecWebSocketProtocol = "fsus-aeds.v2";
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "test"));
        return context;
    }

    private static DefaultHttpContext CreateAnonymousHandshakeContext(string origin, string host)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("198.51.100.17");
        context.Request.Headers.Origin = origin;
        context.Request.Headers.Host = host;
        context.Request.Headers.SecWebSocketProtocol = "fsus-aeds.v2";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        return context;
    }

    private static void AddRiskControlHeaders(DefaultHttpContext context)
    {
        context.Request.Headers["X-Fsus-Challenge-Proof"] = "proof-ok";
        context.Request.Headers["X-Fsus-Challenge-Id"] = "notification-challenge";
        context.Request.Headers["X-Fsus-Challenge-Kind"] = "sha256PowV1";
    }

    private static void AddLegacyPowQuery(DefaultHttpContext context)
    {
        context.Request.QueryString = new QueryString($"?pow={Uri.EscapeDataString(CreateEncodedPowProof())}");
    }

    private static string CreateEncodedPowProof()
    {
        byte[] salt = Encoding.UTF8.GetBytes("salt");
        byte[] nonce = Encoding.UTF8.GetBytes("nonce");
        byte[] signature = Encoding.UTF8.GetBytes("signature");
        byte[] browserFp = Encoding.UTF8.GetBytes("fp");
        int length = 17
            + sizeof(ushort) + salt.Length
            + sizeof(ushort) + nonce.Length
            + sizeof(ushort) + signature.Length
            + sizeof(ushort) + browserFp.Length;
        byte[] buffer = new byte[length];
        buffer[0] = (byte)'F';
        buffer[1] = (byte)'P';
        buffer[2] = (byte)'O';
        buffer[3] = (byte)'W';
        buffer[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(5), 16);
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(9), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        int offset = 17;
        WriteString(buffer, salt, ref offset);
        WriteString(buffer, nonce, ref offset);
        WriteString(buffer, signature, ref offset);
        WriteString(buffer, browserFp, ref offset);
        return Convert.ToBase64String(buffer);
    }

    private static void WriteString(byte[] target, byte[] value, ref int offset)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset), (ushort)value.Length);
        offset += sizeof(ushort);
        value.CopyTo(target.AsSpan(offset));
        offset += value.Length;
    }

    private static SecurityRiskPolicy CreateNotificationRiskPolicy()
    {
        var defaultAction = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            "sha256PowV1",
            1,
            null,
            AnonymousWriteAllowed: true);
        var notification = defaultAction with
        {
            ActionName = RiskActionNames.NotificationSubscribe,
            Thresholds = new SecurityRiskActionThresholds(0, 0, 100, 100, 100)
        };

        return new SecurityRiskPolicy(
            "risk:notification-test",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultAction,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.NotificationSubscribe] = notification
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled
            });
    }

    private sealed class AllowingAdmissionService : INotificationStreamAdmissionService
    {
        public Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
            => Task.FromResult(NotificationStreamAdmissionResult.Allowed);
    }

    private sealed class CapturingAdmissionService : INotificationStreamAdmissionService
    {
        public List<string?> Requests { get; } = [];

        public Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
        {
            Requests.Add(userId);
            return Task.FromResult(NotificationStreamAdmissionResult.Allowed);
        }
    }

    private sealed class GeneratedAccountReader(bool yieldBeforeReturn = false) : IUserAccountReader
    {
        private int _loadCount;

        public int LoadCount => Volatile.Read(ref _loadCount);

        public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
        {
            Interlocked.Increment(ref _loadCount);
            if (yieldBeforeReturn)
            {
                await Task.Yield();
            }
            return new UserAccountSnapshot(
                id,
                0,
                null,
                false,
                null,
                PublicHandle: $"account-{id}",
                AccountSubjectHash: id.ToString("x64", System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }

    private sealed class FixedRiskScoreReader(int score) : ISecurityRiskScoreReader
    {
        public Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class CapturingProofService : ISecurityChallengeProofService
    {
        public List<SecurityChallengeProofConsumeRequest> ConsumeRequests { get; } = [];

        public bool AcceptExchange { get; init; } = true;

        public Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
        {
            ConsumeRequests.Add(request);
            return Task.FromResult(SecurityChallengeProofConsumeResult.Success(CreateClaims(request)));
        }

        public Task<SecurityChallengeProofExchangeResult> ExchangeProofAsync(
            SecurityChallengeProofConsumeRequest request,
            Func<SecurityChallengeProofClaims, SecurityChallengeProofExchangeTarget> targetFactory,
            CancellationToken cancellationToken = default)
        {
            ConsumeRequests.Add(request);
            if (!AcceptExchange)
            {
                return Task.FromResult(new SecurityChallengeProofExchangeResult(
                    false,
                    SecurityChallengeProofOutcomes.ReplayedOrMissing,
                    "proof_replayed_or_missing",
                    null,
                    null));
            }

            SecurityChallengeProofClaims claims = CreateClaims(request);
            SecurityChallengeProofExchangeTarget target = targetFactory(claims);
            return Task.FromResult(new SecurityChallengeProofExchangeResult(
                true,
                SecurityChallengeProofOutcomes.Accepted,
                "ok",
                claims,
                target));
        }

        private static SecurityChallengeProofClaims CreateClaims(SecurityChallengeProofConsumeRequest request)
            => new(
                request.ChallengeId,
                request.Kind,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                DateTimeOffset.UtcNow.AddMinutes(-1),
                DateTimeOffset.UtcNow.AddMinutes(5),
                "nonce",
                request.PolicyVersion,
                EnvelopeId: null,
                RequiredKinds: request.RequiredKinds);
    }

    private sealed class CapturingPreflightGrantService : INotificationStreamPreflightGrantService
    {
        public int ResumeOnCall { get; init; } = int.MaxValue;

        public bool ThrowWhenCreatingTarget
        {
            get; init;
        }

        public int ResumeCalls
        {
            get; private set;
        }

        public int CreatedTargets
        {
            get; private set;
        }

        public NotificationStreamPreflightGrantExchange CreateExchangeTarget(
            string proofToken,
            SecurityChallengeProofClaims proof)
        {
            CreatedTargets++;
            if (ThrowWhenCreatingTarget)
            {
                throw new InvalidOperationException("grant unavailable");
            }

            return new("grant-token", "grant:token", [1], TimeSpan.FromSeconds(30));
        }

        public Task<string?> TryResumeExchangeAsync(
            string proofToken,
            NotificationStreamPreflightGrantBinding binding,
            CancellationToken cancellationToken)
        {
            ResumeCalls++;
            return Task.FromResult<string?>(ResumeCalls >= ResumeOnCall ? "grant-token" : null);
        }

        public Task<NotificationStreamPreflightGrantConsumeResult> ConsumeAsync(
            string token,
            NotificationStreamPreflightGrantBinding binding,
            CancellationToken cancellationToken)
            => Task.FromResult(string.Equals(token, "grant-token", StringComparison.Ordinal)
                ? NotificationStreamPreflightGrantConsumeResult.Success
                : NotificationStreamPreflightGrantConsumeResult.Reject(SecurityChallengeProofOutcomes.ReplayedOrMissing));
    }

    private static NotificationStreamSessionService CreateSessionService(IWebHostEnvironment environment)
    {
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance);
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(Substitute.For<IDatabase>());
        var backlog = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            NullLogger<NotificationStreamBacklogStore>.Instance);
        return new NotificationStreamSessionService(
            manager,
            backlog,
            new TestNotificationFrameCodec(),
            environment,
            NullLogger<NotificationStreamSessionService>.Instance);
    }

    private static RouteEndpoint[] FindRoutes(WebApplication app, string route)
        => ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => string.Equals(
                endpoint.RoutePattern.RawText?.TrimStart('/'),
                route.TrimStart('/'),
                StringComparison.Ordinal))
            .ToArray();

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<(int Offset, MethodBase Method)> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return (offset, called);
        }
    }
}
