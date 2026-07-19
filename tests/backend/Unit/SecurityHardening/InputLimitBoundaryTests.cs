using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class InputLimitBoundaryTests
{
    [Fact]
    public void AuthoringRequestModel_RejectsOversizedContentBeforeWorkflow()
    {
        var request = new ServerDraftSaveRequest(
            DraftKey: "draft",
            ArticleId: null,
            Title: "title",
            Content: new string('x', 262_145),
            Summary: null,
            CoverImageUrl: null,
            CategoryId: 1,
            TagIds: [],
            ClientRevision: null,
            Status: null,
            ScheduledPublishAt: null);
        var results = new List<ValidationResult>();

        bool accepted = Validator.TryValidateObject(
            request,
            new ValidationContext(request),
            results,
            validateAllProperties: true);

        Assert.False(accepted);
        Assert.Contains(results, result => result.MemberNames.Contains(nameof(ServerDraftSaveRequest.Content), StringComparer.Ordinal));
    }

    [Fact]
    public void PublicNavigationSnapshot_RejectsOversizedPathBeforeRendererResolution()
    {
        var source = new DefaultHttpContext();

        bool accepted = PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            "/" + new string('x', 513),
            out _,
            out string error);

        Assert.False(accepted);
        Assert.Equal("public_navigation_snapshot_path_invalid", error);
    }

    [Fact]
    public async Task Subscription_RejectsOversizedEmailBeforeDatabaseAccess()
    {
        ISqlSugarClient database = Substitute.For<ISqlSugarClient>();
        var request = new SiteSubscriptionBinaryRequest(
            new string('a', 255),
            "email");

        SiteSubscriptionBinaryResponse? response = await SubscriptionEndpoints.SubscribeAsync(
            request,
            database,
            new ConfigurationBuilder().Build(),
            CancellationToken.None);

        Assert.Null(response);
        _ = database.DidNotReceive().Ado;
    }

    [Fact]
    public void LocalFixture_RejectsOversizedRedirectAndStorageState()
    {
        MethodInfo redirectSanitizer = Assert.IsAssignableFrom<MethodInfo>(
            typeof(LocalAuthFixtureEndpoints).GetMethod(
                "SanitizeRedirectPath",
                BindingFlags.NonPublic | BindingFlags.Static,
                binder: null,
                types: [typeof(string)],
                modifiers: null));
        string redirect = Assert.IsType<string>(redirectSanitizer.Invoke(
            null,
            ["/" + new string('x', 2048)]));
        Assert.Equal("/user/manage", redirect);

        string storageState = Path.Combine(Path.GetTempPath(), $"fsusblog-storage-state-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllBytes(storageState, new byte[256 * 1024 + 1]);
            MethodInfo cookieReader = Assert.IsAssignableFrom<MethodInfo>(
                typeof(LocalAuthFixtureEndpoints).GetMethod(
                    "TryReadCookie",
                    BindingFlags.NonPublic | BindingFlags.Static,
                    binder: null,
                    types: [typeof(string), typeof(string), typeof(string).MakeByRefType()],
                    modifiers: null));
            object?[] arguments = [storageState, "AccessToken", null];

            Assert.False(Assert.IsType<bool>(cookieReader.Invoke(null, arguments)));
            Assert.Equal(string.Empty, Assert.IsType<string>(arguments[2]));
        }
        finally
        {
            File.Delete(storageState);
        }
    }

    [Fact]
    public void LocalFixture_RedirectDropsActivationFlagsAndPreservesAllowedLocalParameters()
    {
        MethodInfo redirectSanitizer = Assert.IsAssignableFrom<MethodInfo>(
            typeof(LocalAuthFixtureEndpoints).GetMethod(
                "SanitizeRedirectPath",
                BindingFlags.NonPublic | BindingFlags.Static,
                binder: null,
                types: [typeof(string)],
                modifiers: null));

        string redirect = Assert.IsType<string>(redirectSanitizer.Invoke(
            null,
            ["/user/manage?fsusLocalFixtureLogin=1&viewport=mobile&fsusLocalFixtureAdmin=1#sessions"]));

        Assert.Equal("/user/manage?viewport=mobile#sessions", redirect);
    }

    [Fact]
    public void ContentFilter_OversizedTextFailsBeforeLargePerCallAllocation()
    {
        string root = CreateTempDirectory();
        try
        {
            using var service = new ContentFilterService(
                new TestWebHostEnvironment(root),
                NullLogger<ContentFilterService>.Instance);
            string oversized = new('x', 300_000);
            long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();

            ContentValidationResult result = service.ValidateContent(oversized);

            long allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            Assert.False(result.IsValid);
            Assert.Equal("content_too_large", result.ReasonCode);
            Assert.InRange(allocated, 0, 32 * 1024);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Search_OversizedKeywordReturnsBeforeScopeOrDatabaseResolution()
    {
        string root = CreateTempDirectory();
        try
        {
            var scopes = new RecordingScopeFactory();
            var service = new SearchIndexService(
                scopes,
                new TestWebHostEnvironment(root),
                new ConfigurationBuilder().Build(),
                Substitute.For<INotificationStreamPublisher>(),
                Substitute.For<IUnifiedCache>(),
                NullLogger<SearchIndexService>.Instance);
            string oversized = new('检', 129);
            long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();

            var results = await service.SearchAsync(oversized);

            stopwatch.Stop();
            long allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            Assert.Empty(results);
            Assert.Equal(0, scopes.CreateScopeCalls);
            Assert.True(stopwatch.Elapsed < TimeSpan.FromMilliseconds(250), $"elapsed={stopwatch.Elapsed}");
            Assert.InRange(allocated, 0, 256 * 1024);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void PasskeyAssertionParser_RejectsOversizedAndDeepJsonBeforeDomainServiceCall()
    {
        string oversized = new('x', SecurityAssertionPayloadParser.MaxAssertionJsonChars + 1);
        string deep = "{\"id\":\"credential\",\"challengeToken\":\"challenge\",\"extension\":" +
            string.Concat(Enumerable.Repeat("{\"nested\":", SecurityAssertionPayloadParser.MaxAssertionJsonDepth + 2)) +
            "0" +
            string.Concat(Enumerable.Repeat("}", SecurityAssertionPayloadParser.MaxAssertionJsonDepth + 2)) +
            "}";

        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        bool oversizedAccepted = SecurityAssertionPayloadParser.TryParse(oversized, out _);
        long oversizedAllocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        bool deepAccepted = SecurityAssertionPayloadParser.TryParse(deep, out _);

        Assert.False(oversizedAccepted);
        Assert.False(deepAccepted);
        Assert.InRange(oversizedAllocated, 0, 16 * 1024);
        Assert.True(SecurityAssertionPayloadParser.TryParse(
            "{\"id\":\"credential\",\"challengeToken\":\"challenge\"}",
            out var parsed));
        Assert.Equal("credential", parsed.Id);
        Assert.Equal("challenge", parsed.ChallengeToken);
    }

    private static string CreateTempDirectory()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-input-boundary-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    private sealed class RecordingScopeFactory : IServiceScopeFactory
    {
        internal int CreateScopeCalls
        {
            get; private set;
        }

        public IServiceScope CreateScope()
        {
            CreateScopeCalls++;
            throw new InvalidOperationException("database_scope_must_not_be_created");
        }
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(InputLimitBoundaryTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
