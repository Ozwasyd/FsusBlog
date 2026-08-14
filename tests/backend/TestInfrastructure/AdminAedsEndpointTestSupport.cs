using System.Net.Http.Headers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class AdminAedsEndpointTestSupport
{
    internal static async Task<HttpResponseMessage> SendAdminGetAsync(
        EndpointSecurityTestServer server,
        string path)
    {
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.SystemConfig);
        return await client.SendAsync(request);
    }

    internal static async Task<AedsDecodeResult> DecodeAsync(HttpResponseMessage response)
    {
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(
            await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }
}
