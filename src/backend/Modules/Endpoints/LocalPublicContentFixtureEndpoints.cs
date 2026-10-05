// fixture-catalog: producer public-content
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Development-only gateway into <see cref="IPublicContentFixtureSeeder"/> composition root (#1712).
/// Not a public/admin business API — loopback + secret gated like local auth fixtures.
/// </summary>
public static class LocalPublicContentFixtureEndpoints
{
    internal const string AllowLocalPublicContentFixtureConfigurationKey = "fsus:allowLocalPublicContentFixture";
    internal const string LocalPublicContentFixtureSecretConfigurationKey = "fsus:localPublicContentFixtureSecret";
    public const string LocalPublicContentFixtureSecretHeaderName =
        "X-Fsus-Local-Public-Content-Fixture-Secret";
    public const string LocalTemporalFixtureSecretHeaderName =
        "X-Fsus-Local-Temporal-Fixture-Secret";
    public const string TestNamespaceHeaderName =
        "X-Fsus-Test-Namespace";
    public const string TestRunIdHeaderName =
        "X-Fsus-Test-Run-Id";
    internal static readonly JsonSerializerOptions s_requestJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalPublicContentFixtureEndpoints(this WebApplication app)
    {
        bool allow = app.Configuration.GetValue<bool>(AllowLocalPublicContentFixtureConfigurationKey)
            || app.Configuration.GetValue<bool>(LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey)
            || app.Configuration.GetValue<bool>(LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey);
        if (!app.Environment.IsDevelopment() || !allow)
        {
            return;
        }

        var prepareHandler = async Task<IResult> (
            HttpContext context,
            [FromServices] IPublicContentFixtureSeeder seeder,
            [FromServices] ISqlSugarClient db,
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
                TestTemporalRuntimeContext? temporal =
                    context.RequestServices.GetService<TestTemporalRuntimeContext>();
                if (body.TemporalContext is JsonElement requestTemporalContext)
                {
                    if (temporal is null)
                    {
                        throw new InvalidOperationException(
                            "backend temporal context is missing");
                    }
                    temporal.RequireExactRequest(requestTemporalContext);
                }
                PublicContentVerificationIdentity identity = body.VerificationIdentity
                    ?? throw new InvalidOperationException("public fixture verification identity is required");
                if (identity.Namespace != body.Namespace || identity.RunId != body.RunId)
                {
                    throw new InvalidOperationException("public fixture prepare identity mismatch");
                }
                seeder.ValidateVerificationIdentity(identity);
                PublicContentFixtureResult result = await seeder.PrepareAsync(
                    body with
                    {
                        Namespace = body.Namespace ?? context.Request.Headers[TestNamespaceHeaderName].ToString(),
                        RunId = body.RunId ?? context.Request.Headers[TestRunIdHeaderName].ToString()
                    },
                    cancellationToken).ConfigureAwait(false);
                result.VerificationProof = seeder.IssueVerificationProof(
                    identity, result);
                if (temporal is not null)
                {
                    System.Data.DataTable observation = await db.Ado.GetDataTableAsync(
                        """
                        SELECT
                            current_setting('TimeZone') AS timezone,
                            current_setting('fsusblog.test_business_epoch_utc', true) AS business_epoch
                        """).ConfigureAwait(false);
                    if (observation.Rows.Count != 1)
                    {
                        throw new InvalidOperationException(
                            "PostgreSQL temporal observation is missing");
                    }
                    string postgresTimezone = Convert.ToString(
                        observation.Rows[0]["timezone"],
                        System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
                    string postgresBusinessEpoch = Convert.ToString(
                        observation.Rows[0]["business_epoch"],
                        System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
                    result.TemporalObservation = temporal.Observe(
                        postgresTimezone,
                        postgresBusinessEpoch);
                }
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
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalPublicContentFixtureSecretHeaderName,
                TestNamespaceHeaderName,
                TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);
        app.MapPost("/__local/public-content-fixture/prepare", prepareHandler)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalPublicContentFixtureSecretHeaderName,
                TestNamespaceHeaderName,
                TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);

        app.MapPost("/api/local/public-content-fixture/verify", async Task<IResult> (
                HttpContext context,
                [FromBody] PublicContentVerificationRequest request,
                [FromServices] IPublicContentFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                if (request.Identity.RunId != context.Request.Headers[TestRunIdHeaderName].ToString()
                    || request.Identity.Namespace != context.Request.Headers[TestNamespaceHeaderName].ToString())
                {
                    return Results.BadRequest("public fixture verification header identity mismatch");
                }
                try
                {
                    return Results.Json(await seeder.VerifyAsync(request, cancellationToken).ConfigureAwait(false));
                }
                catch (InvalidOperationException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = ex.Message
                    });
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalPublicContentFixtureSecretHeaderName, TestNamespaceHeaderName, TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);

        // Observation only: the same fixture owner/gates, never a public locale
        // API or a second preparation/warming path.
        app.MapPost("/__local/public-content-fixture/published-artifact", async (
                HttpContext context,
                [FromServices] IPublicContentFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                try
                {
                    PublicContentPublishedArtifactRequest? request =
                        await JsonSerializer.DeserializeAsync<PublicContentPublishedArtifactRequest>(
                            context.Request.Body,
                            s_requestJsonOptions,
                            cancellationToken).ConfigureAwait(false);
                    if (request is null
                        || request.Namespace != context.Request.Headers[TestNamespaceHeaderName].ToString()
                        || request.RuntimeRunId != context.Request.Headers[TestRunIdHeaderName].ToString())
                    {
                        return Results.BadRequest(new
                        {
                            message = "published artifact observation owner headers are invalid"
                        });
                    }
                    JsonElement observation = await seeder.ObservePublishedArtifactAsync(
                        context,
                        request,
                        cancellationToken).ConfigureAwait(false);
                    context.Response.Headers.CacheControl = "private,no-store";
                    return Results.Json(observation);
                }
                catch (JsonException)
                {
                    return Results.BadRequest(new
                    {
                        message = "published artifact observation request is invalid"
                    });
                }
                catch (InvalidOperationException exception)
                {
                    return Results.Problem(
                        statusCode: StatusCodes.Status409Conflict,
                        title: "published artifact observation unavailable",
                        detail: exception.Message);
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalPublicContentFixtureSecretHeaderName,
                TestNamespaceHeaderName,
                TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);

        app.MapGet("/__local/temporal-observation", async (
                HttpContext context,
                [FromServices] ISqlSugarClient db) =>
            {
                TestTemporalRuntimeContext? temporal =
                    context.RequestServices.GetService<TestTemporalRuntimeContext>();
                if (temporal is null)
                {
                    return Results.NotFound();
                }
                System.Data.DataTable observation = await db.Ado.GetDataTableAsync(
                    """
                    SELECT
                        current_setting('TimeZone') AS timezone,
                        current_setting('fsusblog.test_business_epoch_utc', true) AS business_epoch
                    """).ConfigureAwait(false);
                if (observation.Rows.Count != 1)
                {
                    return Results.Problem("PostgreSQL temporal observation is missing");
                }
                return Results.Json(temporal.Observe(
                    Convert.ToString(
                        observation.Rows[0]["timezone"],
                        System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
                    Convert.ToString(
                        observation.Rows[0]["business_epoch"],
                        System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty));
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalTemporalFixtureSecretHeaderName))
            .AddEndpointFilter(RequireLocalTemporalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);
    }

    private static async ValueTask<object?> RequireLocalTemporalFixtureSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration =
            context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expectedSecret = configuration[LocalPublicContentFixtureSecretConfigurationKey]
            ?? configuration[LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey]
            ?? configuration[LocalDemoFixtureEndpoints.LocalDemoFixtureSecretConfigurationKey]
            ?? string.Empty;
        string providedSecret = context.HttpContext.Request
            .Headers[LocalTemporalFixtureSecretHeaderName]
            .ToString();
        if (string.IsNullOrWhiteSpace(expectedSecret)
            || string.IsNullOrWhiteSpace(providedSecret)
            || !FixedTimeEquals(expectedSecret.Trim(), providedSecret.Trim()))
        {
            return Results.Unauthorized();
        }

        return await next(context);
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
