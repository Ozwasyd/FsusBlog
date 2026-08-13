using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

using FsusBlog.OpenApiObservation;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

return OpenApiObservationHost.Run(args);

internal static class OpenApiObservationHost
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static int Run(string[] args)
    {
        string? outputPath = null;
        string? contractsPath = null;
        string? repositoryRoot = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] is "--output" or "-o")
            {
                outputPath = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--output requires a path");
                i++;
            }
            else if (args[i] is "--contracts")
            {
                contractsPath = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--contracts requires a path");
                i++;
            }
            else if (args[i] is "--repository-root")
            {
                repositoryRoot = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--repository-root requires a path");
                i++;
            }
            else if (args[i] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.OpenApiObservation --output <path> [--contracts <aeds-endpoint-contracts.json>] [--repository-root <path>]");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"Unknown argument: {args[i]}");
            }
        }

        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidOperationException("--output is required");
        }

        repositoryRoot ??= LocateRepositoryRoot();
        contractsPath ??= Path.Combine(
            repositoryRoot,
            "src",
            "shared",
            "Contracts",
            "Validation",
            "aeds-endpoint-contracts.json");

        AedsEndpointContractCatalog contracts = AedsEndpointContractCatalog.Load(contractsPath);
        IReadOnlyList<ObservedOperation> observed = ObserveEndpoints();
        ObservationDocument document = ObservationMerger.Merge(observed, contracts);

        string json = JsonSerializer.Serialize(document, s_json);
        string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outputPath, json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        string openApiPath = Path.Combine(directory, "fsusblog.openapi.observed.json");
        string openApiJson = OpenApiProjectionWriter.Write(document);
        File.WriteAllText(openApiPath, openApiJson, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        Console.WriteLine(
            $"[openapi-observation] ok operations={document.Operations.Count} output={outputPath} openapi={openApiPath}");
        return 0;
    }

    private static IReadOnlyList<ObservedOperation> ObserveEndpoints()
    {
        WebApplication app = CreateApplication();
        try
        {
            List<ObservedOperation> operations = [];
            HashSet<string> seenKeys = new(StringComparer.Ordinal);
            HashSet<string> seenOperationIds = new(StringComparer.Ordinal);

            foreach (RouteEndpoint endpoint in ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>())
            {
                string rawPath = NormalizePath(endpoint.RoutePattern.RawText);
                if (!rawPath.StartsWith("/api/binary/", StringComparison.Ordinal)
                    && !string.Equals(rawPath, "/api/binary", StringComparison.Ordinal))
                {
                    continue;
                }

                IHttpMethodMetadata? methodMetadata = endpoint.Metadata.GetMetadata<IHttpMethodMetadata>();
                if (methodMetadata is null)
                {
                    continue;
                }

                foreach (string method in methodMetadata.HttpMethods
                    .Where(static value => value is "GET" or "POST" or "PUT" or "DELETE" or "PATCH")
                    .Select(static value => value.ToUpperInvariant())
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(static value => value, StringComparer.Ordinal))
                {
                    string key = ObservationMerger.MatchKey(method, rawPath);
                    if (!seenKeys.Add(key))
                    {
                        throw new InvalidOperationException($"duplicate method/path operation: {key}");
                    }

                    string operationId = OperationIdFor(method, rawPath);
                    if (!seenOperationIds.Add(operationId))
                    {
                        throw new InvalidOperationException($"duplicate operationId: {operationId} for {key}");
                    }

                    operations.Add(new ObservedOperation(
                        Method: method,
                        Path: rawPath,
                        OperationId: operationId,
                        Auth: ClassifyAuth(endpoint),
                        Permission: ClassifyPermission(endpoint),
                        Pow: HasFilter(endpoint, typeof(RequiresPowFilter)),
                        RateLimit: endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName ?? "none",
                        Cache: ClassifyCache(endpoint),
                        SourceIdentity: endpoint.DisplayName));
                }
            }

            // Public HotRead L0 binary artifact routes are implementation-registered synthetic endpoints.
            foreach (ObservedOperation publicArtifact in ObservePublicHotReadBinaryArtifacts())
            {
                string key = ObservationMerger.MatchKey(publicArtifact.Method, publicArtifact.Path);
                if (!seenKeys.Add(key))
                {
                    // Prefer canonical MapBinary registration when both surfaces exist.
                    continue;
                }

                if (!seenOperationIds.Add(publicArtifact.OperationId))
                {
                    throw new InvalidOperationException(
                        $"duplicate operationId from public hot-read artifact: {publicArtifact.OperationId}");
                }

                operations.Add(publicArtifact);
            }

            return operations
                .OrderBy(static item => item.Method, StringComparer.Ordinal)
                .ThenBy(static item => item.Path, StringComparer.Ordinal)
                .ToArray();
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    private static WebApplication CreateApplication()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
            ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_openapi_observation;Username=test;Password=test",
            ["Jwt:SecretKey"] = "openapi-observation-secret-key-at-least-32-bytes",
            ["Jwt:KeyVersion"] = "openapi-observation-v1",
            ["Jwt:Issuer"] = "FsusBlog.OpenApiObservation",
            ["Jwt:Audience"] = "FsusBlog.OpenApiObservation",
            ["CORS_ALLOWED_HOSTS"] = "http://127.0.0.1:3000",
            ["Security:IpHashKey"] = "openapi-observation-ip-hash-key",
            ["FSUSBLOG_OPENAPI_EXPORT"] = "1"
        });
        builder.Services
            .AddFsusApiFoundation(builder.Configuration)
            .AddFsusRuntimeServices(builder.Configuration)
            .AddFsusRateLimiting();
        builder.Services.RemoveAll<IHostedService>();

        WebApplication app = builder.Build();
        // Complete AEDS binary contract surface.
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapFontAdminEndpoints();
        app.MapThemeAdminEndpoints();
        app.MapSecurityEndpoints();
        return app;
    }

    private static string ClassifyAuth(RouteEndpoint endpoint)
    {
        if (endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null
            && endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count == 0
            && endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().Count == 0)
        {
            return "anonymous";
        }

        if (HasClaim(endpoint, "identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind))
        {
            return "admin";
        }

        if (HasClaim(endpoint, "identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind))
        {
            // auth/me and similar authenticated account surfaces historically labeled optional when
            // anonymous callers receive a structured unauthenticated payload, but endpoint policy is user.
            return RequiresAuthenticatedUser(endpoint) ? "user" : "optional";
        }

        if (RequiresAuthenticatedUser(endpoint) || endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0)
        {
            return "user";
        }

        if (endpoint.Metadata.GetMetadata<IAllowAnonymous>() is not null)
        {
            return "optional";
        }

        throw new InvalidOperationException(
            $"unable to classify auth for {endpoint.RoutePattern.RawText}");
    }

    private static string ClassifyPermission(RouteEndpoint endpoint)
    {
        string[] permissions = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(static requirement => string.Equals(
                requirement.ClaimType,
                AdminPermissions.PermissionClaimType,
                StringComparison.Ordinal))
            .SelectMany(static requirement => requirement.AllowedValues ?? Array.Empty<string>())
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

        return permissions.Length == 0 ? "none" : string.Join(',', permissions);
    }

    private static string ClassifyCache(RouteEndpoint endpoint)
    {
        if (endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>() is not null)
        {
            return "no-store";
        }

        if (endpoint.Metadata.GetMetadata<IOutputCachePolicy>() is not null
            || endpoint.Metadata.GetMetadata<OutputCacheAttribute>() is not null
            || endpoint.Metadata.Any(static item => item.GetType().Name.Contains("OutputCache", StringComparison.Ordinal)))
        {
            return "public-read";
        }

        return ClassifyAuth(endpoint) == "anonymous" ? "public-read" : "no-store";
    }

    private static bool HasFilter(RouteEndpoint endpoint, Type filterType)
        => endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
            .Any(metadata => metadata.FilterType == filterType);

    private static bool RequiresAuthenticatedUser(RouteEndpoint endpoint)
        => endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .Any(static requirement => requirement is DenyAnonymousAuthorizationRequirement);

    private static bool HasClaim(RouteEndpoint endpoint, string claimType, string expectedValue)
        => endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Any(requirement => string.Equals(requirement.ClaimType, claimType, StringComparison.Ordinal)
                && (requirement.AllowedValues?.Contains(expectedValue) ?? false));

    private static string NormalizePath(string? raw)
    {
        string value = (raw ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return "/";
        }

        return value.StartsWith('/') ? value : "/" + value;
    }

    private static string OperationIdFor(string method, string path)
    {
        string body = path
            .Replace("/api/binary/", string.Empty, StringComparison.Ordinal)
            .Replace("/api/binary", string.Empty, StringComparison.Ordinal);
        string slug = System.Text.RegularExpressions.Regex.Replace(
            body,
            @"[{}:.?=&/\-]+",
            "_");
        slug = slug.Trim('_');
        slug = System.Text.RegularExpressions.Regex.Replace(slug, @"_+", "_");
        return $"binary_{method.ToLowerInvariant()}_{slug}";
    }

    private static IEnumerable<ObservedOperation> ObservePublicHotReadBinaryArtifacts()
    {
        PublicHotReadRouteSecurityCatalog.ValidateOrThrow();
        foreach (PublicHotReadRoutePolicy policy in PublicHotReadRouteSecurityCatalog.All)
        {
            if (policy.MediaKind != PublicHotReadArtifactMediaKind.Binary)
            {
                continue;
            }

            string path = policy.Kind switch
            {
                PublicHotReadRouteKind.Category => "/api/binary/category.aeds",
                PublicHotReadRouteKind.Tag => "/api/binary/tag.aeds",
                PublicHotReadRouteKind.ArticleDetail => "/api/binary/article/{id}.aeds",
                PublicHotReadRouteKind.ArticleList => "/api/binary/article/list/home/{page}/{size}.aeds",
                PublicHotReadRouteKind.ArticleHot => "/api/binary/article/hot/{size}.aeds",
                PublicHotReadRouteKind.ArticleFeatured => "/api/binary/article/featured/{size}.aeds",
                _ => string.Empty
            };
            if (path.Length == 0)
            {
                continue;
            }

            yield return new ObservedOperation(
                Method: "GET",
                Path: path,
                OperationId: OperationIdFor("GET", path),
                Auth: "anonymous",
                Permission: "none",
                Pow: false,
                RateLimit: policy.RequiresRateLimit ? "public_read" : "none",
                Cache: "public-read",
                SourceIdentity: $"public-hot-read:{policy.PolicyId}");
        }
    }

    private static string LocateRepositoryRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(current.FullName, "src", "backend")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new InvalidOperationException("unable to locate repository root from tool base directory");
    }
}
