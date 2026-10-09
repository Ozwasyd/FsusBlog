using System.Security.Claims;
using System.Text.Encodings.Web;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Inactive endpoint refusal controls; no closed frame or production identity qualification.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageCandidateReadEndpointTests
{
    private const string Route = "/api/binary/author/article-packages/candidate-review";

    [Theory]
    [InlineData("anonymous", 401)]
    [InlineData("non-admin", 403)]
    [InlineData("invalid-id", 403)]
    [InlineData("missing-session", 403)]
    [InlineData("missing-permission", 403)]
    public async Task DeniedIdentity_ReturnsOriginalApiErrorBeforeBodyOrReader(string input, int status)
    {
        DefaultHttpContext context = Context();
        context.User = Principal(input);
        var reader = new NeverRead();
        IResult result = await AuthoringEndpoints.ReadArticlePackageCandidateReviewAsync(context, new AedsEncoder(),
            Service(context, reader), CancellationToken.None);
        await AssertErrorAsync(result, context, status);
        Assert.Equal(0, reader.Calls);
        Assert.Equal(0, ((UnreadBody)context.Request.Body).Reads);
    }

    [Fact]
    public async Task ClosedPairMissing_RefusesBeforeTypedBodyAndCanonicalReader()
    {
        DefaultHttpContext context = Context();
        var reader = new NeverRead();
        IResult result = await AuthoringEndpoints.ReadArticlePackageCandidateReviewAsync(context, new AedsEncoder(),
            Service(context, reader), CancellationToken.None);
        ErrorDetail error = await AssertErrorAsync(result, context, 400);
        Assert.Equal("authoring_binary_body_not_allowed", error.Message);
        Assert.Equal(0, reader.Calls);
        Assert.Equal(0, ((UnreadBody)context.Request.Body).Reads);
    }

    [Fact]
    public async Task OversizeFrame_RefusesBeforeBodyAndReader()
    {
        DefaultHttpContext context = Context();
        context.Request.ContentLength = 1024 * 1024 + 1;
        var reader = new NeverRead();
        IResult result = await AuthoringEndpoints.ReadArticlePackageCandidateReviewAsync(context, new AedsEncoder(),
            Service(context, reader), CancellationToken.None);
        ErrorDetail error = await AssertErrorAsync(result, context, 400);
        Assert.Equal("authoring_binary_body_too_large", error.Message);
        Assert.Equal(0, reader.Calls);
        Assert.Equal(0, ((UnreadBody)context.Request.Body).Reads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CallerOrRequestAbort_ProducesNoFrameBodyOrIdentityRead(bool requestAborted)
    {
        DefaultHttpContext context = Context();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        if (requestAborted)
        {
            context.RequestAborted = cancellation.Token;
        }
        var reader = new NeverRead();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            AuthoringEndpoints.ReadArticlePackageCandidateReviewAsync(context, new AedsEncoder(), Service(context, reader),
                requestAborted ? CancellationToken.None : cancellation.Token));
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(0, ((UnreadBody)context.Request.Body).Reads);
        Assert.Equal(0, reader.Calls);
    }

    [Fact]
    public async Task DisposableOriginalHost_StillRefusesUnregisteredPairWithRealAedsError()
    {
        var reader = new NeverRead();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration["SITE_BASEURL"] = "https://controlled.example";
        builder.Services.AddHttpContextAccessor();
        builder.Services.AddSingleton<ISystemSiteIdentityReader>(reader);
        builder.Services.AddScoped<ArticlePackageCandidateReviewReadService>();
        builder.Services.AddSingleton<IAedsEncoder, AedsEncoder>();
        builder.Services.AddAuthentication("controlled-package-unit")
            .AddScheme<AuthenticationSchemeOptions, ControlledAuthentication>("controlled-package-unit",
                options => options.ClaimsIssuer = "controlled-package-unit");
        builder.Services.AddAuthorization();
        await using WebApplication app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        // Explicit task-local mapping only; original production host hook remains absent.
        AuthoringEndpoints.MapArticlePackageCandidateReviewRoutes(app.MapGroup("/api/binary/author"));
        await app.StartAsync();
        using HttpClient client = app.GetTestClient();
        using var body = new ByteArrayContent(new byte[] { 1, 2, 3 });
        using HttpResponseMessage response = await client.PostAsync(Route, body);
        Assert.Equal(400, (int)response.StatusCode);
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        Assert.Equal("authoring_binary_body_not_allowed", PodBinaryCodec.ToErrorDetail(error).Message);
        Assert.Equal(0, reader.Calls);
        await app.StopAsync();
    }

    private static DefaultHttpContext Context()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = Route;
        context.Request.Body = new UnreadBody();
        context.Response.Body = new MemoryStream();
        context.User = Principal();
        return context;
    }

    private static ArticlePackageCandidateReviewReadService Service(DefaultHttpContext context, NeverRead reader)
        => new(reader, new HttpContextAccessor { HttpContext = context },
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = "https://controlled.example"
            }).Build());

    private static ClaimsPrincipal Principal(string input = "valid")
    {
        if (input == "anonymous")
        {
            return new();
        }
        var claims = new List<Claim>
        {
            new("identity_kind", input == "non-admin" ? "user" : AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", input == "invalid-id" ? "0" : "73")
        };
        if (input != "missing-session")
        {
            claims.Add(new("admin_sid", "controlled-session"));
        }
        if (input != "missing-permission")
        {
            claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
        }
        return new(new ClaimsIdentity(claims, "controlled-package-unit"));
    }

    private static async Task<ErrorDetail> AssertErrorAsync(IResult result, DefaultHttpContext context, int status)
    {
        await result.ExecuteAsync(context);
        Assert.Equal(status, context.Response.StatusCode);
        var decoded = new AedsEncoder().TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        return PodBinaryCodec.ToErrorDetail(error);
    }

    private sealed class NeverRead : ISystemSiteIdentityReader
    {
        public int Calls
        {
            get; private set;
        }
        public Task<SystemSiteIdentityReadModel> ReadCurrentSiteIdentityAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            throw new InvalidOperationException("Controlled refusal must not call canonical storage.");
        }
    }

    private sealed class UnreadBody : MemoryStream
    {
        public int Reads
        {
            get; private set;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Reads++;
            throw new InvalidOperationException("Controlled refusal must not read source bytes.");
        }
        public override int Read(byte[] buffer, int offset, int count)
        {
            Reads++;
            throw new InvalidOperationException("Controlled refusal must not read source bytes.");
        }
    }

    private sealed class ControlledAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
            => Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(Principal(), "controlled-package-unit")));
    }
}
