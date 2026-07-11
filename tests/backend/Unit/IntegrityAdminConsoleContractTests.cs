using System.Net;
using System.Security.Claims;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using System.Threading.RateLimiting;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityAdminConsoleContractTests
{
    [Fact]
    public void AdminIntegrityConsoleEndpoints_ExposeMethodsPermissionAndFixedIpRateLimit()
    {
        IIntegrityAdminConsoleService service = Substitute.For<IIntegrityAdminConsoleService>();
        IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
        using TestServer server = CreateServer(service, adminPrincipals);
        EndpointDataSource source = server.Services.GetRequiredService<EndpointDataSource>();

        AssertEndpoint(source, "/api/admin/integrity/console", HttpMethods.Get);
        AssertEndpoint(source, "/api/admin/integrity/console/proofs/{proofId:long}/retry", HttpMethods.Post);
    }

    [Fact]
    public async Task TestServer_EnforcesPermissionAndStepUpBeforeRetryAndBindsConsoleQuery()
    {
        IntegrityAdminConsoleResponse console = ConsoleResponse();
        IIntegrityAdminConsoleService service = Substitute.For<IIntegrityAdminConsoleService>();
        service.GetConsoleAsync(Arg.Any<IntegrityAdminConsoleQuery>(), Arg.Any<CancellationToken>())
            .Returns(console);
        service.RetryProofAsync(91, Arg.Any<CancellationToken>())
            .Returns(new IntegrityAdminRetryResponse(91, "retrying", DateTimeOffset.UtcNow));
        IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
        adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                Arg.Any<long>(),
                Arg.Any<string>(),
                "admin-sensitive",
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        using TestServer server = CreateServer(service, adminPrincipals);
        using HttpClient client = server.CreateClient();

        using HttpResponseMessage forbidden = await client.GetAsync(
            "/api/admin/integrity/console?articleId=17&articleRevisionId=82&revisionNo=3");
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

        using var read = new HttpRequestMessage(
            HttpMethod.Get,
            "/api/admin/integrity/console?articleId=17&articleRevisionId=82&revisionNo=3");
        read.Headers.Add("X-Test-Permission", AdminPermissions.SystemConfig);
        using HttpResponseMessage readResponse = await client.SendAsync(read);
        Assert.Equal(HttpStatusCode.OK, readResponse.StatusCode);
        Assert.Contains("no-store", readResponse.Headers.CacheControl?.ToString() ?? string.Empty, StringComparison.Ordinal);
        await service.Received(1).GetConsoleAsync(
            Arg.Is<IntegrityAdminConsoleQuery>(query =>
                query.ArticleId == 17
                && query.ArticleRevisionId == 82
                && query.RevisionNo == 3),
            Arg.Any<CancellationToken>());

        using var missingProof = CreateRetryRequest(proof: null);
        using HttpResponseMessage missingProofResponse = await client.SendAsync(missingProof);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, missingProofResponse.StatusCode);
        await service.DidNotReceive().RetryProofAsync(Arg.Any<long>(), Arg.Any<CancellationToken>());

        using var retry = CreateRetryRequest("proof-91");
        using HttpResponseMessage retryResponse = await client.SendAsync(retry);
        Assert.Equal(HttpStatusCode.OK, retryResponse.StatusCode);
        await adminPrincipals.Received(1).ValidateAndConsumeAdminStepUpProofTokenAsync(
            39,
            "admin-session-39",
            "admin-sensitive",
            "proof-91",
            Arg.Any<CancellationToken>());
        await service.Received(1).RetryProofAsync(91, Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ConsoleSerialization_ExposesOperationalStatusesWithoutPrivateKeysOrInternalFailureDetails()
    {
        string json = JsonSerializer.Serialize(ConsoleResponse(), IntegrityVerificationJson.Options);

        Assert.Contains("\"active\"", json, StringComparison.Ordinal);
        Assert.Contains("\"old\"", json, StringComparison.Ordinal);
        Assert.Contains("\"revoked\"", json, StringComparison.Ordinal);
        Assert.Contains("\"compromised\"", json, StringComparison.Ordinal);
        Assert.Contains("\"chain-broken\"", json, StringComparison.Ordinal);
        foreach (string forbidden in new[]
        {
            "PrivateKey",
            "FailureDetail",
            "internal stack",
            "CreatedByAdminPrincipalId",
            "IpAddress",
            "SessionId",
            "DeviceFingerprint"
        })
        {
            Assert.DoesNotContain(forbidden, json, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static TestServer CreateServer(
        IIntegrityAdminConsoleService service,
        IAdminPrincipalService adminPrincipals)
    {
        var builder = new WebHostBuilder()
            .ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["CORS_ALLOWED_HOSTS"] = "https://console.example.test"
                }))
            .ConfigureServices(services =>
            {
                services.AddRouting();
                services.AddAuthorization();
                services.AddRateLimiter(options => options.AddFixedWindowLimiter("fixed_ip", limiter =>
                {
                    limiter.PermitLimit = 100;
                    limiter.QueueLimit = 0;
                    limiter.Window = TimeSpan.FromMinutes(1);
                    limiter.AutoReplenishment = true;
                }));
                services.AddSingleton(service);
                services.AddSingleton(adminPrincipals);
            })
            .Configure(app =>
            {
                app.UseRouting();
                app.Use(async (context, next) =>
                {
                    var claims = new List<Claim>
                    {
                        new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                        new("admin_id", "39"),
                        new("admin_sid", "admin-session-39")
                    };
                    if (context.Request.Headers["X-Test-Permission"] == AdminPermissions.SystemConfig)
                    {
                        claims.Add(new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.SystemConfig));
                    }

                    context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
                    await next();
                });
                app.UseAuthorization();
                app.UseRateLimiter();
                app.UseEndpoints(endpoints => endpoints.MapAdminIntegrityConsoleEndpoints());
            });
        return new TestServer(builder);
    }

    private static HttpRequestMessage CreateRetryRequest(string? proof)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/admin/integrity/console/proofs/91/retry");
        request.Headers.Add("Origin", "https://console.example.test");
        request.Headers.Add("X-Test-Permission", AdminPermissions.SystemConfig);
        if (proof is not null)
        {
            request.Headers.Add("X-Fsus-Mfa-Proof", proof);
        }

        return request;
    }

    private static IntegrityAdminConsoleResponse ConsoleResponse()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var proof = new IntegrityAdminProofRowResponse(
            ProofId: 91,
            ArticleId: 17,
            ArticleRevisionId: 82,
            RevisionNo: 3,
            ProofStatus: "failed",
            ArtifactStatus: "ready",
            SignatureStatus: "signature-invalid",
            TransparencyLogStatus: "chain-broken",
            CheckpointStatus: "missing",
            CanonicalHash: "public-canonical-hash",
            SigningKeyId: "key-current",
            FailureCode: "artifact-hash-mismatch",
            RetryAvailable: true,
            PublishedAtUtc: now.AddMinutes(-5),
            UpdatedAtUtc: now);
        return new IntegrityAdminConsoleResponse(
            CheckedAtUtc: now,
            Proofs: new IntegrityAdminProofSummaryResponse(1, 0, 0, 1, 0, 0, 0),
            TransparencyLog: new IntegrityAdminTransparencyLogStatusResponse(
                "chain-broken", 12, "head-hash", "prev_hash_mismatch", 11),
            Checkpoint: new IntegrityAdminCheckpointStatusResponse(
                "missing", null, null, null, null, null),
            KeyRegistry: new IntegrityAdminKeyRegistryResponse(
                "key-current",
                [
                    new IntegrityAdminKeyStatusResponse("key-current", 4, "ES256", "active", null, null),
                    new IntegrityAdminKeyStatusResponse("key-old", 3, "ES256", "old", null, null),
                    new IntegrityAdminKeyStatusResponse("key-revoked", 2, "ES256", "revoked", now.AddDays(-1).ToString("O"), null),
                    new IntegrityAdminKeyStatusResponse("key-compromised", 1, "ES256", "compromised", null, now.AddDays(-2).ToString("O"))
                ]),
            RecentProofs: [proof],
            FailedOrRetryingProofs: [proof]);
    }

    private static void AssertEndpoint(EndpointDataSource source, string path, string method)
    {
        RouteEndpoint endpoint = Assert.Single(source.Endpoints
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
        Assert.Equal(
            "fixed_ip",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
    }
}
