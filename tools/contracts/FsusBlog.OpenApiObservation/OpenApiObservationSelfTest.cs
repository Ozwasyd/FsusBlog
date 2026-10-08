using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.OpenApiObservation;

internal static class OpenApiObservationSelfTest
{
    public static int Run(string repositoryRoot)
    {
        var completed = new List<string>();
        TestCatalogLoader(repositoryRoot, completed);
        TestRequestObserver(completed);
        TestContainerRequestObserver(repositoryRoot, completed);
        TestStatusObserver(completed);
        TestCredentialPolicy(completed);
        TestMerger(completed);
        TestCensus(completed);
        TestFontThemeCensus(completed);
        Console.WriteLine($"[openapi-observation-self-test] ok cases={completed.Count} {string.Join(',', completed)}");
        return 0;
    }

    private static void TestCredentialPolicy(ICollection<string> completed)
    {
        static RouteEndpoint Endpoint(params object[] metadata)
            => new(_ => Task.CompletedTask, RoutePatternFactory.Parse("/api/binary/self-test"), 0,
                new EndpointMetadataCollection(metadata), "credential-self-test");

        var anonymous = new AllowAnonymousAttribute();
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous), "POST") == "include",
            "anonymous login/bootstrap must retain credentials");
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous), "GET") == "include",
            "anonymous security/read-proof must retain credentials");
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous, new EnableRateLimitingAttribute("public_read")), "GET") == "omit",
            "public read must omit credentials");
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous, StrongAnonymousRequestMetadata.Instance), "POST") == "omit",
            "strong anonymous writes must omit credentials");
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous, new BinaryCredentialPolicyMetadata(BinaryCredentialPolicy.Omit)), "GET") == "omit",
            "explicit public omission must survive observation");
        Assert(OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(new AuthorizeAttribute()), "GET") == "include",
            "authenticated operations must retain credentials");
        AssertThrows("authenticated credential omission",
            () => OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(new AuthorizeAttribute(), new BinaryCredentialPolicyMetadata(BinaryCredentialPolicy.Omit)), "GET"),
            "authenticated binary endpoint cannot omit credentials");
        AssertThrows("unknown credential policy",
            () => OpenApiObservationHost.ClassifyCredentialPolicy(Endpoint(anonymous, new BinaryCredentialPolicyMetadata((BinaryCredentialPolicy)99)), "GET"),
            "binary endpoint credential policy is invalid");
        completed.Add("credential-policy");
    }

    private static void TestCatalogLoader(string repositoryRoot, ICollection<string> completed)
    {
        string source = Path.Combine(
            repositoryRoot,
            "src",
            "shared",
            "Contracts",
            "Validation",
            "aeds-endpoint-contracts.json");
        AedsEndpointContractCatalog loaded = AedsEndpointContractCatalog.Load(source);
        Assert(loaded.Operations.Count > 0, "catalog loader returned no operations");

        string temporary = Path.Combine(Path.GetTempPath(), $"fsusblog-openapi-catalog-{Guid.NewGuid():N}.json");
        try
        {
            JsonObject WithoutDigest() => JsonNode.Parse(File.ReadAllText(source))?.AsObject()
                ?? throw new InvalidOperationException("self-test catalog is not an object");

            JsonObject missingDigest = WithoutDigest();
            missingDigest.Remove("contentDigest");
            File.WriteAllText(temporary, missingDigest.ToJsonString());
            AssertThrows(
                "catalog missing contentDigest",
                () => AedsEndpointContractCatalog.Load(temporary),
                "contentDigest required");

            JsonObject staleDigest = WithoutDigest();
            staleDigest["contentDigest"] = new string('0', 64);
            File.WriteAllText(temporary, staleDigest.ToJsonString());
            AssertThrows(
                "catalog stale contentDigest",
                () => AedsEndpointContractCatalog.Load(temporary),
                "contentDigest mismatch");

            JsonObject incompleteRequest = WithoutDigest();
            JsonObject requestOperation = incompleteRequest["operations"]!.AsArray()
                .Select(static item => item!.AsObject())
                .First(static item => item["requestFrame"] is JsonValue);
            requestOperation.Remove("requestType");
            File.WriteAllText(temporary, incompleteRequest.ToJsonString());
            AssertThrows(
                "catalog incomplete request exact set",
                () => AedsEndpointContractCatalog.Load(temporary),
                "request frame/type/encoding must be an exact set");
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
        completed.Add("loader");
    }

    private static void TestRequestObserver(ICollection<string> completed)
    {
        AssertThrows(
            "missing compiled request reader",
            () => RequestContractObserver.Build("SelfTestRequest", "self_test", [], []),
            "no compiled request type");
        AssertThrows(
            "conflicting compiled request sources",
            () => RequestContractObserver.Build(
                "SelfTestRequest",
                "self_test",
                [],
                [
                    new ObservedRequestType(typeof(SelfTestRequestA), "binary-layout", "self-test-reader-a"),
                    new ObservedRequestType(typeof(SelfTestRequestB), "binary-layout", "self-test-reader-b")
                ]),
            "ambiguous compiled request types");
        AssertThrows(
            "conflicting compiled request encodings",
            () => RequestContractObserver.Build(
                "SelfTestRequest",
                "self_test",
                [],
                [
                    new ObservedRequestType(typeof(SelfTestRequestA), "binary-layout", "self-test-reader-a"),
                    new ObservedRequestType(typeof(SelfTestRequestA), "utf8-json", "self-test-reader-b")
                ]),
            "conflicting encodings");

        AssertThrows(
            "mixed string and model compiled readers",
            () => RequestContractObserver.Build(
                "SelfTestRequest",
                "self_test",
                [],
                [
                    new ObservedRequestType(typeof(string), "utf8-json", "self-test-string-reader"),
                    new ObservedRequestType(typeof(SelfTestRequestA), "utf8-json", "self-test-model-reader")
                ]),
            "ambiguous compiled request types");

        WebApplication app = OpenApiObservationHost.CreateApplication();
        try
        {
            RouteEndpoint install = ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>()
                .Single(static item => string.Equals(
                    item.RoutePattern.RawText?.TrimStart('/'),
                    "api/binary/author/plugins/install",
                    StringComparison.Ordinal));
            RequestParameterContract confirmation = CompiledRequestParameterObserver.Observe(install)
                .Single(static item => item.Source == "header" && item.Name == "X-Fsus-Plugin-Confirm");
            Assert(confirmation.Required, "plugin confirmation header must be required by compiled behavior");
            Assert(!confirmation.Nullable, "plugin confirmation header must be non-nullable by compiled behavior");
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        completed.Add("request");
    }

    private static void TestContainerRequestObserver(string repositoryRoot, ICollection<string> completed)
    {
        AedsEndpointContractCatalog catalog = AedsEndpointContractCatalog.Load(Path.Combine(
            repositoryRoot, "src", "shared", "Contracts", "Validation", "aeds-endpoint-contracts.json"));
        WebApplication app = OpenApiObservationHost.CreateApplication();
        try
        {
            OperationRequestContract ProductionRequest(string path, Type expectedType)
            {
                AedsEndpointContract canonical = catalog.Operations.Single(item => item.Path == path);
                RouteEndpoint endpoint = ((IEndpointRouteBuilder)app).DataSources
                    .SelectMany(static source => source.Endpoints).OfType<RouteEndpoint>()
                    .Single(item => item.RoutePattern.RawText?.TrimStart('/') == path.TrimStart('/'));
                CompiledEndpointContract compiled = CompiledEndpointContractObserver.Observe(
                    endpoint, canonical.Method, canonical.Path);
                IReadOnlyList<ObservedRequestType> types = CompiledRequestTypeObserver.Observe(endpoint);
                Assert(types.Any(item => item.Type == expectedType), "production reader precondition is missing");
                Assert(canonical.RequestType == expectedType.FullName && canonical.RequestFrame == compiled.RequestFrame,
                    "production request differs from canonical catalog");
                OperationRequestContract request = RequestContractObserver.Build(compiled.RequestFrame,
                    canonical.OperationId, CompiledRequestParameterObserver.Observe(endpoint), types);
                Assert(request.Encoding == canonical.RequestEncoding && request.SourceTypes.Contains(canonical.RequestType!),
                    "production root type/encoding binding changed");
                return request;
            }

            RequestPropertyContract tags = ProductionRequest("/api/binary/author/drafts",
                typeof(FsusBlog.Server.Models.Dtos.ServerDraftSaveRequest)).Properties["tagIds"];
            Assert(tags.Type == "array" && !tags.Nullable && tags.Required && tags.Item is not null,
                "TagIds container contract is missing");
            Assert(tags.Item is { Type: "integer", Nullable: false, Item: null, SchemaRef: null }
                && tags.Item.Bounds.Minimum == "-2147483648" && tags.Item.Bounds.Maximum == "2147483647",
                "TagIds lost canonical Int32 element range");
            RequestPropertyContract comments = ProductionRequest("/api/binary/author/comments/moderation/bulk",
                typeof(FsusBlog.Server.Models.Dtos.CommentModerationBulkRequest)).Properties["commentIds"];
            Assert(comments.Type == "array" && !comments.Nullable && comments.Required
                && comments.Item is { Type: "string", Nullable: false, Item: null, SchemaRef: null },
                "CommentIds lost nonnullable string element contract");
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        OperationRequestContract Containers(Type type) => RequestContractObserver.Build(
            "SelfTestRequest", "self_test_containers", [], [new(type, "utf8-json", "self-test-container-reader")]);
        OperationRequestContract observed = Containers(typeof(SelfTestContainerRequest));
        Assert(observed.Properties["nullableItems"] is
        {
            Nullable: true, Required: false,
            Item: { Type: "string", Nullable: true }
        }, "container and item nullability must remain separate");
        Assert(observed.Properties["arrayItems"].Item is { Type: "string", Nullable: true },
            "array ElementType annotation is missing");
        Assert(observed.Properties["map"] is
        {
            Type: "object", Format: "string-keyed-map",
            Item: { Type: "array", Nullable: false, Item: { Type: "integer", Nullable: true } }
        },
            "dictionary/nested nullable value tree is missing");
        Assert(observed.Properties["map"].Item!.Item!.Bounds.Maximum == "2147483647",
            "nested nullable Int32 range is missing");
        Assert(observed.Properties["objects"].Item?.SchemaRef == $"clr://{typeof(SelfTestRequestA).FullName}"
            && observed.Definitions.ContainsKey(typeof(SelfTestRequestA).FullName!), "object element definition is missing");
        Assert(observed.Properties["choices"].Item!.EnumValues.SequenceEqual(new[] { "First", "Second" }),
            "enum element values are missing");
        OperationRequestContract nestedObjects = Containers(typeof(SelfTestNestedObjectsRequest));
        Assert(nestedObjects.Properties["values"].Item?.Item is { Nullable: true }
            && nestedObjects.Properties["values"].Item!.Item!.SchemaRef == $"clr://{typeof(SelfTestRequestA).FullName}"
            && nestedObjects.Definitions.ContainsKey(typeof(SelfTestRequestA).FullName!),
            "nested containers must retain their leaf object definition");
        Assert(Containers(typeof(SelfTestDictionaryRequest)).Properties["values"].Item is { Type: "string", Nullable: true },
            "dictionary key annotation must not replace its nullable string value annotation");
        AssertThrows("unavailable inherited item annotation", () => Containers(typeof(SelfTestInheritedItemsRequest)),
            "container item nullability is ambiguous");
        Assert(Containers(typeof(SelfTestIntrinsicRequest)).Properties["value"].Nullable == false,
            "intrinsic value type must not require reference annotations");
        Assert(new System.Reflection.NullabilityInfoContext().Create(typeof(SelfTestObliviousRequest)
            .GetProperty("Value")!).ReadState == System.Reflection.NullabilityState.Unknown,
            "oblivious-reference negative precondition changed");
        AssertThrows("unknown reference annotation", () => Containers(typeof(SelfTestObliviousRequest)),
            "unknown reference nullability");
        System.Reflection.NullabilityInfo obliviousItems = new System.Reflection.NullabilityInfoContext()
            .Create(typeof(SelfTestObliviousItemsRequest).GetField("Values")!);
        Assert(obliviousItems.ReadState == System.Reflection.NullabilityState.NotNull
            && obliviousItems.GenericTypeArguments[0].ReadState == System.Reflection.NullabilityState.Unknown,
            "oblivious-element negative precondition changed");
        AssertThrows("unknown element annotation", () => Containers(typeof(SelfTestObliviousItemsRequest)),
            "unknown reference nullability");
        completed.Add("container-request");
    }

    private static void TestStatusObserver(ICollection<string> completed)
    {
        WebApplication app = OpenApiObservationHost.CreateApplication();
        try
        {
            RouteEndpoint endpoint = ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>()
                .Single(static item => item.RoutePattern.RawText == "api/binary/file/delete");
            IReadOnlyDictionary<int, IReadOnlyList<string>> statuses = CompiledPublicStatusObserver.Observe(endpoint);
            Assert(statuses.ContainsKey(StatusCodes.Status406NotAcceptable), "status observer missed binary accept rejection");
            Assert(statuses.ContainsKey(StatusCodes.Status500InternalServerError), "status observer missed exception mapping");
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        completed.Add("status");
    }

    private static void TestMerger(ICollection<string> completed)
    {
        AedsEndpointContract contract = Contract();
        AedsEndpointContractCatalog catalog = Catalog(contract);
        ObservedOperation observed = Observed();
        ObservationDocument merged = Merge([observed], catalog);
        Assert(merged.Operations.Single().OperationId == contract.OperationId, "merger changed compiled operationId");
        Assert(merged.ObservationDigest == ObservationDigest.Compute(merged), "observation digest helper is not canonical");

        AssertThrows("missing compiled endpoint", () => Merge([], catalog), "orphanContracts");
        AssertThrows(
            "extra compiled endpoint",
            () => Merge([observed], Catalog(contract with { Path = "/api/binary/other" })),
            "missingContracts");
        AssertConflict(observed, value => value with { OperationId = "compiled_other" }, "operationId");
        AssertConflict(observed, value => value with { RequestFrame = "UnexpectedRequest" }, "requestFrame");
        AssertConflict(observed, value => value with { ResponseFrame = "UnexpectedResponse" }, "responseFrame");
        AssertConflict(observed, value => value with { ErrorFrame = "UnexpectedError" }, "errorFrame");
        AssertConflict(observed, value => value with { SuccessStatus = StatusCodes.Status201Created }, "successStatus");
        AssertThrows(
            "compiled content type conflict",
            () => Merge([observed with { Contract = observed.Contract with { ContentType = "application/json" } }], catalog),
            "not an AEDS frame contract");
        AssertThrows(
            "compiled result placement conflict",
            () => Merge([observed with { Contract = observed.Contract with { ResultPlacement = "json.body" } }], catalog),
            "not an AEDS frame contract");
        completed.Add("merger");
    }

    private static void TestCensus(ICollection<string> completed)
    {
        CompiledEndpointContractCensus.Validate([]);
        CompiledEndpointContractCensus.Validate(
        [
            ("GET /api/binary/self-test", Observed().Contract)
        ]);
        AssertThrows(
            "retired Font/Theme non-AEDS exception",
            () => CompiledEndpointContractCensus.Validate(
            [
                ("GET /api/binary/author/ops/fonts/registry", Observed().Contract with
                {
                    ResponseFrame = null,
                    ErrorFrame = null,
                    SuccessStatus = null,
                    ContentType = "application/json",
                    ResultPlacement = "json.body"
                })
            ]),
            "1 unexpected non-AEDS route");
        AssertThrows(
            "non-AEDS production census",
            () => CompiledEndpointContractCensus.Validate(
            [
                ("GET /api/binary/self-test", Observed().Contract),
                ("GET /api/binary/self-test-json", Observed().Contract with
                {
                    ResponseFrame = null,
                    ErrorFrame = null,
                    SuccessStatus = null,
                    ContentType = "application/json",
                    ResultPlacement = "json.body"
                })
            ]),
            "1 unexpected non-AEDS route");
        completed.Add("census");
    }

    private static void TestFontThemeCensus(ICollection<string> completed)
    {
        (string Path, string ResponseFrame)[] expected =
        [
            ("/api/binary/author/ops/fonts/activations", "FontActivationList"),
            ("/api/binary/author/ops/fonts/registry", "FontRegistryList"),
            ("/api/binary/author/ops/fonts/registry/{fontId}", "FontRegistryDetail"),
            ("/api/binary/author/ops/themes/activations", "ThemeActivationList"),
            ("/api/binary/author/ops/themes/activations/{scope}", "ThemeActivation"),
            ("/api/binary/author/ops/themes/activations/{scope}/history", "ThemeActivationHistory"),
            ("/api/binary/author/ops/themes/registry", "ThemeRegistryList"),
            ("/api/binary/author/ops/themes/registry/{themeId}", "ThemeRegistryDetail")
        ];
        WebApplication app = OpenApiObservationHost.CreateApplication();
        try
        {
            RouteEndpoint[] endpoints = ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>()
                .ToArray();
            List<(string Key, CompiledEndpointContract Contract)> converted = [];
            foreach ((string path, string responseFrame) in expected)
            {
                RouteEndpoint endpoint = endpoints.Single(item =>
                    string.Equals("/" + item.RoutePattern.RawText?.TrimStart('/'), path, StringComparison.Ordinal)
                    && item.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.Contains("GET") == true);
                CompiledEndpointContract contract = CompiledEndpointContractObserver.Observe(endpoint, "GET", path);
                string key = $"GET {path}";
                Assert(contract.RequestFrame is null, $"{key} must remain request-free");
                Assert(contract.ResponseFrame == responseFrame, $"{key} compiled response frame drifted");
                Assert(contract.ErrorFrame == "ApiError", $"{key} lost the standard error frame");
                Assert(contract.SuccessStatus == StatusCodes.Status200OK, $"{key} success status drifted");
                CompiledEndpointContractCensus.Validate([(key, contract)]);
                converted.Add((key, contract));
            }
            CompiledEndpointContractCensus.Validate(converted);

            foreach ((string key, CompiledEndpointContract contract) in converted)
            {
                CompiledEndpointContract[] invalid =
                [
                    contract with { ContentType = "application/json" },
                    contract with { ResultPlacement = "json.body" },
                    contract with { ResponseFrame = null },
                    contract with { ErrorFrame = null },
                    contract with { SuccessStatus = null }
                ];
                foreach (CompiledEndpointContract malformed in invalid)
                {
                    // Keep the other seven actual compiled routes valid: one
                    // malformed migrated route must invalidate the whole census.
                    (string Key, CompiledEndpointContract Contract)[] mixed = converted
                        .Select(item => item.Key == key ? (key, malformed) : item)
                        .ToArray();
                    AssertThrows(
                        $"{key} incomplete AEDS contract",
                        () => CompiledEndpointContractCensus.Validate(mixed),
                        "1 unexpected non-AEDS route");
                }
            }
        }
        finally
        {
            app.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        completed.Add("font-theme-census");
    }

    private static void AssertConflict(
        ObservedOperation observed,
        Func<CompiledEndpointContract, CompiledEndpointContract> mutate,
        string field)
        => AssertThrows(
            $"compiled/shared {field} conflict",
            () => Merge([observed with { Contract = mutate(observed.Contract) }], Catalog(Contract())),
            $"compiled/shared {field} conflict");

    private static ObservationDocument Merge(
        IReadOnlyList<ObservedOperation> observed,
        AedsEndpointContractCatalog catalog)
        => ObservationMerger.Merge(
            observed,
            catalog,
            new ProtocolStateCatalog([2], ["ApiError", "EmptySuccess"], [], [], true),
            new ErrorAuthorityBinding(
                "configuration-error-security-policy",
                new string('a', 64),
                "docs/api/schemas-and-errors.md",
                ["facts.error-codes.domain.active", "facts.error-codes.transport-mapping"]));

    private static AedsEndpointContract Contract()
        => new(
            "GET",
            "/api/binary/self-test",
            "binary_get_self_test",
            null,
            null,
            null,
            "EmptySuccess",
            "ApiError",
            StatusCodes.Status200OK);

    private static AedsEndpointContractCatalog Catalog(AedsEndpointContract contract)
        => new()
        {
            Schema = "fsusblog.aeds-endpoint-contracts.v2",
            Protocol = "AEDS",
            AedsVersion = 2,
            ContentDigest = new string('b', 64),
            Operations = [contract]
        };

    private static ObservedOperation Observed()
        => new(
            "GET",
            "/api/binary/self-test",
            "binary_get_self_test",
            new CompiledEndpointContract(
                "binary_get_self_test",
                null,
                "EmptySuccess",
                "ApiError",
                StatusCodes.Status200OK,
                "application/octet-stream",
                "aeds.frame.payload",
                ["compiled-self-test"]),
            "anonymous",
            "none",
            false,
            "public_read",
            "public-read",
            "compiled-self-test",
            [],
            [],
            new Dictionary<int, IReadOnlyList<string>>
            {
                [StatusCodes.Status500InternalServerError] = ["compiled-self-test-error"]
            }) { CredentialPolicy = "omit" };

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"self-test failed: {message}");
        }
    }

    private static void AssertThrows(string name, Action action, string expected)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException exception) when (exception.Message.Contains(expected, StringComparison.Ordinal))
        {
            return;
        }
        throw new InvalidOperationException($"self-test failed: {name} did not reject with '{expected}'");
    }

    private sealed record SelfTestRequestA(string Value);

    private sealed record SelfTestRequestB(string Value);

    private sealed record SelfTestContainerRequest(
        IReadOnlyList<string?>? NullableItems,
        string?[] ArrayItems,
        IReadOnlyDictionary<string, IReadOnlyList<int?>> Map,
        IReadOnlyList<SelfTestRequestA> Objects,
        IReadOnlyList<SelfTestChoice> Choices);

    private enum SelfTestChoice
    {
        First,
        Second
    }

    private sealed record SelfTestNestedObjectsRequest(IReadOnlyDictionary<string, IReadOnlyList<SelfTestRequestA?>> Values);

    private sealed record SelfTestDictionaryRequest(IReadOnlyDictionary<string, string?> Values);

    private sealed class SelfTestInheritedItems : List<string>
    {
    }

    private sealed record SelfTestInheritedItemsRequest(SelfTestInheritedItems Values);

#nullable disable
    private sealed record SelfTestObliviousRequest(string Value);

    private sealed class SelfTestObliviousItemsRequest
    {
        [System.Diagnostics.CodeAnalysis.NotNull]
        public IReadOnlyList<string> Values = Array.Empty<string>();
    }

    private sealed record SelfTestIntrinsicRequest(int Value);
#nullable restore
}
