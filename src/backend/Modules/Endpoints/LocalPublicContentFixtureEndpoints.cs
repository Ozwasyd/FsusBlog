// fixture-catalog: producer public-content
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Development-only gateway into <see cref="IPublicContentFixtureSeeder"/> composition root (#1712).
/// Not a public/admin business API — loopback + secret gated like local auth fixtures.
/// </summary>
public static class LocalPublicContentFixtureEndpoints
{
    internal const string AllowLocalPublicContentFixtureConfigurationKey = "fsus:allowLocalPublicContentFixture";
    internal const string LocalPublicContentFixtureSecretConfigurationKey = "fsus:localPublicContentFixtureSecret";
    private const string LocalPublicContentFixtureSecretHeaderName = "X-Fsus-Local-Public-Content-Fixture-Secret";
    internal static readonly JsonSerializerOptions s_requestJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalPublicContentFixtureEndpoints(this WebApplication app)
    {
        bool allow = app.Configuration.GetValue<bool>(AllowLocalPublicContentFixtureConfigurationKey)
            || app.Configuration.GetValue<bool>(LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey);
        if (!app.Environment.IsDevelopment() || !allow)
        {
            return;
        }

        var prepareHandler = async Task<IResult> (
            HttpContext context,
            [FromServices] IPublicContentFixtureSeeder seeder,
            CancellationToken cancellationToken) =>
        {
            PublicContentFixtureRequest? body;
            try
            {
                body = await JsonSerializer.DeserializeAsync<PublicContentFixtureRequest>(
                    context.Request.Body,
                    s_requestJsonOptions,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (JsonException ex)
            {
                return Results.BadRequest(new
                {
                    message = "invalid public content fixture request",
                    detail = ex.Message
                });
            }

            if (body is null || body.Capabilities is null || body.Capabilities.Count == 0)
            {
                return Results.BadRequest(new
                {
                    message = "capabilities are required"
                });
            }

            try
            {
                PublicContentFixtureResult result = await seeder.PrepareAsync(
                    body with
                    {
                        Namespace = body.Namespace ?? context.Request.Headers["X-Fsus-Test-Namespace"].ToString(),
                        RunId = body.RunId ?? context.Request.Headers["X-Fsus-Test-Run-Id"].ToString()
                    },
                    cancellationToken).ConfigureAwait(false);
                return Results.Json(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return Results.Problem(
                    detail: ex.Message,
                    statusCode: StatusCodes.Status500InternalServerError,
                    title: "public-content fixture prepare failed");
            }
        };

        app.MapPost("/api/local/public-content-fixture/prepare", prepareHandler)
            .AllowAnonymous()
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);
        app.MapPost("/__local/public-content-fixture/prepare", prepareHandler)
            .AllowAnonymous()
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);
    }

    private static async ValueTask<object?> RequireLocalFixtureSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expectedSecret = configuration[LocalPublicContentFixtureSecretConfigurationKey]
            ?? configuration[LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey]
            ?? string.Empty;
        string providedSecret = context.HttpContext.Request.Headers[LocalPublicContentFixtureSecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(providedSecret))
        {
            providedSecret = context.HttpContext.Request.Headers["X-Fsus-Local-Auth-Fixture-Secret"].ToString();
        }

        if (string.IsNullOrWhiteSpace(expectedSecret)
            || string.IsNullOrWhiteSpace(providedSecret)
            || !FixedTimeEquals(expectedSecret.Trim(), providedSecret.Trim()))
        {
            return Results.Unauthorized();
        }

        return await next(context);
    }

    private static async ValueTask<object?> RequireLoopbackCaller(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IPAddress? remoteAddress = context.HttpContext.Connection.RemoteIpAddress;
        if (remoteAddress is null || !IPAddress.IsLoopback(remoteAddress))
        {
            return Results.NotFound();
        }

        return await next(context);
    }

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

}
