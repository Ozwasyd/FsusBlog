// fixture-catalog: producer account-messaging
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// Development-only gateway to the account-messaging fixture composition root.
/// The endpoint is loopback/secret gated and is never registered in production.
/// </summary>
public static class LocalMessagingFixtureEndpoints
{
    internal const string AllowConfigurationKey = "fsus:allowLocalMessagingFixture";
    internal const string SecretConfigurationKey = "fsus:localMessagingFixtureSecret";
    public const string SecretHeaderName = "X-Fsus-Local-Messaging-Fixture-Secret";
    internal static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalMessagingFixtureEndpoints(this WebApplication app)
    {
        bool allow = app.Configuration.GetValue<bool>(AllowConfigurationKey)
            || app.Configuration.GetValue<bool>(LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey);
        if (!app.Environment.IsDevelopment() || !allow)
        {
            return;
        }

        app.MapPost("/api/local/messaging-fixture/prepare", async (
                HttpContext context,
                [FromServices] IMessagingFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                MessagingFixturePlan? plan;
                try
                {
                    plan = await JsonSerializer.DeserializeAsync<MessagingFixturePlan>(
                        context.Request.Body,
                        s_json,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid messaging fixture plan",
                        detail = ex.Message
                    });
                }
                if (plan is null)
                {
                    return Results.BadRequest(new
                    {
                        message = "messaging fixture plan is required"
                    });
                }
                RequireHeaderIdentity(context, plan.Namespace, plan.RunId);
                try
                {
                    MessagingFixtureResult result = await seeder.PrepareAsync(plan, cancellationToken)
                        .ConfigureAwait(false);
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
                        title: "messaging fixture prepare failed");
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                SecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);

        app.MapPost("/api/local/messaging-fixture/cleanup", async (
                HttpContext context,
                [FromServices] IMessagingFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                MessagingFixtureCleanupReceipt? receipt;
                try
                {
                    receipt = await JsonSerializer.DeserializeAsync<MessagingFixtureCleanupReceipt>(
                        context.Request.Body,
                        s_json,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid messaging cleanup receipt",
                        detail = ex.Message
                    });
                }
                if (receipt is null)
                {
                    return Results.BadRequest(new
                    {
                        message = "messaging cleanup receipt is required"
                    });
                }
                RequireHeaderIdentity(context, receipt.Namespace, receipt.RunId);
                try
                {
                    await seeder.CleanupAsync(receipt, cancellationToken).ConfigureAwait(false);
                    return Results.Ok(new
                    {
                        status = "cleaned",
                        receipt.PlanDigest
                    });
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
                        title: "messaging fixture cleanup failed");
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                SecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
    }

    private static void RequireHeaderIdentity(HttpContext context, string fixtureNamespace, string runId)
    {
        string headerNamespace = context.Request.Headers[LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName].ToString();
        string headerRunId = context.Request.Headers[LocalPublicContentFixtureEndpoints.TestRunIdHeaderName].ToString();
        if (!string.Equals(headerNamespace, fixtureNamespace, StringComparison.Ordinal)
            || !string.Equals(headerRunId, runId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Messaging fixture header/plan identity mismatch.");
        }
    }

    private static async ValueTask<object?> RequireSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expected = configuration[SecretConfigurationKey]
            ?? configuration[LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey]
            ?? string.Empty;
        string provided = context.HttpContext.Request.Headers[SecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(expected)
            || string.IsNullOrWhiteSpace(provided)
            || !FixedTimeEquals(expected.Trim(), provided.Trim()))
        {
            return Results.Unauthorized();
        }
        return await next(context);
    }

    private static async ValueTask<object?> RequireLoopback(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IPAddress? remote = context.HttpContext.Connection.RemoteIpAddress;
        return remote is not null && IPAddress.IsLoopback(remote)
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
