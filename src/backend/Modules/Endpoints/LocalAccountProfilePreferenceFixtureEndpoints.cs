// fixture-catalog: producer account-profile-preferences
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Mvc;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Development-only transport for the account profile/preference fixture
/// composition root. It is not registered as a public or authenticated API.
/// </summary>
internal static class LocalAccountProfilePreferenceFixtureEndpoints
{
    internal const string AllowConfigurationKey = "fsus:allowAccountProfilePreferenceFixture";
    internal const string SecretConfigurationKey = "fsus:accountProfilePreferenceFixtureSecret";
    internal const string SecretHeaderName = "X-Fsus-Account-Profile-Preference-Fixture-Secret";
    private const string NamespaceHeaderName = "X-Fsus-Test-Namespace";
    private const string RunIdHeaderName = "X-Fsus-Test-Run-Id";
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    internal static void MapLocalAccountProfilePreferenceFixtureEndpoints(this WebApplication app)
    {
        bool allow = app.Configuration.GetValue<bool>(AllowConfigurationKey);
        if (!app.Environment.IsDevelopment() || !allow)
        {
            return;
        }

        app.MapPost(
                "/__local/account-profile-preferences/prepare",
                PrepareAsync)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                SecretHeaderName,
                NamespaceHeaderName,
                RunIdHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
        app.MapPost(
                "/__local/account-profile-preferences/verify",
                VerifyAsync)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(SecretHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
        app.MapPost(
                "/__local/account-profile-preferences/cleanup",
                CleanupAsync)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(SecretHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
    }

    private static async Task<IResult> PrepareAsync(
        HttpContext context,
        [FromServices] IAccountProfilePreferenceFixtureService fixture,
        [FromServices] ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        AccountProfilePreferenceFixtureRequest? request;
        try
        {
            request = await JsonSerializer.DeserializeAsync<AccountProfilePreferenceFixtureRequest>(
                context.Request.Body,
                s_jsonOptions,
                cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException exception)
        {
            return Results.BadRequest(new
            {
                message = "invalid account profile/preference fixture request",
                detail = exception.Message
            });
        }

        if (request is null)
        {
            return Results.BadRequest(new
            {
                message = "fixture request is required"
            });
        }

        try
        {
            string headerNamespace = context.Request.Headers[NamespaceHeaderName].ToString();
            string headerRunId = context.Request.Headers[RunIdHeaderName].ToString();
            if (!string.Equals(request.Namespace, headerNamespace, StringComparison.Ordinal)
                || !string.Equals(request.RunId, headerRunId, StringComparison.Ordinal))
            {
                return Results.BadRequest(new
                {
                    message = "fixture header identity mismatch"
                });
            }

            if (request.TemporalContext is JsonElement temporalDocument)
            {
                TestTemporalRuntimeContext plannedTemporal = context.RequestServices
                    .GetRequiredService<TestTemporalRuntimeContext>();
                plannedTemporal.RequireExactRequest(temporalDocument);
            }

            AccountProfilePreferenceFixtureResult result = await fixture
                .PrepareAsync(request, cancellationToken)
                .ConfigureAwait(false);
            TestTemporalRuntimeContext? actualTemporal = context.RequestServices
                .GetService<TestTemporalRuntimeContext>();
            if (actualTemporal is not null)
            {
                System.Data.DataTable observation = await db.Ado.GetDataTableAsync(
                    """
                    SELECT current_setting('TimeZone') AS timezone,
                           current_setting('fsusblog.test_business_epoch_utc', true) AS business_epoch
                    """).ConfigureAwait(false);
                if (observation.Rows.Count != 1)
                {
                    throw new InvalidOperationException("PostgreSQL temporal observation is missing");
                }
                result = result with
                {
                    TemporalObservation = actualTemporal.Observe(
                        Convert.ToString(
                            observation.Rows[0]["timezone"],
                            System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty,
                        Convert.ToString(
                            observation.Rows[0]["business_epoch"],
                            System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty)
                };
            }
            return Results.Json(result, s_jsonOptions);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return Results.Problem(
                title: "account profile/preference fixture prepare failed",
                detail: exception.Message,
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static async Task<IResult> VerifyAsync(
        HttpContext context,
        [FromServices] IAccountProfilePreferenceFixtureService fixture,
        CancellationToken cancellationToken)
    {
        AccountProfilePreferenceFixtureResult? result = await ReadResultAsync(
            context,
            cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            return Results.BadRequest(new
            {
                message = "fixture result is required"
            });
        }

        AccountProfilePreferenceFixtureVerification verification = await fixture
            .VerifyAsync(result, cancellationToken)
            .ConfigureAwait(false);
        return verification.Ok
            ? Results.Json(verification, s_jsonOptions)
            : Results.Problem(
                title: "account profile/preference fixture verification failed",
                detail: verification.Failure,
                statusCode: StatusCodes.Status409Conflict);
    }

    private static async Task<IResult> CleanupAsync(
        HttpContext context,
        [FromServices] IAccountProfilePreferenceFixtureService fixture,
        CancellationToken cancellationToken)
    {
        AccountProfilePreferenceFixtureResult? result = await ReadResultAsync(
            context,
            cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            return Results.BadRequest(new
            {
                message = "fixture result is required"
            });
        }

        try
        {
            await fixture.CleanupAsync(result, cancellationToken).ConfigureAwait(false);
            return Results.NoContent();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return Results.Problem(
                title: "account profile/preference fixture cleanup failed",
                detail: exception.Message,
                statusCode: StatusCodes.Status409Conflict);
        }
    }

    private static async Task<AccountProfilePreferenceFixtureResult?> ReadResultAsync(
        HttpContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            return await JsonSerializer.DeserializeAsync<AccountProfilePreferenceFixtureResult>(
                context.Request.Body,
                s_jsonOptions,
                cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async ValueTask<object?> RequireSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices
            .GetRequiredService<IConfiguration>();
        string expected = configuration[SecretConfigurationKey] ?? string.Empty;
        string actual = context.HttpContext.Request.Headers[SecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(expected)
            || string.IsNullOrWhiteSpace(actual)
            || !FixedTimeEquals(expected.Trim(), actual.Trim()))
        {
            return Results.Unauthorized();
        }

        return await next(context);
    }

    private static async ValueTask<object?> RequireLoopback(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IPAddress? remoteAddress = context.HttpContext.Connection.RemoteIpAddress;
        return remoteAddress is not null && IPAddress.IsLoopback(remoteAddress)
            ? await next(context)
            : Results.NotFound();
    }

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }
}
