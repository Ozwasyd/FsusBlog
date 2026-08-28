// fixture-catalog: producer audit-records
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

/// <summary>
/// Development-only, loopback-only composition root for production-semantic audit fixtures.
/// </summary>
public static class LocalAuditFixtureEndpoints
{
    public const string LocalAuditFixtureSecretHeaderName = "X-Fsus-Local-Audit-Fixture-Secret";
    private static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalAuditFixtureEndpoints(this WebApplication app)
    {
        bool allow = app.Configuration.GetValue<bool>(
            LocalPublicContentFixtureEndpoints.AllowLocalPublicContentFixtureConfigurationKey);
        if (!app.Environment.IsDevelopment() || !allow)
        {
            return;
        }

        app.MapPost("/__local/audit-fixture/prepare", PrepareAsync)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalAuditFixtureSecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);

        app.MapPost("/__local/audit-fixture/cleanup", CleanupAsync)
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalAuditFixtureSecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName))
            .AddEndpointFilter(RequireLocalFixtureSecret)
            .AddEndpointFilter(RequireLoopbackCaller);
    }

    private static async Task<IResult> PrepareAsync(
        HttpContext context,
        [FromServices] IAuditFixtureProducer producer,
        CancellationToken cancellationToken)
    {
        AuditFixtureRequest? request;
        try
        {
            request = await JsonSerializer.DeserializeAsync<AuditFixtureRequest>(
                context.Request.Body,
                s_jsonOptions,
                cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException ex)
        {
            return Results.BadRequest(new
            {
                message = "invalid audit fixture request",
                detail = ex.Message
            });
        }
        if (request is null)
        {
            return Results.BadRequest(new
            {
                message = "audit fixture request is required"
            });
        }

        try
        {
            string fixtureNamespace = string.IsNullOrWhiteSpace(request.Namespace)
                ? context.Request.Headers[LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName].ToString()
                : request.Namespace;
            string runId = string.IsNullOrWhiteSpace(request.RunId)
                ? context.Request.Headers[LocalPublicContentFixtureEndpoints.TestRunIdHeaderName].ToString()
                : request.RunId;
            TestTemporalRuntimeContext? temporal = context.RequestServices
                .GetService<TestTemporalRuntimeContext>();
            if (temporal is not null)
            {
                if (request.TemporalContext is not JsonElement temporalRequest)
                {
                    throw new InvalidOperationException("audit fixture temporal context is required");
                }
                temporal.RequireExactRequest(temporalRequest);
                if (request.BusinessEpochUtc != temporal.BusinessEpochUtc)
                {
                    throw new InvalidOperationException("audit fixture business epoch does not match temporal authority");
                }
            }
            AuditFixtureReceipt receipt = await producer.PrepareAsync(
                request with
                {
                    Namespace = fixtureNamespace,
                    RunId = runId
                },
                cancellationToken).ConfigureAwait(false);
            return Results.Json(receipt);
        }
        catch (InvalidOperationException ex)
        {
            return Results.BadRequest(new
            {
                message = "audit fixture prepare failed",
                detail = ex.Message
            });
        }
    }

    private static async Task<IResult> CleanupAsync(
        AuditFixtureCleanupRequest? request,
        [FromServices] IAuditFixtureProducer producer,
        CancellationToken cancellationToken)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.Namespace)
            || string.IsNullOrWhiteSpace(request.RunId))
        {
            return Results.BadRequest(new
            {
                message = "namespace and runId are required"
            });
        }
        await producer.CleanupAsync(request.Namespace, request.RunId, cancellationToken)
            .ConfigureAwait(false);
        return Results.NoContent();
    }

    private static async ValueTask<object?> RequireLocalFixtureSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices
            .GetRequiredService<IConfiguration>();
        string expected = configuration[
            LocalPublicContentFixtureEndpoints.LocalPublicContentFixtureSecretConfigurationKey]
            ?? string.Empty;
        string actual = context.HttpContext.Request.Headers[LocalAuditFixtureSecretHeaderName]
            .ToString();
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected.Trim());
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual.Trim());
        if (expectedBytes.Length == 0
            || expectedBytes.Length != actualBytes.Length
            || !CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes))
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
        {
            return Results.NotFound();
        }
        return await next(context).ConfigureAwait(false);
    }

    private sealed record AuditFixtureCleanupRequest(string Namespace, string RunId);
}
