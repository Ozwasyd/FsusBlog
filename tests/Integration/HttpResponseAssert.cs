using System.Net;

namespace FsusBlog.V2.Integration.Tests;

internal static class HttpResponseAssert
{
    internal static HttpResponseMessage Ok(HttpResponseMessage response) =>
        Expect(HttpStatusCode.OK, response);

    internal static HttpResponseMessage Expect(HttpStatusCode status, HttpResponseMessage response)
    {
        try
        {
            Assert.Equal(status, response.StatusCode);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    internal static void CheckStatus(HttpStatusCode status, HttpResponseMessage response)
    {
        using (response) Assert.Equal(status, response.StatusCode);
    }
}
