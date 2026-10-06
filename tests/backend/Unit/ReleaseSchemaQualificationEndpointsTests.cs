using System.Text.Json;

using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReleaseSchemaQualificationEndpointsTests
{
    [Theory]
    [InlineData(ReleaseSchemaQualificationEndpoints.BridgePath, "POST", StatusCodes.Status410Gone)]
    [InlineData(ReleaseSchemaQualificationEndpoints.ReadinessPath, "GET", StatusCodes.Status503ServiceUnavailable)]
    public async Task MappedRetiredRoutes_ExecuteWithoutOnlineOrDatabaseRegistrations(
        string path,
        string method,
        int expectedStatus)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Test"
        });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [ReleaseSchemaQualificationEndpoints.EnabledConfigurationKey] = "true"
        });
        await using WebApplication app = builder.Build();
        app.MapReleaseSchemaQualificationEndpoints();
        RouteEndpoint endpoint = Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>(), candidate => candidate.RoutePattern.RawText == path);
        await using AsyncServiceScope scope = app.Services.CreateAsyncScope();
        var context = new DefaultHttpContext
        {
            RequestServices = scope.ServiceProvider
        };
        context.Request.Method = method;
        context.Request.Path = path;
        context.Request.ContentType = "application/json";
        await using var requestBody = new MemoryStream("{\"operationId\":\"source-write\",\"sequence\":1}"u8.ToArray());
        context.Request.Body = requestBody;
        context.Request.ContentLength = requestBody.Length;
        await using var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await endpoint.RequestDelegate!(context);

        Assert.Equal(expectedStatus, context.Response.StatusCode);
        using JsonDocument body = JsonDocument.Parse(responseBody.ToArray());
        Assert.Equal(method == "POST" ? "schema_qualification_retired" : "schema_incompatible",
            body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public void BridgeWrite_RefusesWithoutDatabaseOrMigrationServices()
    {
        var context = new DefaultHttpContext();

        IResult result = ReleaseSchemaQualificationEndpoints.RejectBridgeWrite(context);

        Assert.Equal(StatusCodes.Status410Gone, Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode);
        JsonElement value = JsonSerializer.SerializeToElement(Assert.IsAssignableFrom<IValueHttpResult>(result).Value);
        Assert.Equal("schema_qualification_retired", value.GetProperty("code").GetString());
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
        Assert.True(context.Response.Headers.ContainsKey("X-Fsus-Release-Id"));
        Assert.True(context.Response.Headers.ContainsKey("X-Fsus-Release-Slot"));
    }

    [Fact]
    public void Readiness_RefusesWithoutCoordinatorOrCompatibilityReport()
    {
        var context = new DefaultHttpContext();

        IResult result = ReleaseSchemaQualificationEndpoints.RejectCompatibilityReadiness(context);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode);
        JsonElement value = JsonSerializer.SerializeToElement(Assert.IsAssignableFrom<IValueHttpResult>(result).Value);
        Assert.Equal("failed", value.GetProperty("status").GetString());
        Assert.Equal("schema_incompatible", value.GetProperty("code").GetString());
        Assert.Equal("schema_qualification_retired", value.GetProperty("reason").GetString());
        Assert.False(value.TryGetProperty("schemaCompatibilityCoordinate", out _));
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData("Test", true, true)]
    [InlineData("Test", false, false)]
    [InlineData("Development", true, false)]
    [InlineData("Production", true, false)]
    public void QualificationRoutes_AreTestOnlyAndRequireExplicitEnablement(
        string environment,
        bool configured,
        bool expected)
        => Assert.Equal(expected, ReleaseSchemaQualificationEndpoints.IsEnabled(environment, configured));

    [Theory]
    [InlineData("source-write", 1, true)]
    [InlineData("target.write_2", 1_000_000, true)]
    [InlineData("x", 1, false)]
    [InlineData("contains/slash", 1, false)]
    [InlineData("valid", 0, false)]
    [InlineData("valid", 1_000_001, false)]
    public void BridgeWrite_UsesBoundedDeterministicInput(string id, int sequence, bool expected)
    {
        bool actual = ReleaseSchemaQualificationEndpoints.TryNormalizeWrite(
            new ReleaseSchemaBridgeWriteRequest(id, sequence),
            out string normalized,
            out int normalizedSequence);

        Assert.Equal(expected, actual);
        Assert.Equal(id, normalized);
        Assert.Equal(sequence, normalizedSequence);
    }
}
