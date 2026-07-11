using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskControlContextFactoryTests
{
    [Fact]
    public void Create_AnonymousRequest_UsesNormalizedClientIpAndMissingDeviceState()
    {
        var context = CreateContext("198.51.100.17");
        context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
        context.Request.Headers["X-Real-IP"] = "127.0.0.1";
        context.SetEndpoint(CreateEndpoint(RiskActionNames.PublicRead, "article:42"));

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.Equal("198.51.100.17", result.ClientIp);
        Assert.Equal("Unknown", result.UserAgent);
        Assert.Equal(RiskControlContextStatuses.Missing, result.UserAgentStatus);
        Assert.Equal(RiskActionNames.PublicRead, result.ActionName);
        Assert.Equal("article:42", result.RouteKey);
        Assert.Equal(RiskControlContextStatuses.Resolved, result.ActionStatus);
        Assert.Equal(RiskControlActorStatuses.Anonymous, result.Actor.Status);
        Assert.Equal(RiskControlIdentityKinds.Anonymous, result.Actor.IdentityKind);
        Assert.Equal(RiskControlContextStatuses.Missing, result.DeviceFingerprint.Status);
        Assert.Null(result.DeviceFingerprint.Sha256Hash);
    }

    [Fact]
    public void Create_AuthenticatedUser_NormalizesActorRegionUserAgentAndDeviceFingerprint()
    {
        var context = CreateContext(
            "203.0.113.9",
            CreatePrincipal(
                42,
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AnonymousIdentityRuntime.AccountSubjectHashClaim, StableAccountSubjectHash)));
        context.Request.Headers.UserAgent = "  Mozilla/5.0  ";
        context.Request.Headers["X-Fsus-Device-Fp"] = "abcDEF-1234_5678";
        context.Request.Headers["X-Fsus-Region"] = " cn-mainland ";
        context.SetEndpoint(CreateEndpoint(RiskActionNames.AuthLogin, "auth.login"));

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskControlActorStatuses.Authenticated, result.Actor.Status);
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, result.Actor.IdentityKind);
        Assert.Equal("42", result.Actor.UserId);
        Assert.Equal(StableAccountSubjectHash, result.Actor.AccountSubjectHash);
        Assert.Null(result.Actor.AdminPrincipalId);
        Assert.Equal("Mozilla/5.0", result.UserAgent);
        Assert.Equal(RiskControlContextStatuses.Present, result.UserAgentStatus);
        Assert.Equal(RiskControlContextStatuses.Present, result.DeviceFingerprint.Status);
        Assert.Equal(16, result.DeviceFingerprint.Length);
        Assert.Equal(Sha256Hex("abcDEF-1234_5678"), result.DeviceFingerprint.Sha256Hash);
        Assert.Equal("CN-MAINLAND", result.Region.Region);
        Assert.Equal(RiskControlContextStatuses.Present, result.Region.Status);
        Assert.Equal("X-Fsus-Region", result.Region.Source);
    }

    [Fact]
    public void Create_AdminPrincipal_ExtractsIndependentAdminIdentity()
    {
        var context = CreateContext(
            "203.0.113.10",
            CreatePrincipal(
                7,
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "7"),
                new Claim("admin_sid", "sid-admin-1")));
        context.SetEndpoint(CreateEndpoint(RiskActionNames.AdminSecurityWrite, "admin.security.write"));

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskControlActorStatuses.AdminPrincipal, result.Actor.Status);
        Assert.Equal(AnonymousIdentityRuntime.AdminPrincipalKind, result.Actor.IdentityKind);
        Assert.Null(result.Actor.UserId);
        Assert.Null(result.Actor.SessionId);
        Assert.Equal("7", result.Actor.AdminPrincipalId);
        Assert.Equal("sid-admin-1", result.Actor.AdminSessionId);
        Assert.Equal(RiskActionNames.AdminSecurityWrite, result.ActionName);
        Assert.Equal("admin.security.write", result.RouteKey);
    }

    [Fact]
    public void Create_AdminPrincipalWithCollidingAccountId_DoesNotExposeUserId()
    {
        var adminContext = CreateContext(
            "203.0.113.10",
            CreatePrincipal(
                7,
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "7"),
                new Claim("admin_sid", "sid-admin-1")));
        var accountContext = CreateContext(
            "203.0.113.9",
            CreatePrincipal(
                7,
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)));

        RiskControlContext adminResult = new RiskControlContextFactory().Create(adminContext);
        RiskControlContext accountResult = new RiskControlContextFactory().Create(accountContext);

        Assert.Equal(RiskControlActorStatuses.AdminPrincipal, adminResult.Actor.Status);
        Assert.Null(adminResult.Actor.UserId);
        Assert.Equal("7", adminResult.Actor.AdminPrincipalId);
        Assert.Equal(RiskControlActorStatuses.Authenticated, accountResult.Actor.Status);
        Assert.Equal("7", accountResult.Actor.UserId);
        Assert.Null(accountResult.Actor.AccountSubjectHash);
        Assert.Null(accountResult.Actor.AdminPrincipalId);
    }

    [Fact]
    public void Create_AuthenticatedUser_SeparatesStableAccountSubjectHashFromUserId()
    {
        var firstContext = CreateContext(
            "203.0.113.9",
            CreatePrincipal(
                42,
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AnonymousIdentityRuntime.AccountSubjectHashClaim, StableAccountSubjectHash)));
        var secondContext = CreateContext(
            "203.0.113.9",
            CreatePrincipal(
                314,
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AnonymousIdentityRuntime.AccountSubjectHashClaim, StableAccountSubjectHash)));

        RiskControlContext first = new RiskControlContextFactory().Create(firstContext);
        RiskControlContext second = new RiskControlContextFactory().Create(secondContext);

        Assert.Equal("42", first.Actor.UserId);
        Assert.Equal("314", second.Actor.UserId);
        Assert.Equal(StableAccountSubjectHash, first.Actor.AccountSubjectHash);
        Assert.Equal(first.Actor.AccountSubjectHash, second.Actor.AccountSubjectHash);
    }

    [Fact]
    public void ProofBinding_AuthenticatedSubjectUsesAccountSubjectHashInsteadOfUserId()
    {
        var context = CreateContext(
            "203.0.113.9",
            CreatePrincipal(
                42,
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim("sid", "session-a"),
                new Claim(AnonymousIdentityRuntime.AccountSubjectHashClaim, StableAccountSubjectHash)));
        context.Request.Headers["X-Fsus-Device-Fp"] = "abcDEF-1234_5678";
        context.SetEndpoint(CreateEndpoint(RiskActionNames.AuthLogin, "auth.login"));

        RiskControlContext riskContext = new RiskControlContextFactory().Create(context);
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);

        string expected = Sha256Hex(string.Join(
            ':',
            "user",
            AnonymousIdentityRuntime.AnonymousAccountKind,
            StableAccountSubjectHash,
            "session-a"));
        string legacy = Sha256Hex(string.Join(
            ':',
            "user",
            AnonymousIdentityRuntime.AnonymousAccountKind,
            "42",
            "session-a"));
        Assert.Equal(expected, binding.SubjectHash);
        Assert.NotEqual(legacy, binding.SubjectHash);
    }

    [Fact]
    public void RiskControlContextFactory_SerializedAdminActorKeepsUserIdSlotEmpty()
    {
        var context = CreateContext(
            "203.0.113.10",
            CreatePrincipal(
                7,
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "7"),
                new Claim("admin_sid", "sid-admin-serialization")));

        RiskControlActorContext actor = new RiskControlContextFactory().Create(context).Actor;
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(actor));

        Assert.Equal(RiskControlActorStatuses.AdminPrincipal, actor.Status);
        Assert.Null(actor.UserId);
        Assert.Null(actor.AccountSubjectHash);
        Assert.Null(actor.SessionId);
        Assert.Equal("7", actor.AdminPrincipalId);
        Assert.Equal("sid-admin-serialization", actor.AdminSessionId);
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty(nameof(actor.UserId)).ValueKind);
        Assert.Equal("7", document.RootElement.GetProperty(nameof(actor.AdminPrincipalId)).GetString());
    }

    [Fact]
    public void Create_CrawlerMarks_ReadsHttpContextItems()
    {
        var context = CreateContext("66.249.64.1");
        context.Items["VerifiedCrawler"] = true;
        context.Items["SocialPreviewBot"] = true;
        context.SetEndpoint(CreateEndpoint(RiskActionNames.PublicRead, "article:preview"));

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.True(result.VerifiedCrawler);
        Assert.True(result.SocialPreviewBot);
    }

    [Fact]
    public void Create_DevelopmentLocalRequest_EnablesLocalBypass()
    {
        var context = CreateContext("127.0.0.1");

        RiskControlContext result = new RiskControlContextFactory(
            new TestWebHostEnvironment(Environments.Development),
            EmptyConfiguration()).Create(context);

        Assert.True(result.DevelopmentLocalBypass);
    }

    [Fact]
    public void Create_FixtureLocalRequest_EnablesLocalBypass()
    {
        var context = CreateContext("192.168.1.24");

        RiskControlContext result = new RiskControlContextFactory(
            new TestWebHostEnvironment(Environments.Production),
            ConfigurationWith("fsus:allowLocalAuthFixture", "true")).Create(context);

        Assert.True(result.DevelopmentLocalBypass);
    }

    [Fact]
    public void Create_ProductionLocalRequest_LeavesLocalBypassDisabled()
    {
        var context = CreateContext("127.0.0.1");

        RiskControlContext result = new RiskControlContextFactory(
            new TestWebHostEnvironment(Environments.Production),
            EmptyConfiguration()).Create(context);

        Assert.False(result.DevelopmentLocalBypass);
    }

    [Theory]
    [InlineData("short", "invalid_length")]
    [InlineData("valid-length but invalid spaces", "invalid_charset")]
    public void Create_InvalidDeviceFingerprint_RecordsInvalidStateWithoutRawValue(string rawFingerprint, string expectedReason)
    {
        var context = CreateContext("203.0.113.11");
        context.Request.Headers["X-Fsus-Device-Fp"] = rawFingerprint;
        context.SetEndpoint(CreateEndpoint(RiskActionNames.AuthLogin, "auth.login"));

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskControlContextStatuses.Invalid, result.DeviceFingerprint.Status);
        Assert.Equal(expectedReason, result.DeviceFingerprint.Reason);
        Assert.Equal(rawFingerprint.Length, result.DeviceFingerprint.Length);
        Assert.Null(result.DeviceFingerprint.Sha256Hash);
    }

    [Fact]
    public void Create_MissingAction_RecordsStateWithoutThrowing()
    {
        var context = CreateContext("203.0.113.12");
        context.SetEndpoint(new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("/api/binary/missing-action"), 0).Build());

        RiskControlContext result = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskControlContextStatuses.Missing, result.ActionStatus);
        Assert.Equal(string.Empty, result.ActionName);
        Assert.Equal(string.Empty, result.RouteKey);
    }

    private static DefaultHttpContext CreateContext(string remoteIp, ClaimsPrincipal? user = null)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(remoteIp);
        context.User = user ?? new ClaimsPrincipal(new ClaimsIdentity());
        return context;
    }

    private static ClaimsPrincipal CreatePrincipal(int id, params Claim[] additionalClaims)
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, id.ToString()),
            .. additionalClaims
        ];
        return new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
    }

    private static Endpoint CreateEndpoint(string actionName, string routeKey)
    {
        var builder = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse($"/{routeKey}"), 0);
        builder.Metadata.Add(RiskActionRegistry.Default.CreateMetadata(actionName, routeKey));
        return builder.Build();
    }

    private static string Sha256Hex(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static IConfiguration EmptyConfiguration()
        => new ConfigurationBuilder().Build();

    private static IConfiguration ConfigurationWith(string key, string value)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [key] = value
            })
            .Build();

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public string WebRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
}
