using System.Net;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringExtensions;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringExtensionApprovalTransportHostTests
{
    [Fact]
    public async Task MissingAuthenticatedHost_RefusesBeforeAnyPersistenceDependency()
    {
        var issuer = new AuthoringExtensionApprovalAuthority(new HttpContextAccessor(),
            new ConfigurationBuilder().Build(), null!, null!, null!, null!);
        var transport = new AuthoringExtensionApprovalTransport(issuer);
        var request = new AuthoringExtensionApprovalDecisionRequest(2, new string('a', 64));
        foreach (Func<Task> operation in new Func<Task>[]
        {
            () => transport.ReadAsync(request).AsTask(), () => transport.DenyAsync(request).AsTask(),
            () => transport.RevokeAsync(request).AsTask()
        })
        {
            var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(operation);
            Assert.Equal("approval_authenticated_admin_required", error.Message);
        }
    }

    [Theory]
    [InlineData("GET", "")]
    [InlineData("POST", "/confirm")]
    [InlineData("POST", "/deny")]
    [InlineData("POST", "/revoke")]
    [InlineData("POST", "/claim")]
    [InlineData("POST", "/complete")]
    public async Task CurrentAuthoringHost_DoesNotMountApprovalHttp(string method, string action)
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(new()
        {
            MapAuthoringEndpoints = true
        });
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method),
            "/api/binary/author/extension-approvals/" + new string('a', 64) + action);
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.All);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
