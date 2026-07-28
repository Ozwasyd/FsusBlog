// fixture-catalog: producer development-demo
using System.Text.Json;
using System.Net;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Development-only gateway into <see cref="IDemoFixtureSeeder"/> composition root (#1718).
/// Not a public/admin business API — loopback + secret gated like local auth fixtures.
/// </summary>
public static class LocalDemoFixtureEndpoints
{
    internal const string AllowLocalDemoFixtureConfigurationKey = "fsus:allowLocalDemoFixture";
    internal const string AllowLocalDemoFixtureCleanupConfigurationKey = "fsus:allowLocalDemoFixtureCleanup";
    internal const string LocalDemoFixtureSecretConfigurationKey = "fsus:localDemoFixtureSecret";
    internal const string LocalDemoFixtureSecretHeaderName = "X-Fsus-Local-Demo-Fixture-Secret";

    public static void MapLocalDemoFixtureEndpoints(this WebApplication app)
    {
        bool allowPrepare = app.Configuration.GetValue<bool>(AllowLocalDemoFixtureConfigurationKey);
        bool allowCleanup = app.Configuration.GetValue<bool>(AllowLocalDemoFixtureCleanupConfigurationKey);
        if (!app.Environment.IsDevelopment() || (!allowPrepare && !allowCleanup))
        {
            return;
        }

        if (allowPrepare)
        {
            var prepareHandler = async Task<IResult> (
                HttpContext context,
                [FromServices] IDemoFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                DemoFixtureHttpRequest? body;
                try
                {
                    body = await JsonSerializer.DeserializeAsync<DemoFixtureHttpRequest>(
                        context.Request.Body,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true },
                        cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid demo fixture request",
                        detail = ex.Message
                    });
                }

                try
                {
                    TestTemporalRuntimeContext? temporal =
                        context.RequestServices.GetService<TestTemporalRuntimeContext>();
                    if (body?.TemporalContext is JsonElement requestTemporalContext)
                    {
                        if (temporal is null)
                        {
                            throw new InvalidOperationException("backend temporal context is missing");
                        }
                        temporal.RequireExactRequest(requestTemporalContext);
                    }
                    else if (temporal is not null)
                    {
                        throw new InvalidOperationException("demo fixture temporal context is required");
                    }
                    DemoFixtureResult result = await seeder.PrepareAsync(
                        new DemoFixtureRequest(
                            body?.Namespace,
                            body?.RunId,
                            body?.TemporalContext),
                        cancellationToken).ConfigureAwait(false);

                    return Results.Json(result);
                }
                catch (InvalidOperationException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "demo fixture prepare failed",
                        detail = ex.Message
                    });
                }
            };

            app.MapPost("/api/local/demo-fixture/prepare", prepareHandler)
                .AllowAnonymous()
                .AddEndpointFilter(RequireLocalFixtureSecret)
                .AddEndpointFilter(RequireLoopbackCaller);
        }

        if (allowPrepare || allowCleanup)
        {
            app.MapPost("/api/local/demo-fixture/cleanup", async Task<IResult> (
                DemoFixtureCleanupRequest? body,
                [FromServices] IDemoFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                if (body?.EntityIdentities is null)
                    return Results.BadRequest(new
                    {
                        message = "receipt entity identities are required"
                    });
                try
                {
                    await seeder.CleanupAsync(body.EntityIdentities, cancellationToken).ConfigureAwait(false);
                    return Results.NoContent();
                }
                catch (InvalidOperationException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "demo fixture cleanup failed",
                        detail = ex.Message
                    });
                }
            })
                .AllowAnonymous()
                .AddEndpointFilter(RequireLocalFixtureSecret)
                .AddEndpointFilter(RequireLoopbackCaller);
        }
    }

    private sealed record DemoFixtureHttpRequest
    {
        public string? Namespace
        {
            get; init;
        }
        public string? RunId
        {
            get; init;
        }
        public JsonElement? TemporalContext
        {
            get; init;
        }
    }

    private sealed record DemoFixtureCleanupRequest
    {
        public List<DemoEntityIdentity>? EntityIdentities
        {
            get; init;
        }
    }

    private static async ValueTask<object?> RequireLocalFixtureSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expected = configuration[LocalDemoFixtureSecretConfigurationKey] ?? string.Empty;
        string actual = context.HttpContext.Request.Headers[LocalDemoFixtureSecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(expected) || string.IsNullOrWhiteSpace(actual))
        {
            return Results.Unauthorized();
        }

        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected.Trim());
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual.Trim());
        if (expectedBytes.Length != actualBytes.Length || !CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes))
        {
            return Results.Unauthorized();
        }

        return await next(context).ConfigureAwait(false);
    }

    private static async ValueTask<object?> RequireLoopbackCaller(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IPAddress? remoteAddress = context.HttpContext.Connection.RemoteIpAddress;
        if (remoteAddress is null || !IPAddress.IsLoopback(remoteAddress))
            return Results.NotFound();
        return await next(context).ConfigureAwait(false);
    }
}
