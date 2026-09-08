// fixture-catalog: producer comment-moderation
// fixture-catalog: gateway comment-moderation
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>Loopback-only gateway to the unique comment fixture producer.</summary>
public static class LocalCommentFixtureEndpoints
{
    internal const string AllowConfigurationKey = "fsus:allowLocalCommentFixture";
    internal const string SecretConfigurationKey = "fsus:localCommentFixtureSecret";
    public const string SecretHeaderName = "X-Fsus-Local-Comment-Fixture-Secret";
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalCommentFixtureEndpoints(this WebApplication app)
    {
        if (!IsEnabled(app.Configuration, app.Environment))
            return;

        app.MapPost("/api/local/comment-fixture/prepare", async (
                HttpContext context,
                [FromServices] ICommentFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                CommentFixturePlan? plan;
                try
                {
                    plan = await JsonSerializer.DeserializeAsync<CommentFixturePlan>(
                        context.Request.Body, s_json, cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid comment fixture plan",
                        detail = ex.Message
                    });
                }
                if (plan is null)
                    return Results.BadRequest(new
                    {
                        message = "comment fixture plan is required"
                    });
                RequireHeaderIdentity(context, plan.Namespace, plan.RunId, plan.TestSession);
                try
                {
                    return Results.Json(await seeder.PrepareAsync(plan, cancellationToken).ConfigureAwait(false));
                }
                catch (CommentFixturePreparationException ex)
                {
                    return Results.Json(new
                    {
                        schema = "fsusblog.comment-fixture-prepare-failure.v1",
                        status = ex.WasCanceled ? "canceled" : "failed",
                        message = ex.Message,
                        originalError = new
                        {
                            type = ex.InnerException?.GetType().Name ?? "Exception",
                            message = ex.InnerException?.Message ?? ex.Message
                        },
                        cleanupError = ex.CleanupError is null
                            ? null
                            : new
                            {
                                type = ex.CleanupError.GetType().Name,
                                message = ex.CleanupError.Message
                            },
                        recoveryReceipt = ex.RecoveryReceipt,
                        cleanupResult = ex.CleanupResult
                    }, statusCode: ex.WasCanceled ? 499 : StatusCodes.Status500InternalServerError);
                }
                catch (OperationCanceledException ex) when (cancellationToken.IsCancellationRequested)
                {
                    return Results.Json(new
                    {
                        schema = "fsusblog.comment-fixture-prepare-failure.v1",
                        status = "canceled",
                        message = ex.Message,
                        recoveryReceipt = (object?)null,
                        cleanupResult = (object?)null
                    }, statusCode: 499);
                }
                catch (Exception ex)
                {
                    return Results.Problem(
                        detail: ex.Message,
                        statusCode: StatusCodes.Status500InternalServerError,
                        title: "comment fixture prepare failed");
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                SecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName,
                HttpTestSessionKeyScope.HeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);

        app.MapPost("/api/local/comment-fixture/cleanup", async (
                HttpContext context,
                [FromServices] ICommentFixtureSeeder seeder,
                CancellationToken cancellationToken) =>
            {
                CommentThreadFixtureCleanupReceipt? receipt;
                try
                {
                    receipt = await JsonSerializer.DeserializeAsync<CommentThreadFixtureCleanupReceipt>(
                        context.Request.Body, s_json, cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid comment fixture cleanup receipt",
                        detail = ex.Message
                    });
                }
                if (receipt is null)
                    return Results.BadRequest(new
                    {
                        message = "comment fixture cleanup receipt is required"
                    });
                RequireHeaderIdentity(
                    context,
                    receipt.Binding.Namespace,
                    receipt.Binding.RunId,
                    receipt.Binding.TestSession);
                try
                {
                    return Results.Json(await seeder.CleanupAsync(receipt, cancellationToken).ConfigureAwait(false));
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
                        title: "comment fixture cleanup failed");
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                SecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName,
                HttpTestSessionKeyScope.HeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
    }

    private static void RequireHeaderIdentity(
        HttpContext context,
        string fixtureNamespace,
        string runId,
        string testSession)
    {
        string headerNamespace = context.Request.Headers[LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName].ToString();
        string headerRunId = context.Request.Headers[LocalPublicContentFixtureEndpoints.TestRunIdHeaderName].ToString();
        string headerTestSession = context.Request.Headers[HttpTestSessionKeyScope.HeaderName].ToString();
        if (!StringComparer.Ordinal.Equals(headerNamespace, fixtureNamespace)
            || !StringComparer.Ordinal.Equals(headerRunId, runId)
            || !HttpTestSessionKeyScope.IsValidSessionId(testSession)
            || !StringComparer.Ordinal.Equals(headerTestSession, testSession))
            throw new InvalidOperationException("Comment fixture header/plan identity mismatch.");
    }

    private static async ValueTask<object?> RequireSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expected = ResolveSecret(configuration);
        string provided = context.HttpContext.Request.Headers[SecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(expected) || string.IsNullOrWhiteSpace(provided)
            || !FixedTimeEquals(expected.Trim(), provided.Trim()))
            return Results.Unauthorized();
        return await next(context);
    }

    internal static bool IsEnabled(
        IConfiguration? configuration,
        IHostEnvironment? environment)
        => configuration is not null
            && environment?.IsDevelopment() == true
            && (configuration.GetValue<bool>(AllowConfigurationKey)
                || configuration.GetValue<bool>(LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey));

    internal static string ResolveSecret(IConfiguration configuration)
        => configuration[SecretConfigurationKey]
            ?? configuration[LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey]
            ?? string.Empty;

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
