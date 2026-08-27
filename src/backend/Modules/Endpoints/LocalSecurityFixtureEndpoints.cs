// fixture-catalog: producer security-state
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>Loopback-only transport for the Development/Test security fixture composition root.</summary>
public static class LocalSecurityFixtureEndpoints
{
    internal const string AllowLocalSecurityFixtureConfigurationKey = "fsus:allowLocalSecurityFixture";
    internal const string LocalSecurityFixtureSecretConfigurationKey = "fsus:localSecurityFixtureSecret";
    public const string LocalSecurityFixtureSecretHeaderName = "X-Fsus-Local-Security-Fixture-Secret";
    public const string TestProfileIdHeaderName = "X-Fsus-Test-Profile-Id";
    internal static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static void MapLocalSecurityFixtureEndpoints(this WebApplication app)
    {
        if ((!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test"))
            || !app.Configuration.GetValue<bool>(AllowLocalSecurityFixtureConfigurationKey))
        {
            return;
        }

        MapOperation(app, "apply", static (root, body, binding, cancellationToken) =>
            root.ApplyAsync(body, binding, cancellationToken));
        MapOperation(app, "observe", static (root, body, binding, cancellationToken) =>
            root.ObserveAsync(body, binding, cancellationToken));
        MapOperation(app, "cleanup", static (root, body, binding, cancellationToken) =>
            root.CleanupAsync(body, binding, cancellationToken));
        MapOperation(app, "observe-cleanup", static (root, body, binding, cancellationToken) =>
            root.ObserveCleanupAsync(body, binding, cancellationToken));
    }

    private static void MapOperation(
        WebApplication app,
        string action,
        Func<ISecurityFixtureCompositionRoot, JsonElement, SecurityFixtureRequestBinding, CancellationToken, Task<object>> invoke)
    {
        app.MapPost($"/__local/security-fixture/{action}", async (
                HttpContext context,
                ISecurityFixtureCompositionRoot root,
                CancellationToken cancellationToken) =>
            {
                JsonElement body;
                try
                {
                    body = await JsonSerializer.DeserializeAsync<JsonElement>(
                        context.Request.Body,
                        s_json,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    return Results.BadRequest(new
                    {
                        message = "invalid security fixture request",
                        detail = ex.Message
                    });
                }
                var binding = new SecurityFixtureRequestBinding(
                    context.Request.Headers[LocalPublicContentFixtureEndpoints.TestRunIdHeaderName].ToString(),
                    context.Request.Headers[LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName].ToString(),
                    context.Request.Headers[TestProfileIdHeaderName].ToString());
                if (string.IsNullOrWhiteSpace(binding.RunId)
                    || string.IsNullOrWhiteSpace(binding.Namespace)
                    || string.IsNullOrWhiteSpace(binding.ProfileId))
                {
                    return Results.BadRequest(new
                    {
                        message = "run, namespace, and profile bindings are required"
                    });
                }
                try
                {
                    return Results.Json(await invoke(root, body, binding, cancellationToken).ConfigureAwait(false));
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    return Results.Problem(
                        title: $"security fixture {action} failed",
                        detail: ex.Message,
                        statusCode: StatusCodes.Status500InternalServerError);
                }
            })
            .AllowAnonymous()
            .WithMetadata(new DevelopmentOnlyFsusHeaderMetadata(
                LocalSecurityFixtureSecretHeaderName,
                LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName,
                LocalPublicContentFixtureEndpoints.TestRunIdHeaderName,
                TestProfileIdHeaderName))
            .AddEndpointFilter(RequireSecret)
            .AddEndpointFilter(RequireLoopback);
    }

    private static async ValueTask<object?> RequireSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expected = configuration[LocalSecurityFixtureSecretConfigurationKey] ?? string.Empty;
        string actual = context.HttpContext.Request.Headers[LocalSecurityFixtureSecretHeaderName].ToString();
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
