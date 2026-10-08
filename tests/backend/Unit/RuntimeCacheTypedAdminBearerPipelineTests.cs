using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheTypedAdminBearerPipelineTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalAdminAccessToken_TraversesProductionPipelineAndProjection(bool bearer)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "slice-a-unit",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:Issuer"] = "slice-a-pipeline-unit",
            ["Jwt:Audience"] = "slice-a-pipeline-unit",
            ["Jwt:AccessTokenExpiresMinutes"] = "15",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(8, 8, 16384));
        var touch = Substitute.For<IAdminSessionTouchScheduler>();
        builder.Services.AddSingleton(projection);
        builder.Services.AddSingleton(touch);
        builder.Services.AddSingleton<IAdminSessionValidationService, AdminSessionValidationService>();
        builder.Services.AddSingleton(Substitute.For<IUserSessionValidationService>());
        builder.Services.AddSingleton<AuthCookieService>();
        builder.Services.AddJwtAuthentication(builder.Configuration);
        builder.Services.AddAuthorization();
        string? tokenType = null;
        string? failure = null;
        builder.Services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, options =>
        {
            Func<TokenValidatedContext, Task> production = options.Events.OnTokenValidated;
            options.Events.OnTokenValidated = async context =>
            {
                tokenType = context.SecurityToken.GetType().FullName;
                await production(context);
                failure = context.Result?.Failure?.Message;
            };
        });
        await using WebApplication app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/api/binary/admin/slice-a-unit", static () => "ok").RequireAuthorization();
        await app.StartAsync();

        var principal = new AdminPrincipal { Id = Random.Shared.NextInt64(1000, 1000000), Handle = $"fxauth-unit-{Guid.NewGuid():N}" };
        var session = new AdminSession
        {
            SessionId = Guid.NewGuid().ToString("N"),
            AdminPrincipalId = principal.Id,
            IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(8)
        };
        IssuedAccessToken token = app.Services.GetRequiredService<IJwtHelper>().GenerateAdminAccessToken(
            principal, session, [AdminPermissions.AdminManage]);
        byte[] tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(token.Token));
        var principalUpdate = new AdminSessionProjectionPrincipalUpdate(principal.Id,
            AdminSessionProjectionPrincipalStatus.Active, 1, 1);
        Assert.True(projection.Apply(new AdminSessionProjectionSessionUpdate(session.SessionId,
            principal.Id, tokenHash, null, new DateTimeOffset(session.IdleExpiresAtUtc),
            new DateTimeOffset(session.AbsoluteExpiresAtUtc), 1, 1, principalUpdate)).Accepted);
        Assert.True(projection.MarkReady(1));
        Assert.True(projection.Validate(session.SessionId, principal.Id, tokenHash).IsValid);

        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/admin/slice-a-unit");
        if (bearer)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        }
        else
        {
            // Cookie name is the existing production AuthCookieService name;
            // this is a pipeline unit control, not browser fixture allocation.
            request.Headers.Add("Cookie", $"AdminAccessToken={token.Token}");
        }
        using HttpResponseMessage response = await client.SendAsync(request);
        output.WriteLine($"unit-only production pipeline bearer={bearer}; tokenType={tokenType}; failure={failure ?? "none"}; status={(int)response.StatusCode}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(failure);
        touch.Received(1).TrySchedule(Arg.Any<AdminSessionTouchRequest>());
    }
}
