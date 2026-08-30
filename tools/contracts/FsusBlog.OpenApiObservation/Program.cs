using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
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
using FsusBlog.Shared.Contracts.Governance;

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

                    IReadOnlyList<ObservedRequestType> requestTypes = CompiledRequestTypeObserver.Observe(endpoint);
                    IReadOnlyDictionary<int, IReadOnlyList<string>> errorStatuses = CompiledPublicStatusObserver.Observe(endpoint);
                    operations.Add(new ObservedOperation(
                        Method: method,
                        Path: rawPath,
                        OperationId: operationId,
                        Auth: ClassifyAuth(endpoint),
                        Permission: ClassifyPermission(endpoint),
                        Pow: HasFilter(endpoint, typeof(RequiresPowFilter)),
                        RateLimit: endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName ?? "none",
                        Cache: ClassifyCache(endpoint),
                        SourceIdentity: endpoint.DisplayName,
                        RequestTypes: requestTypes,
                        CompiledErrorStatusEvidence: errorStatuses));
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
        // AEDS binary contract surface: MapBinary + Authoring + Security.
        // Font/Theme admin endpoints intentionally return JSON Results.Ok and are
        // outside the AEDS OpenAPI observation set.
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
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
                SourceIdentity: $"public-hot-read:{policy.PolicyId}",
                RequestTypes: [],
                CompiledErrorStatusEvidence: new SortedDictionary<int, IReadOnlyList<string>>
                {
                    [StatusCodes.Status406NotAcceptable] = ["compiled-middleware:ApiBinaryResponseMiddleware.accept"],
                    [StatusCodes.Status428PreconditionRequired] = ["compiled-public-hot-read:PublicHotReadSecurityGateMiddleware"],
                    [StatusCodes.Status429TooManyRequests] = ["compiled-public-hot-read:PublicHotReadSecurityGateMiddleware"],
                    [StatusCodes.Status500InternalServerError] = ["compiled-middleware:GlobalExceptionMiddleware"]
                });
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
                    ObserveCall(called, requestTypes);
                    if (ShouldRecurse(called))
                    {
                        ObserveMethod(called, requestTypes, visited, depth + 1);
                    }
                }
            }
            offset += OperandSize(opCode, il, offset);
        }
    }

    private static void ObserveCall(MethodBase called, Dictionary<Type, ObservedRequestType> requestTypes)
    {
        if (called is not MethodInfo method)
        {
            return;
        }

        bool isJsonReader = method.Name is "ReadAsync" or "ReadRequestAsync" or "TryReadGovernanceJson"
            || method.Name.StartsWith("ReadCommentManagementRequest", StringComparison.Ordinal);
        bool isBinaryReader = method.Name.StartsWith("TryDecode", StringComparison.Ordinal)
            || (method.Name.StartsWith("Read", StringComparison.Ordinal) && !isJsonReader);
        bool isRequestReader = isJsonReader
            || method.Name.StartsWith("Read", StringComparison.Ordinal)
            || method.Name.StartsWith("TryDecode", StringComparison.Ordinal);
        if (!isRequestReader)
        {
            return;
        }

        string encoding = isJsonReader ? "utf8-json" : "binary-layout";
        string readerIdentity = $"{method.DeclaringType?.FullName}.{method.Name}";
        if (method.IsGenericMethod)
        {
            foreach (Type argument in method.GetGenericArguments())
            {
                AddCandidate(argument, encoding, readerIdentity, requestTypes, force: isJsonReader);
            }
        }

        if (method.Name.StartsWith("TryDecode", StringComparison.Ordinal)
            || method.Name.StartsWith("TryRead", StringComparison.Ordinal))
        {
            foreach (ParameterInfo parameter in method.GetParameters().Where(static item => item.ParameterType.IsByRef))
            {
                AddCandidate(
                    parameter.ParameterType.GetElementType(),
                    encoding,
                    readerIdentity,
                    requestTypes,
                    force: isBinaryReader);
            }
        }

        if (method.Name.StartsWith("Read", StringComparison.Ordinal))
        {
            AddCandidate(Unwrap(method.ReturnType), encoding, readerIdentity, requestTypes);
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

        if (force || candidate == typeof(string)
            || candidate.Name.Contains("Request", StringComparison.Ordinal)
            || candidate.Name.Contains("Payload", StringComparison.Ordinal)
            || candidate.Name.Contains("Draft", StringComparison.Ordinal))
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
