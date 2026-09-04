using System.Text.Json.Nodes;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.OpenApiObservation;

internal static class OpenApiObservationSelfTest
{
    public static int Run(string repositoryRoot)
    {
        var completed = new List<string>();
        TestCatalogLoader(repositoryRoot, completed);
        TestRequestObserver(completed);
        TestStatusObserver(completed);
        TestMerger(completed);
        TestCensus(completed);
        Console.WriteLine($"[openapi-observation-self-test] ok cases={completed.Count} {string.Join(',', completed)}");
        return 0;
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
            "1 non-AEDS route");
        completed.Add("census");
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
            });

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
}
