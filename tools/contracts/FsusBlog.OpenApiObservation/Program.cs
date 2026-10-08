using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.OpenApiObservation;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.Governance;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

using AedsFrameHeader = FsusBlog.Shared.AedsFrameHeader;

try
{
    return OpenApiObservationHost.Run(args);
}
catch (Exception exception)
{
    Console.Error.WriteLine($"[openapi-observation] error: {exception.Message}");
    return 1;
}

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
        bool selfTest = false;
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
            else if (args[i] is "--self-test")
            {
                selfTest = true;
            }
            else if (args[i] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.OpenApiObservation --output <path> [--contracts <aeds-endpoint-contracts.json>] [--repository-root <path>] | --self-test [--repository-root <path>]");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"Unknown argument: {args[i]}");
            }
        }

        repositoryRoot ??= LocateRepositoryRoot();
        if (selfTest)
        {
            return OpenApiObservationSelfTest.Run(repositoryRoot);
        }
        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidOperationException("--output is required");
        }

        contractsPath ??= Path.Combine(
            repositoryRoot,
            "src",
            "shared",
            "Contracts",
            "Validation",
            "aeds-endpoint-contracts.json");

        AedsEndpointContractCatalog contracts = AedsEndpointContractCatalog.Load(contractsPath);
        IReadOnlyList<ObservedOperation> observed = ObserveEndpoints();
        if (string.Equals(
            Environment.GetEnvironmentVariable("FSUSBLOG_OPENAPI_DEBUG_REQUEST_TYPES"),
            "1",
            StringComparison.Ordinal))
        {
            foreach (ObservedOperation operation in observed.Where(static item => item.RequestTypes.Count > 0))
            {
                Console.Error.WriteLine(
                    $"[openapi-request-type] {operation.Method} {operation.Path}: "
                    + string.Join(',', operation.RequestTypes.Select(static item =>
                        $"{item.Type.FullName}[{item.Encoding}:{item.ReaderIdentity}]")));
            }
        }
        ProtocolStateCatalog protocolStates = LoadProtocolStates(repositoryRoot);
        ErrorAuthorityBinding errorAuthority = LoadErrorAuthority(repositoryRoot);
        ObservationDocument document = ObservationMerger.Merge(observed, contracts, protocolStates, errorAuthority);

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
            List<(string Key, CompiledEndpointContract Contract)> census = [];
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

                    CompiledEndpointContract compiledContract = CompiledEndpointContractObserver.Observe(
                        endpoint,
                        method,
                        rawPath);
                    census.Add((key, compiledContract));
                    if (!compiledContract.IsAeds)
                    {
                        continue;
                    }

                    string operationId = compiledContract.OperationId;
                    if (!seenOperationIds.Add(operationId))
                    {
                        throw new InvalidOperationException($"duplicate operationId: {operationId} for {key}");
                    }

                    IReadOnlyList<ObservedRequestType> requestTypes = CompiledRequestTypeObserver.Observe(endpoint);
                    IReadOnlyList<RequestParameterContract> requestParameters = CompiledRequestParameterObserver.Observe(endpoint);
                    IReadOnlyDictionary<int, IReadOnlyList<string>> errorStatuses = CompiledPublicStatusObserver.Observe(endpoint);
                    operations.Add(new ObservedOperation(
                        Method: method,
                        Path: rawPath,
                        OperationId: operationId,
                        Contract: compiledContract,
                        Auth: ClassifyAuth(endpoint),
                        Permission: ClassifyPermission(endpoint),
                        Pow: HasFilter(endpoint, typeof(RequiresPowFilter)),
                        RateLimit: endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName ?? "none",
                        Cache: ClassifyCache(endpoint),
                        SourceIdentity: endpoint.DisplayName,
                        RequestTypes: requestTypes,
                        RequestParameters: requestParameters,
                        CompiledErrorStatusEvidence: errorStatuses)
                    {
                        CredentialPolicy = ClassifyCredentialPolicy(endpoint, method)
                    });
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

                census.Add((key, publicArtifact.Contract));

                if (!seenOperationIds.Add(publicArtifact.OperationId))
                {
                    throw new InvalidOperationException(
                        $"duplicate operationId from public hot-read artifact: {publicArtifact.OperationId}");
                }

                operations.Add(publicArtifact);
            }

            CompiledEndpointContractCensus.Validate(census);

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

    private static ProtocolStateCatalog LoadProtocolStates(string repositoryRoot)
    {
        string protocolPath = Path.Combine(repositoryRoot, "src", "shared", "Contracts", "Validation", "aeds-protocol.json");
        JsonNode root = JsonNode.Parse(File.ReadAllText(protocolPath))
            ?? throw new InvalidOperationException("AEDS protocol document is empty");
        int version = root["header"]?["version"]?.GetValue<int>()
            ?? throw new InvalidOperationException("AEDS protocol version is missing");
        string[] frameNames = root["frameTypes"]?.AsArray()
            .Select(node => node?["name"]?.GetValue<string>() ?? throw new InvalidOperationException("active frame name missing"))
            .Where(name => !string.Equals(name, "Unknown", StringComparison.Ordinal))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray()
            ?? throw new InvalidOperationException("AEDS active frame catalog is missing");
        string[] active = frameNames
            .Where(name => !name.StartsWith("Reserved", StringComparison.Ordinal))
            .ToArray();
        string[] migrationOnly = frameNames
            .Where(name => name.StartsWith("Reserved", StringComparison.Ordinal))
            .ToArray();
        int[] retired = root["retiredFrameValues"]?.AsArray()
            .Select(node => node?["value"]?.GetValue<int>() ?? throw new InvalidOperationException("retired frame value missing"))
            .OrderBy(value => value)
            .ToArray()
            ?? [];
        if (active.Length == 0 || retired.Distinct().Count() != retired.Length)
        {
            throw new InvalidOperationException("AEDS active/retired protocol states are invalid");
        }
        return new ProtocolStateCatalog([version], active, retired, migrationOnly, true);
    }

    private static ErrorAuthorityBinding LoadErrorAuthority(string repositoryRoot)
    {
        string catalogPath = Path.Combine(repositoryRoot, "config", "contracts", "behavior-contracts.json");
        byte[] bytes = File.ReadAllBytes(catalogPath);
        JsonNode root = JsonNode.Parse(bytes)
            ?? throw new InvalidOperationException("BehaviorCatalog is empty");
        JsonNode? owner = root["contracts"]?.AsArray().SingleOrDefault(node =>
            string.Equals(node?["id"]?.GetValue<string>(), "configuration-error-security-policy", StringComparison.Ordinal));
        if (owner is null || !owner["documents"]!.AsArray().Any(node =>
            string.Equals(node?.GetValue<string>(), "docs/api/schemas-and-errors.md", StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("current error authority owner is missing or ambiguous");
        }
        return new ErrorAuthorityBinding(
            "configuration-error-security-policy",
            BehaviorContractCatalog.Digest,
            "docs/api/schemas-and-errors.md",
            ["facts.error-codes.domain.active", "facts.error-codes.transport-mapping"]);
    }

    internal static WebApplication CreateApplication()
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
        // Register the full production binary route surface so the census rejects
        // every non-AEDS implementation, including regressions in migrated routes.
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        app.MapFontAdminEndpoints();
        app.MapThemeAdminEndpoints();
        app.MapClusterMembershipEndpoints();
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

    internal static string ClassifyCredentialPolicy(RouteEndpoint endpoint, string method)
    {
        string auth = ClassifyAuth(endpoint);
        BinaryCredentialPolicyMetadata? explicitPolicy = endpoint.Metadata.GetMetadata<BinaryCredentialPolicyMetadata>();
        if (explicitPolicy is not null)
        {
            if (explicitPolicy.Policy == BinaryCredentialPolicy.Omit && auth != "anonymous")
            {
                throw new InvalidOperationException("authenticated binary endpoint cannot omit credentials");
            }
            return explicitPolicy.Policy switch
            {
                BinaryCredentialPolicy.Include => "include",
                BinaryCredentialPolicy.Omit => "omit",
                _ => throw new InvalidOperationException("binary endpoint credential policy is invalid")
            };
        }
        if (endpoint.Metadata.GetMetadata<StrongAnonymousRequestMetadata>() is not null)
        {
            if (auth != "anonymous") throw new InvalidOperationException("strong anonymous endpoint has conflicting authentication");
            return "omit";
        }
        return auth == "anonymous" && method == "GET" && ClassifyCache(endpoint) == "public-read"
            && endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName == "public_read"
            ? "omit" : "include";
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

            AedsFrameType responseFrame = policy.Kind switch
            {
                PublicHotReadRouteKind.Category => AedsFrameType.CategoryList,
                PublicHotReadRouteKind.Tag => AedsFrameType.TagList,
                PublicHotReadRouteKind.ArticleDetail => AedsFrameType.ArticleDetail,
                PublicHotReadRouteKind.ArticleList => AedsFrameType.ArticleList,
                PublicHotReadRouteKind.ArticleHot => AedsFrameType.ArticleHot,
                PublicHotReadRouteKind.ArticleFeatured => AedsFrameType.ArticleFeatured,
                _ => throw new InvalidOperationException($"unsupported binary public hot-read kind {policy.Kind}")
            };
            string operationId = CompiledEndpointContractObserver.OperationIdFor("GET", path);
            var compiledContract = new CompiledEndpointContract(
                operationId,
                null,
                responseFrame.ToString(),
                AedsFrameType.ApiError.ToString(),
                StatusCodes.Status200OK,
                "application/octet-stream",
                "aeds.frame.payload",
                [$"compiled-public-hot-read-policy:{policy.PolicyId}:{policy.Kind}"]);
            IReadOnlyDictionary<string, Type> parserTypes = policy.Kind switch
            {
                PublicHotReadRouteKind.ArticleDetail => new Dictionary<string, Type> { ["id"] = typeof(int) },
                PublicHotReadRouteKind.ArticleList => new Dictionary<string, Type> { ["page"] = typeof(ushort), ["size"] = typeof(byte) },
                PublicHotReadRouteKind.ArticleHot or PublicHotReadRouteKind.ArticleFeatured => new Dictionary<string, Type> { ["size"] = typeof(byte) },
                _ => new Dictionary<string, Type>()
            };
            yield return new ObservedOperation(
                Method: "GET",
                Path: path,
                OperationId: operationId,
                Contract: compiledContract,
                Auth: "anonymous",
                Permission: "none",
                Pow: false,
                RateLimit: policy.RequiresRateLimit ? "public_read" : "none",
                Cache: "public-read",
                SourceIdentity: $"public-hot-read:{policy.PolicyId}",
                RequestTypes: [],
                RequestParameters: CompiledRequestParameterObserver.ForPublicHotRead(path, parserTypes),
                CompiledErrorStatusEvidence: new SortedDictionary<int, IReadOnlyList<string>>
                {
                    [StatusCodes.Status406NotAcceptable] = ["compiled-middleware:ApiBinaryResponseMiddleware.accept"],
                    [StatusCodes.Status428PreconditionRequired] = ["compiled-public-hot-read:PublicHotReadSecurityGateMiddleware"],
                    [StatusCodes.Status429TooManyRequests] = ["compiled-public-hot-read:PublicHotReadSecurityGateMiddleware"],
                    [StatusCodes.Status500InternalServerError] = ["compiled-middleware:GlobalExceptionMiddleware"]
                }) { CredentialPolicy = "omit" };
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

internal static class CompiledRequestParameterObserver
{
    private static readonly NullabilityInfoContext s_nullability = new();
    private static readonly IReadOnlyDictionary<short, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .ToDictionary(static code => code.Value);

    public static IReadOnlyList<RequestParameterContract> Observe(RouteEndpoint endpoint)
    {
        var parameters = new Dictionary<string, RequestParameterContract>(StringComparer.Ordinal);
        MethodInfo? handler = endpoint.Metadata.GetMetadata<MethodInfo>();
        if (handler is null)
        {
            throw new InvalidOperationException(
                $"{endpoint.RoutePattern.RawText} lacks compiled handler metadata for request parameter observation");
        }

        HashSet<string> routeNames = endpoint.RoutePattern.Parameters
            .Select(static item => item.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (string routeName in routeNames.OrderBy(static item => item, StringComparer.Ordinal))
        {
            ParameterInfo routeParameter = handler.GetParameters().SingleOrDefault(parameter =>
                    string.Equals(RouteParameterName(parameter), routeName, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException(
                    $"{endpoint.RoutePattern.RawText} path parameter {routeName} lacks compiled handler parser evidence");
            bool nullable = IsNullable(routeParameter);
            Add(parameters, new RequestParameterContract(
                routeName,
                "request",
                "path",
                $"path://{ParameterSchema(routeParameter.ParameterType)}",
                true,
                nullable,
                ParameterBounds(routeParameter.ParameterType),
                [$"compiled-handler-path-parser:{MethodIdentity(handler)}:{routeParameter.Position}"]));
        }
        foreach (ParameterInfo parameter in handler.GetParameters())
        {
            string? source = ParameterSource(parameter, routeNames);
            if (source is null || source == "path")
            {
                continue;
            }

            string name = ParameterName(parameter, source);
            bool nullable = IsNullable(parameter);
            Add(parameters, new RequestParameterContract(
                name,
                "request",
                source,
                $"{source}://{ParameterSchema(parameter.ParameterType)}",
                !nullable && !parameter.HasDefaultValue,
                nullable,
                ParameterBounds(parameter.ParameterType),
                [$"compiled-handler-parameter:{handler.DeclaringType?.FullName}.{handler.Name}:{parameter.Position}"]));
        }

        ObserveManualRequestAccesses(handler, parameters, [], 0);
        ObservePipelineParameters(endpoint, parameters);

        return parameters.Values.OrderBy(static item => item.Source, StringComparer.Ordinal)
            .ThenBy(static item => item.Name, StringComparer.Ordinal).ToArray();
    }

    public static IReadOnlyList<RequestParameterContract> ForPublicHotRead(
        string route,
        IReadOnlyDictionary<string, Type> parserTypes)
        => System.Text.RegularExpressions.Regex
            .Matches(route, @"\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}")
            .Select(match =>
            {
                string name = match.Groups[1].Value;
                Type type = parserTypes.TryGetValue(name, out Type? value)
                    ? value
                    : throw new InvalidOperationException(
                        $"public hot-read route {route} parameter {name} lacks compiled parser evidence");
                return new RequestParameterContract(
                name,
                "request",
                "path",
                $"path://{ParameterSchema(type)}",
                true,
                false,
                ParameterBounds(type),
                [$"compiled-public-hot-read-parser:{type.FullName}"]);
            })
            .OrderBy(static item => item.Name, StringComparer.Ordinal)
            .ToArray();

    private static string RouteParameterName(ParameterInfo parameter)
        => parameter.GetCustomAttribute<FromRouteAttribute>()?.Name
            ?? parameter.Name
            ?? throw new InvalidOperationException("compiled route parameter name is missing");

    private static string? ParameterSource(ParameterInfo parameter, IReadOnlySet<string> routeNames)
    {
        if (routeNames.Contains(parameter.Name ?? string.Empty))
        {
            return "path";
        }
        if (parameter.GetCustomAttribute<FromHeaderAttribute>() is not null)
        {
            return "header";
        }
        if (parameter.GetCustomAttribute<FromQueryAttribute>() is not null)
        {
            return "query";
        }
        return IsSimpleParameter(parameter.ParameterType) ? "query" : null;
    }

    private static string ParameterName(ParameterInfo parameter, string source)
    {
        string? configured = source == "header"
            ? parameter.GetCustomAttribute<FromHeaderAttribute>()?.Name
            : parameter.GetCustomAttribute<FromQueryAttribute>()?.Name;
        return string.IsNullOrWhiteSpace(configured)
            ? parameter.Name ?? throw new InvalidOperationException("compiled request parameter name is missing")
            : configured;
    }

    private static bool IsSimpleParameter(Type type)
    {
        Type actual = Nullable.GetUnderlyingType(type) ?? type;
        return actual.IsPrimitive || actual.IsEnum || actual == typeof(string) || actual == typeof(decimal)
            || actual == typeof(Guid) || actual == typeof(DateTime) || actual == typeof(DateTimeOffset)
            || actual == typeof(DateOnly) || actual == typeof(TimeOnly) || actual == typeof(TimeSpan);
    }

    private static bool IsNullable(ParameterInfo parameter)
        => Nullable.GetUnderlyingType(parameter.ParameterType) is not null
            || (!parameter.ParameterType.IsValueType
                && s_nullability.Create(parameter).ReadState != NullabilityState.NotNull);

    private static string ParameterSchema(Type type)
    {
        Type actual = Nullable.GetUnderlyingType(type) ?? type;
        if (actual.IsEnum)
            return $"enum/{actual.FullName}";
        if (actual == typeof(string) || actual == typeof(char))
            return "string";
        if (actual == typeof(bool))
            return "boolean";
        if (actual == typeof(byte) || actual == typeof(sbyte))
            return "int8";
        if (actual == typeof(short) || actual == typeof(ushort))
            return "int16";
        if (actual == typeof(int) || actual == typeof(uint))
            return "int32";
        if (actual == typeof(long) || actual == typeof(ulong))
            return "int64";
        if (actual == typeof(float))
            return "float32";
        if (actual == typeof(double) || actual == typeof(decimal))
            return "number";
        if (actual == typeof(Guid))
            return "uuid";
        if (actual == typeof(DateTime) || actual == typeof(DateTimeOffset))
            return "date-time";
        if (actual == typeof(DateOnly))
            return "date";
        if (actual == typeof(TimeOnly) || actual == typeof(TimeSpan))
            return "time";
        throw new InvalidOperationException($"unsupported compiled request parameter type {actual.FullName}");
    }

    private static RequestBoundContract ParameterBounds(Type type)
    {
        Type actual = Nullable.GetUnderlyingType(type) ?? type;
        (string? minimum, string? maximum) = Type.GetTypeCode(actual) switch
        {
            TypeCode.Byte => ("0", byte.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.SByte => (sbyte.MinValue.ToString(System.Globalization.CultureInfo.InvariantCulture), sbyte.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.Int16 => (short.MinValue.ToString(System.Globalization.CultureInfo.InvariantCulture), short.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.UInt16 => ("0", ushort.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.Int32 => (int.MinValue.ToString(System.Globalization.CultureInfo.InvariantCulture), int.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.UInt32 => ("0", uint.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.Int64 => (long.MinValue.ToString(System.Globalization.CultureInfo.InvariantCulture), long.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            TypeCode.UInt64 => ("0", ulong.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            _ => (null, null)
        };
        return new RequestBoundContract(minimum, maximum, null, null, null, null, null, null);
    }

    private static string ParameterKey(RequestParameterContract parameter)
        => $"{parameter.Source}\0{parameter.Name}";

    private static void ObserveManualRequestAccesses(
        MethodBase method,
        IDictionary<string, RequestParameterContract> parameters,
        HashSet<MethodBase> visited,
        int depth)
    {
        if (depth > 6 || !visited.Add(method))
        {
            return;
        }
        if (method is MethodInfo methodInfo)
        {
            AsyncStateMachineAttribute? asyncStateMachine = methodInfo.GetCustomAttribute<AsyncStateMachineAttribute>();
            MethodInfo? moveNext = asyncStateMachine?.StateMachineType.GetMethod(
                nameof(IAsyncStateMachine.MoveNext),
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (moveNext is not null)
            {
                ObserveManualRequestAccesses(moveNext, parameters, visited, depth + 1);
            }
        }

        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return;
        }

        string? pendingSource = null;
        string? pendingName = null;
        int offset = 0;
        while (offset < il.Length)
        {
            int instructionOffset = offset;
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                return;
            }

            if (opCode == OpCodes.Ldstr)
            {
                pendingName = ResolveString(method, BitConverter.ToInt32(il, offset));
            }
            else if (opCode.OperandType == OperandType.InlineField)
            {
                pendingName = ResolveStringField(method, BitConverter.ToInt32(il, offset)) ?? pendingName;
            }
            if (opCode.OperandType == OperandType.InlineMethod)
            {
                MethodBase? called = ResolveMethod(method, BitConverter.ToInt32(il, offset));
                if (called is not null)
                {
                    string declaring = called.DeclaringType?.FullName ?? string.Empty;
                    if (called.Name == "get_Query" && called is MethodInfo { ReturnType: { } returnType }
                        && returnType.FullName?.Contains("IQueryCollection", StringComparison.Ordinal) == true)
                    {
                        pendingSource = "query";
                        pendingName = null;
                    }
                    else if (called.Name == "get_Headers"
                        && called.DeclaringType == typeof(HttpRequest)
                        && called is MethodInfo { ReturnType: { } headerType }
                        && headerType.FullName?.Contains("IHeaderDictionary", StringComparison.Ordinal) == true)
                    {
                        pendingSource = "header";
                        pendingName = null;
                    }
                    else if (pendingSource is not null && IsCollectionAccess(called, pendingSource))
                    {
                        pendingName ??= called.Name.StartsWith("get_", StringComparison.Ordinal)
                            && called.Name != "get_Item"
                            ? called.Name[4..]
                            : null;
                        if (string.IsNullOrWhiteSpace(pendingName))
                        {
                            throw new InvalidOperationException(
                                $"{MethodIdentity(method)} has unresolved compiled {pendingSource} request parameter at IL {instructionOffset}");
                        }
                        bool required = HasCompiledRequiredValueGuard(method, pendingName);
                        Add(parameters, new RequestParameterContract(
                            pendingName,
                            "request",
                            pendingSource,
                            $"{pendingSource}://string",
                            required,
                            !required,
                            ParameterBounds(typeof(string)),
                            [$"compiled-il:{MethodIdentity(method)}@{instructionOffset}"]));
                        pendingSource = null;
                        pendingName = null;
                    }
                    else if (IsHeaderReaderCall(called, pendingName))
                    {
                        Add(parameters, new RequestParameterContract(
                            pendingName!,
                            "request",
                            "header",
                            "header://string",
                            false,
                            true,
                            ParameterBounds(typeof(string)),
                            [$"compiled-call-argument:{MethodIdentity(method)}->{MethodIdentity(called)}@{instructionOffset}"]));
                        pendingSource = null;
                        pendingName = null;
                    }
                    else if (called.Name is "RequireAdminSensitiveStepUpAsync" or "TryReadMfaProof")
                    {
                        string headerName = ResolveConstantString(called.DeclaringType, "MfaProofHeader")
                            ?? throw new InvalidOperationException($"{MethodIdentity(called)} is missing MfaProofHeader authority");
                        Add(parameters, new RequestParameterContract(
                            headerName,
                            "request",
                            "header",
                            "header://string",
                            true,
                            false,
                            ParameterBounds(typeof(string)),
                            [$"compiled-sensitive-step-up:{MethodIdentity(called)}"]));
                        pendingSource = null;
                        pendingName = null;
                    }
                    else if (called.Name == "ReadSiteSubscriptionProofToken")
                    {
                        string headerName = FsusBlog.Server.Services.Subscriptions.SiteSubscriptionProofService.HeaderName;
                        Add(parameters, new RequestParameterContract(
                            headerName,
                            "request",
                            "header",
                            "header://string",
                            true,
                            false,
                            ParameterBounds(typeof(string)),
                            [$"compiled-request-helper:{MethodIdentity(called)}"]));
                        pendingSource = null;
                        pendingName = null;
                    }
                    else
                    {
                        if (ShouldRecurse(called))
                        {
                            ObserveManualRequestAccesses(called, parameters, visited, depth + 1);
                        }
                        if (called.Name is not "get_Request" and not "GetRequest")
                        {
                            pendingSource = null;
                            pendingName = null;
                        }
                    }
                }
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static bool IsCollectionAccess(MethodBase method, string source)
    {
        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        return source == "query"
            ? declaring.Contains("IQueryCollection", StringComparison.Ordinal)
            : declaring.Contains("IHeaderDictionary", StringComparison.Ordinal);
    }

    private static bool IsHeaderReaderCall(MethodBase method, string? pendingName)
        => !string.IsNullOrWhiteSpace(pendingName)
            && System.Text.RegularExpressions.Regex.IsMatch(
                pendingName,
                "^[A-Za-z0-9][A-Za-z0-9-]*$",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant)
            && method.Name.Contains("Header", StringComparison.Ordinal)
            && !method.Name.StartsWith("Write", StringComparison.Ordinal)
            && !method.Name.StartsWith("TryWrite", StringComparison.Ordinal);

    private static bool HasCompiledRequiredValueGuard(MethodBase owner, string parameterName)
    {
        byte[]? il = owner.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return false;
        }

        bool seesParameter = false;
        bool seesEquality = false;
        bool seesFailureResult = false;
        int offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                return false;
            }
            if (opCode == OpCodes.Ldstr)
            {
                seesParameter |= string.Equals(
                    ResolveString(owner, BitConverter.ToInt32(il, offset)),
                    parameterName,
                    StringComparison.Ordinal);
            }
            else if (opCode.OperandType == OperandType.InlineMethod
                && ResolveMethod(owner, BitConverter.ToInt32(il, offset)) is MethodBase called)
            {
                seesEquality |= called.DeclaringType == typeof(string)
                    && called.Name == nameof(string.Equals);
                seesFailureResult |= called.DeclaringType?.FullName
                        == "FsusBlog.Server.Infrastructure.Results.AedsJsonResults"
                    && called.Name is "BadRequest" or "PreconditionRequired";
            }
            offset += OperandSize(opCode, il, offset);
        }
        return seesParameter && seesEquality && seesFailureResult;
    }

    private static void ObservePipelineParameters(
        RouteEndpoint endpoint,
        IDictionary<string, RequestParameterContract> parameters)
    {
        Type[] filters = endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
            .Select(static metadata => metadata.FilterType)
            .Distinct()
            .ToArray();
        if (filters.Contains(typeof(RequiresPowFilter)))
        {
            AddFilterHeader(parameters, PowHeaderName(), required: true, typeof(RequiresPowFilter));
        }
        if (filters.Contains(typeof(RiskAwarePublicReadFilter)))
        {
            AddFilterHeader(parameters, PowHeaderName(), required: false, typeof(RiskAwarePublicReadFilter));
        }
        if (filters.Contains(typeof(RequiresRiskControlFilter)))
        {
            AddFilterHeader(parameters, RequiresRiskControlFilter.ChallengeProofHeaderName, required: false, typeof(RequiresRiskControlFilter));
            AddFilterHeader(parameters, RequiresRiskControlFilter.ChallengeIdHeaderName, required: false, typeof(RequiresRiskControlFilter));
            AddFilterHeader(parameters, RequiresRiskControlFilter.ChallengeKindHeaderName, required: false, typeof(RequiresRiskControlFilter));
        }
        if (filters.Contains(typeof(RejectIdentifiedPrincipalFilter)))
        {
            foreach (FieldInfo field in typeof(RejectIdentifiedPrincipalFilter).GetFields(
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.Name.EndsWith("HeaderName", StringComparison.Ordinal)
                    && ResolveFieldString(field) is string headerName)
                {
                    AddFilterHeader(parameters, headerName, required: false, typeof(RejectIdentifiedPrincipalFilter));
                }
            }
        }
    }

    private static string PowHeaderName()
    {
        Type codec = typeof(RequiresPowFilter).Assembly.GetType(
            "FsusBlog.Server.Infrastructure.Security.PowProofCodec",
            throwOnError: true)!;
        return ResolveConstantString(codec, "HeaderName")
            ?? throw new InvalidOperationException("compiled PowProofCodec is missing HeaderName authority");
    }

    private static void AddFilterHeader(
        IDictionary<string, RequestParameterContract> parameters,
        string name,
        bool required,
        Type filterType)
        => Add(parameters, new RequestParameterContract(
            name,
            "request",
            "header",
            "header://string",
            required,
            !required,
            ParameterBounds(typeof(string)),
            [$"compiled-endpoint-filter:{filterType.FullName}"]));

    private static bool ShouldRecurse(MethodBase method)
        => method.DeclaringType?.Assembly == typeof(AuthoringEndpoints).Assembly
            && (method.DeclaringType.Namespace?.StartsWith("FsusBlog.Server.Modules.Endpoints", StringComparison.Ordinal) ?? false);

    private static MethodBase? ResolveMethod(MethodBase owner, int token)
    {
        try
        {
            Type[]? declaringArguments = owner.DeclaringType?.IsGenericType == true
                ? owner.DeclaringType.GetGenericArguments()
                : null;
            Type[]? methodArguments = owner.IsGenericMethod ? owner.GetGenericArguments() : null;
            return owner.Module.ResolveMethod(token, declaringArguments, methodArguments);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string? ResolveString(MethodBase owner, int token)
    {
        try
        {
            return owner.Module.ResolveString(token);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string? ResolveStringField(MethodBase owner, int token)
    {
        try
        {
            Type[]? declaringArguments = owner.DeclaringType?.IsGenericType == true
                ? owner.DeclaringType.GetGenericArguments()
                : null;
            Type[]? methodArguments = owner.IsGenericMethod ? owner.GetGenericArguments() : null;
            FieldInfo? field = owner.Module.ResolveField(token, declaringArguments, methodArguments);
            return field is null ? null : ResolveFieldString(field);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string? ResolveConstantString(Type? type, string fieldName)
    {
        FieldInfo? field = type?.GetField(
            fieldName,
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.FlattenHierarchy);
        return field is null ? null : ResolveFieldString(field);
    }

    private static string? ResolveFieldString(FieldInfo field)
    {
        try
        {
            return field.IsLiteral
                ? field.GetRawConstantValue() as string
                : field.IsStatic ? field.GetValue(null) as string : null;
        }
        catch (TargetInvocationException)
        {
            return null;
        }
    }

    private static string MethodIdentity(MethodBase method)
        => $"{method.DeclaringType?.FullName}.{method.Name}";

    private static int OperandSize(OpCode opCode, byte[] il, int operandOffset)
        => opCode.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => throw new InvalidOperationException($"unsupported IL operand type {opCode.OperandType}")
        };

    private static void Add(
        IDictionary<string, RequestParameterContract> parameters,
        RequestParameterContract candidate)
    {
        string key = ParameterKey(candidate);
        if (parameters.TryGetValue(key, out RequestParameterContract? existing))
        {
            if (existing.Name != candidate.Name
                || existing.Direction != candidate.Direction
                || existing.Source != candidate.Source
                || existing.SchemaRef != candidate.SchemaRef
                || existing.Required != candidate.Required
                || existing.Nullable != candidate.Nullable
                || existing.Bounds != candidate.Bounds)
            {
                throw new InvalidOperationException($"conflicting compiled request parameter {candidate.Source}:{candidate.Name}");
            }
            parameters[key] = existing with
            {
                Evidence = existing.Evidence.Concat(candidate.Evidence)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(static item => item, StringComparer.Ordinal)
                    .ToArray()
            };
            return;
        }
        parameters[key] = candidate;
    }
}

internal static class CompiledRequestTypeObserver
{
    private static readonly IReadOnlyDictionary<short, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .ToDictionary(static code => code.Value);

    public static IReadOnlyList<ObservedRequestType> Observe(RouteEndpoint endpoint)
    {
        MethodInfo? handler = endpoint.Metadata.GetMetadata<MethodInfo>();
        if (handler is null)
        {
            return [];
        }

        Dictionary<Type, ObservedRequestType> requestTypes = [];
        HashSet<MethodBase> visited = [];
        ObserveMethod(handler, requestTypes, visited, 0);
        return requestTypes.Values
            .Where(static item => item.Type.FullName != "FsusBlog.Server.Infrastructure.Binary.BinaryRequestPayload")
            .OrderBy(static item => item.Type.FullName, StringComparer.Ordinal)
            .ToArray();
    }

    private static void ObserveMethod(
        MethodBase method,
        Dictionary<Type, ObservedRequestType> requestTypes,
        HashSet<MethodBase> visited,
        int depth)
    {
        if (depth > 6 || !visited.Add(method))
        {
            return;
        }

        if (method is MethodInfo methodInfo)
        {
            AsyncStateMachineAttribute? asyncStateMachine = methodInfo.GetCustomAttribute<AsyncStateMachineAttribute>();
            MethodInfo? moveNext = asyncStateMachine?.StateMachineType.GetMethod(
                nameof(IAsyncStateMachine.MoveNext),
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (moveNext is not null)
            {
                ObserveMethod(moveNext, requestTypes, visited, depth + 1);
            }
        }

        MethodBody? body = method.GetMethodBody();
        byte[]? il = body?.GetILAsByteArray();
        if (il is null)
        {
            return;
        }

        int offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                return;
            }

            if (opCode.OperandType == OperandType.InlineMethod)
            {
                int token = BitConverter.ToInt32(il, offset);
                MethodBase? called = ResolveMethod(method, token);
                if (called is not null)
                {
                    ObserveCall(method, called, requestTypes);
                    if (ShouldRecurse(called))
                    {
                        ObserveMethod(called, requestTypes, visited, depth + 1);
                    }
                }
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static void ObserveCall(
        MethodBase owner,
        MethodBase called,
        Dictionary<Type, ObservedRequestType> requestTypes)
    {
        if (called is not MethodInfo method)
        {
            return;
        }

        if (method.GetParameters().Any(static parameter => parameter.ParameterType == typeof(Stream))
            && CalledMethods(owner).Any(static candidate =>
                candidate.DeclaringType?.FullName == "FsusBlog.Server.Infrastructure.Binary.IBinaryEndpointRequestContext"
                && candidate.Name == "ReadFrameAsync"))
        {
            int frameLimit = IntegerConstants(owner).Where(static value => value > AedsFrameHeader.Size).DefaultIfEmpty().Max();
            if (frameLimit <= AedsFrameHeader.Size)
            {
                throw new InvalidOperationException(
                    $"{MethodIdentity(owner)} binary stream consumer lacks compiled frame limit");
            }
            requestTypes[typeof(Stream)] = new ObservedRequestType(
                typeof(Stream),
                "binary-package",
                "FsusBlog.Server.Infrastructure.Binary.IBinaryEndpointRequestContext.ReadFrameAsync",
                MethodSignature(method),
                MinimumBytes: 1,
                MaximumBytes: frameLimit - AedsFrameHeader.Size);
            return;
        }

        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        bool isJsonReader = declaring is "FsusBlog.Server.Infrastructure.Results.AedsJsonResults"
                or "FsusBlog.Server.Modules.Endpoints.AuthoringEndpoints"
                or "FsusBlog.Server.Modules.Endpoints.SecurityEndpoints"
                or "FsusBlog.Server.Modules.Endpoints.Binary.BinaryEndpoints"
            && method.Name is "ReadAsync" or "ReadRequestAsync" or "TryReadGovernanceJson"
                or "ReadCommentManagementRequestAsync";
        bool isBinaryReader = method.DeclaringType == typeof(PodBinaryCodec)
            && method.Name.StartsWith("TryDecode", StringComparison.Ordinal);
        if (!isJsonReader && !isBinaryReader)
        {
            return;
        }

        string encoding = isJsonReader ? "utf8-json" : "binary-layout";
        string readerIdentity = $"{method.DeclaringType?.FullName}.{method.Name}";
        if (method.IsGenericMethod)
        {
            foreach (Type argument in method.GetGenericArguments())
            {
                AddCandidate(argument, encoding, readerIdentity, requestTypes);
            }
        }

        if (isBinaryReader)
        {
            foreach (ParameterInfo parameter in method.GetParameters().Where(static item => item.ParameterType.IsByRef))
            {
                AddCandidate(
                    parameter.ParameterType.GetElementType(),
                    encoding,
                    readerIdentity,
                    requestTypes,
                    force: true);
            }
        }

    }

    private static void AddCandidate(
        Type? type,
        string encoding,
        string readerIdentity,
        Dictionary<Type, ObservedRequestType> requestTypes,
        bool force = false)
    {
        Type? candidate = Unwrap(type);
        if (candidate is null || candidate == typeof(void)
            || candidate == typeof(bool) || candidate == typeof(byte[])
            || candidate == typeof(ReadOnlyMemory<byte>) || candidate == typeof(Memory<byte>))
        {
            return;
        }

        if (force || candidate == typeof(string) || encoding == "utf8-json")
        {
            if (!requestTypes.TryGetValue(candidate, out ObservedRequestType? existing)
                || (existing.Encoding == "binary-layout" && encoding == "utf8-json"))
            {
                requestTypes[candidate] = new ObservedRequestType(candidate, encoding, readerIdentity);
            }
        }
    }

    private static Type? Unwrap(Type? type)
    {
        Type? current = type;
        while (current is not null && current.IsGenericType)
        {
            Type definition = current.GetGenericTypeDefinition();
            if (definition == typeof(Task<>) || definition == typeof(ValueTask<>)
                || definition.Name == "AedsJsonRequest`1")
            {
                current = current.GetGenericArguments()[0];
                continue;
            }
            break;
        }
        return current;
    }

    private static IEnumerable<MethodBase> CalledMethods(MethodBase owner)
    {
        byte[]? il = owner.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            yield break;
        }
        int offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                yield break;
            }
            if (opCode.OperandType == OperandType.InlineMethod
                && ResolveMethod(owner, BitConverter.ToInt32(il, offset)) is MethodBase called)
            {
                yield return called;
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static IEnumerable<int> IntegerConstants(MethodBase owner)
    {
        byte[]? il = owner.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            yield break;
        }
        int offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                yield break;
            }
            int? constant = opCode == OpCodes.Ldc_I4_M1 ? -1
                : opCode == OpCodes.Ldc_I4_0 ? 0
                : opCode == OpCodes.Ldc_I4_1 ? 1
                : opCode == OpCodes.Ldc_I4_2 ? 2
                : opCode == OpCodes.Ldc_I4_3 ? 3
                : opCode == OpCodes.Ldc_I4_4 ? 4
                : opCode == OpCodes.Ldc_I4_5 ? 5
                : opCode == OpCodes.Ldc_I4_6 ? 6
                : opCode == OpCodes.Ldc_I4_7 ? 7
                : opCode == OpCodes.Ldc_I4_8 ? 8
                : opCode == OpCodes.Ldc_I4_S ? (sbyte)il[offset]
                : opCode == OpCodes.Ldc_I4 ? BitConverter.ToInt32(il, offset)
                : null;
            if (constant is int observed)
            {
                yield return observed;
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static string MethodSignature(MethodInfo method)
        => $"{method.DeclaringType?.FullName}.{method.Name}("
            + string.Join(',', method.GetParameters()
                .Where(static parameter => parameter.ParameterType == typeof(Stream))
                .Select(static parameter => parameter.ParameterType.Name))
            + ")";

    private static string MethodIdentity(MethodBase method)
        => $"{method.DeclaringType?.FullName}.{method.Name}";

    private static bool ShouldRecurse(MethodBase method)
        => method.DeclaringType?.Assembly == typeof(AuthoringEndpoints).Assembly
            && (method.DeclaringType.Namespace?.StartsWith("FsusBlog.Server.Modules.Endpoints", StringComparison.Ordinal) ?? false);

    private static MethodBase? ResolveMethod(MethodBase owner, int token)
    {
        try
        {
            Type[]? declaringArguments = owner.DeclaringType?.IsGenericType == true
                ? owner.DeclaringType.GetGenericArguments()
                : null;
            Type[]? methodArguments = owner.IsGenericMethod ? owner.GetGenericArguments() : null;
            return owner.Module.ResolveMethod(token, declaringArguments, methodArguments);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static int OperandSize(OpCode opCode, byte[] il, int operandOffset)
        => opCode.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => throw new InvalidOperationException($"unsupported IL operand type {opCode.OperandType}")
        };
}

internal static class CompiledPublicStatusObserver
{
    private static readonly IReadOnlyDictionary<short, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .ToDictionary(static code => code.Value);

    public static IReadOnlyDictionary<int, IReadOnlyList<string>> Observe(RouteEndpoint endpoint)
    {
        MethodInfo? handler = endpoint.Metadata.GetMetadata<MethodInfo>();
        if (handler is null)
        {
            return new SortedDictionary<int, IReadOnlyList<string>>();
        }

        Dictionary<int, HashSet<string>> evidence = [];
        ObservePipelineMetadata(endpoint, evidence);
        HashSet<MethodBase> visited = [];
        ObserveMethod(handler, evidence, visited, 0, captureConstants: false);
        return evidence
            .OrderBy(static pair => pair.Key)
            .ToDictionary(
                static pair => pair.Key,
                static pair => (IReadOnlyList<string>)pair.Value.OrderBy(static item => item, StringComparer.Ordinal).ToArray());
    }

    private static void ObserveMethod(
        MethodBase method,
        Dictionary<int, HashSet<string>> evidence,
        HashSet<MethodBase> visited,
        int depth,
        bool captureConstants)
    {
        if (depth > 6 || !visited.Add(method))
        {
            return;
        }

        if (method is MethodInfo methodInfo)
        {
            AsyncStateMachineAttribute? asyncStateMachine = methodInfo.GetCustomAttribute<AsyncStateMachineAttribute>();
            MethodInfo? moveNext = asyncStateMachine?.StateMachineType.GetMethod(
                nameof(IAsyncStateMachine.MoveNext),
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (moveNext is not null)
            {
                ObserveMethod(moveNext, evidence, visited, depth + 1, captureConstants);
            }
        }

        MethodBody? body = method.GetMethodBody();
        byte[]? il = body?.GetILAsByteArray();
        if (il is null)
        {
            return;
        }

        int offset = 0;
        int? pendingStatus = null;
        var recentIntegers = new Queue<(int Value, int Offset)>();
        int instruction = 0;
        while (offset < il.Length)
        {
            int instructionOffset = offset;
            short value = il[offset++];
            if (value == 0xfe)
            {
                value = (short)(0xfe00 | il[offset++]);
            }
            if (!s_opCodes.TryGetValue(value, out OpCode opCode))
            {
                return;
            }

            int? constant = ReadIntegerConstant(opCode, il, offset);
            if (constant is not null)
            {
                recentIntegers.Enqueue((constant.Value, instruction));
            }
            while (recentIntegers.TryPeek(out (int Value, int Offset) candidate)
                && instruction - candidate.Offset > 24)
            {
                recentIntegers.Dequeue();
            }
            if (constant is >= 400 and <= 599 && captureConstants)
            {
                Add(evidence, constant.Value, $"compiled-il:{MethodIdentity(method)}@{instructionOffset}");
            }
            if (constant is not null)
            {
                pendingStatus = constant;
            }

            if (opCode.OperandType == OperandType.InlineMethod)
            {
                int token = BitConverter.ToInt32(il, offset);
                MethodBase? called = ResolveMethod(method, token);
                if (called is not null)
                {
                    ObserveKnownStatus(called, evidence);
                    ObserveTransportMappingStatus(
                        called,
                        recentIntegers,
                        evidence,
                        $"compiled-mapping-authority:{(method.DeclaringType?.IsNested == true ? "nested" : "method")}:"
                        + $"{MethodIdentity(method)}->{MethodIdentity(called)}@{instructionOffset}");
                    if (pendingStatus is >= 400 and <= 599 && AcceptsExplicitStatus(called))
                    {
                        Add(
                            evidence,
                            pendingStatus.Value,
                            $"compiled-call-argument:{MethodIdentity(method)}->{MethodIdentity(called)}@{instructionOffset}");
                    }
                    if (ShouldRecurse(called))
                    {
                        ObserveMethod(
                            called,
                            evidence,
                            visited,
                            depth + 1,
                            captureConstants: called.Name.Contains("ToHttpStatus", StringComparison.Ordinal));
                    }
                }
                pendingStatus = null;
            }
            offset += OperandSize(opCode, il, offset);
            instruction++;
        }
    }

    private static void ObservePipelineMetadata(
        RouteEndpoint endpoint,
        Dictionary<int, HashSet<string>> evidence)
    {
        Add(evidence, StatusCodes.Status406NotAcceptable, "compiled-middleware:ApiBinaryResponseMiddleware.accept");
        Add(evidence, StatusCodes.Status500InternalServerError, "compiled-middleware:GlobalExceptionMiddleware");

        string[] methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods.ToArray() ?? [];
        if (methods.Any(static method => !HttpMethods.IsGet(method) && !HttpMethods.IsHead(method)))
        {
            Add(evidence, StatusCodes.Status415UnsupportedMediaType, "compiled-middleware:ApiBinaryResponseMiddleware.content-type");
        }

        AuthorizationPolicy[] policies = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().ToArray();
        bool authenticated = policies
            .SelectMany(static policy => policy.Requirements)
            .Any(static requirement => requirement is DenyAnonymousAuthorizationRequirement);
        bool admin = policies
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Any(static requirement => requirement.ClaimType == "is_admin");
        if (authenticated)
        {
            Add(evidence, StatusCodes.Status401Unauthorized, "compiled-authorization:deny-anonymous");
            if (!admin)
            {
                Add(evidence, StatusCodes.Status423Locked, "compiled-middleware:BannedUserMiddleware");
            }
        }
        if (admin || policies.SelectMany(static policy => policy.Requirements).OfType<ClaimsAuthorizationRequirement>().Any())
        {
            Add(evidence, StatusCodes.Status403Forbidden, "compiled-authorization:claim-requirement");
        }

        if (endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>() is not null)
        {
            Add(evidence, StatusCodes.Status429TooManyRequests, "compiled-rate-limit:EnableRateLimitingAttribute");
        }

        Type[] filters = endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
            .Select(static metadata => metadata.FilterType)
            .Distinct()
            .ToArray();
        if (filters.Contains(typeof(RequiresPowFilter)))
        {
            Add(evidence, StatusCodes.Status400BadRequest, "compiled-filter:RequiresPowFilter");
            Add(evidence, StatusCodes.Status401Unauthorized, "compiled-filter:RequiresPowFilter");
            Add(evidence, StatusCodes.Status403Forbidden, "compiled-filter:RequiresPowFilter");
        }
        if (filters.Contains(typeof(RequiresRiskControlFilter)))
        {
            Add(evidence, StatusCodes.Status428PreconditionRequired, "compiled-filter:RequiresRiskControlFilter");
            Add(evidence, StatusCodes.Status429TooManyRequests, "compiled-filter:RequiresRiskControlFilter");
            Add(evidence, StatusCodes.Status500InternalServerError, "compiled-filter:RequiresRiskControlFilter");
        }
        if (filters.Contains(typeof(RiskAwarePublicReadFilter)))
        {
            Add(evidence, StatusCodes.Status428PreconditionRequired, "compiled-filter:RiskAwarePublicReadFilter");
            Add(evidence, StatusCodes.Status429TooManyRequests, "compiled-filter:RiskAwarePublicReadFilter");
        }
    }

    private static bool AcceptsExplicitStatus(MethodBase method)
    {
        string declaring = method.DeclaringType?.FullName ?? string.Empty;
        return (declaring is "FsusBlog.Server.Infrastructure.Results.AedsJsonResults"
                or "FsusBlog.Server.Infrastructure.Results.BinaryResults"
                or "Microsoft.AspNetCore.Http.Results")
            && method.GetParameters().Any(static parameter => parameter.ParameterType == typeof(int));
    }

    private static void ObserveTransportMappingStatus(
        MethodBase called,
        IEnumerable<(int Value, int Offset)> recentIntegers,
        Dictionary<int, HashSet<string>> evidence,
        string source)
    {
        if (called.DeclaringType == typeof(ApiErrorSemanticMapper)
            && called.Name == nameof(ApiErrorSemanticMapper.GetDefaultMappingId))
        {
            foreach (int status in ApiErrorSemanticMapper.TransportMappings
                .Where(static mapping =>
                    mapping.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus)
                .Select(static mapping => mapping.HttpStatus)
                .Distinct()
                .Order())
            {
                Add(evidence, status, source);
            }
            return;
        }

        if (called.DeclaringType == typeof(ApiErrorSemanticMapper)
            && called.Name == nameof(ApiErrorSemanticMapper.RequireTransportMappingId))
        {
            int? status = recentIntegers
                .Reverse()
                .Select(static item => item.Value)
                .FirstOrDefault(static value => value is >= 400 and <= 599);
            if (status is >= 400 and <= 599)
            {
                Add(evidence, status.Value, source);
            }
            return;
        }

        if (called.DeclaringType != typeof(AedsJsonResults)
            || !called.GetParameters().Any(static parameter =>
                parameter.ParameterType == typeof(ApiErrorTransportMappingId)))
        {
            return;
        }

        foreach (int value in recentIntegers.Reverse().Select(static item => item.Value))
        {
            var mappingId = (ApiErrorTransportMappingId)value;
            if (mappingId != ApiErrorTransportMappingId.None && Enum.IsDefined(mappingId))
            {
                Add(evidence, ApiErrorSemanticMapper.GetMapping(mappingId).HttpStatus, source);
                return;
            }
        }
    }

    private static void ObserveKnownStatus(
        MethodBase called,
        Dictionary<int, HashSet<string>> evidence)
    {
        string declaring = called.DeclaringType?.FullName ?? string.Empty;
        if (declaring != "FsusBlog.Server.Infrastructure.Results.AedsJsonResults")
        {
            return;
        }

        int? status = called.Name switch
        {
            "BadRequest" => 400,
            "Unauthorized" => 401,
            "NotFound" => 404,
            "PreconditionRequired" => 428,
            "ReadAsync" => 400,
            _ => null
        };
        if (status is int value)
        {
            Add(evidence, value, $"compiled-call:{declaring}.{called.Name}");
        }
    }

    private static int? ReadIntegerConstant(OpCode opCode, byte[] il, int operandOffset)
    {
        if (opCode == OpCodes.Ldc_I4_M1)
            return -1;
        if (opCode == OpCodes.Ldc_I4_0)
            return 0;
        if (opCode == OpCodes.Ldc_I4_1)
            return 1;
        if (opCode == OpCodes.Ldc_I4_2)
            return 2;
        if (opCode == OpCodes.Ldc_I4_3)
            return 3;
        if (opCode == OpCodes.Ldc_I4_4)
            return 4;
        if (opCode == OpCodes.Ldc_I4_5)
            return 5;
        if (opCode == OpCodes.Ldc_I4_6)
            return 6;
        if (opCode == OpCodes.Ldc_I4_7)
            return 7;
        if (opCode == OpCodes.Ldc_I4_8)
            return 8;
        if (opCode == OpCodes.Ldc_I4_S)
            return (sbyte)il[operandOffset];
        if (opCode == OpCodes.Ldc_I4)
            return BitConverter.ToInt32(il, operandOffset);
        return null;
    }

    private static void Add(Dictionary<int, HashSet<string>> evidence, int status, string source)
    {
        if (!evidence.TryGetValue(status, out HashSet<string>? sources))
        {
            sources = [];
            evidence[status] = sources;
        }
        sources.Add(source);
    }

    private static bool ShouldRecurse(MethodBase method)
        => method.DeclaringType?.Assembly == typeof(AuthoringEndpoints).Assembly
            && (method.DeclaringType.Namespace?.StartsWith("FsusBlog.Server.Modules.Endpoints", StringComparison.Ordinal) ?? false);

    private static MethodBase? ResolveMethod(MethodBase owner, int token)
    {
        try
        {
            Type[]? declaringArguments = owner.DeclaringType?.IsGenericType == true
                ? owner.DeclaringType.GetGenericArguments()
                : null;
            Type[]? methodArguments = owner.IsGenericMethod ? owner.GetGenericArguments() : null;
            return owner.Module.ResolveMethod(token, declaringArguments, methodArguments);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string MethodIdentity(MethodBase method)
        => $"{method.DeclaringType?.FullName}.{method.Name}";

    private static int OperandSize(OpCode opCode, byte[] il, int operandOffset)
        => opCode.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, operandOffset) * 4),
            _ => throw new InvalidOperationException($"unsupported IL operand type {opCode.OperandType}")
        };
}
