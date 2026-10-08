using System.Text.Json.Serialization;

namespace FsusBlog.OpenApiObservation;

internal sealed record ObservedOperation(
    string Method,
    string Path,
    string OperationId,
    CompiledEndpointContract Contract,
    string Auth,
    string Permission,
    bool Pow,
    string RateLimit,
    string Cache,
    string? SourceIdentity,
    IReadOnlyList<ObservedRequestType> RequestTypes,
    IReadOnlyList<RequestParameterContract> RequestParameters,
    IReadOnlyDictionary<int, IReadOnlyList<string>> CompiledErrorStatusEvidence)
{
    public required string CredentialPolicy { get; init; }
}

internal sealed record CompiledEndpointContract(
    string OperationId,
    string? RequestFrame,
    string? ResponseFrame,
    string? ErrorFrame,
    int? SuccessStatus,
    string ContentType,
    string ResultPlacement,
    IReadOnlyList<string> Evidence)
{
    public bool IsAeds
        => string.Equals(ContentType, "application/octet-stream", StringComparison.Ordinal)
            && string.Equals(ResultPlacement, "aeds.frame.payload", StringComparison.Ordinal)
            && !string.IsNullOrWhiteSpace(ResponseFrame)
            && !string.IsNullOrWhiteSpace(ErrorFrame)
            && SuccessStatus is not null;
}

internal sealed record ObservedRequestType(
    Type Type,
    string Encoding,
    string ReaderIdentity,
    string? SourceIdentity = null,
    int? MinimumBytes = null,
    int? MaximumBytes = null);

internal sealed record AedsEndpointContract(
    string Method,
    string Path,
    string OperationId,
    string? RequestFrame,
    string? RequestType,
    string? RequestEncoding,
    string ResponseFrame,
    string ErrorFrame,
    int SuccessStatus);

internal sealed class AedsEndpointContractCatalog
{
    public required string Schema
    {
        get; init;
    }

    public required string Protocol
    {
        get; init;
    }

    public required int AedsVersion
    {
        get; init;
    }

    public required string ContentDigest
    {
        get; init;
    }

    public required IReadOnlyList<AedsEndpointContract> Operations
    {
        get; init;
    }

    public static AedsEndpointContractCatalog Load(string path)
    {
        string text = File.ReadAllText(path);
        AedsEndpointContractCatalogDocument document = System.Text.Json.JsonSerializer.Deserialize<AedsEndpointContractCatalogDocument>(
            text,
            new System.Text.Json.JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
            })
            ?? throw new InvalidOperationException($"failed to parse contracts catalog: {path}");

        if (!string.Equals(document.Schema, "fsusblog.aeds-endpoint-contracts.v2", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"unsupported contracts schema: {document.Schema}");
        }

        if (document.Operations is null || document.Operations.Count == 0)
        {
            throw new InvalidOperationException("contracts catalog has no operations");
        }
        if (!string.Equals(document.Protocol, "AEDS", StringComparison.Ordinal) || document.AedsVersion != 2)
        {
            throw new InvalidOperationException("contracts catalog must be the active AEDS v2 partition");
        }
        foreach (AedsEndpointContractDocument item in document.Operations)
        {
            bool hasFrame = !string.IsNullOrWhiteSpace(item.RequestFrame);
            if (hasFrame != !string.IsNullOrWhiteSpace(item.RequestType)
                || hasFrame != !string.IsNullOrWhiteSpace(item.RequestEncoding))
            {
                throw new InvalidOperationException(
                    $"contract {item.OperationId ?? "unknown"} request frame/type/encoding must be an exact set");
            }
        }


        System.Text.Json.Nodes.JsonObject canonicalDocument = System.Text.Json.Nodes.JsonNode.Parse(text)?.AsObject()
            ?? throw new InvalidOperationException($"contracts catalog must be a JSON object: {path}");
        if (!canonicalDocument.Remove("contentDigest"))
        {
            throw new InvalidOperationException("contracts catalog contentDigest required");
        }
        string canonical = canonicalDocument.ToJsonString(new System.Text.Json.JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        });
        string actualDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        if (!string.Equals(document.ContentDigest, actualDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"contracts contentDigest mismatch: expected {document.ContentDigest}, got {actualDigest}");
        }

        return new AedsEndpointContractCatalog
        {
            Schema = document.Schema ?? throw new InvalidOperationException("contracts schema required"),
            Protocol = document.Protocol ?? "AEDS",
            AedsVersion = document.AedsVersion ?? 2,
            ContentDigest = actualDigest,
            Operations = document.Operations
                .Select(static item => new AedsEndpointContract(
                    Method: (item.Method ?? throw new InvalidOperationException("contract method required")).ToUpperInvariant(),
                    Path: Normalize(item.Path),
                    OperationId: Required(item.OperationId, "contract operationId required"),
                    RequestFrame: NormalizeFrame(item.RequestFrame),
                    RequestType: NormalizeFrame(item.RequestType),
                    RequestEncoding: NormalizeFrame(item.RequestEncoding),
                    ResponseFrame: Required(item.ResponseFrame, "contract responseFrame required"),
                    ErrorFrame: Required(item.ErrorFrame, "contract errorFrame required"),
                    SuccessStatus: item.SuccessStatus
                        ?? throw new InvalidOperationException("contract successStatus required")))
                .ToArray()
        };
    }

    private static string Normalize(string? path)
    {
        string value = (path ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return "/";
        }

        return value.StartsWith('/') ? value : "/" + value;
    }

    private static string? NormalizeFrame(string? frame)
        => string.IsNullOrWhiteSpace(frame) || frame == "null" ? null : frame;

    private static string Required(string? value, string message)
        => !string.IsNullOrWhiteSpace(value) ? value : throw new InvalidOperationException(message);
}

internal sealed class AedsEndpointContractCatalogDocument
{
    public string? Schema
    {
        get; set;
    }

    public string? Protocol
    {
        get; set;
    }

    public int? AedsVersion
    {
        get; set;
    }

    public string? ContentDigest
    {
        get; set;
    }

    public List<AedsEndpointContractDocument>? Operations
    {
        get; set;
    }
}

internal sealed class AedsEndpointContractDocument
{
    public string? Method
    {
        get; set;
    }

    public string? Path
    {
        get; set;
    }

    public string? OperationId
    {
        get; set;
    }

    public string? RequestFrame
    {
        get; set;
    }

    public string? RequestType
    {
        get; set;
    }

    public string? RequestEncoding
    {
        get; set;
    }

    public string? ResponseFrame
    {
        get; set;
    }

    public string? ErrorFrame
    {
        get; set;
    }

    public int? SuccessStatus
    {
        get; set;
    }
}

internal sealed class ObservationDocument
{
    public required string Schema
    {
        get; init;
    }

    public required string Protocol
    {
        get; init;
    }

    public required int AedsVersion
    {
        get; init;
    }

    public required int OperationCount
    {
        get; init;
    }

    public required IReadOnlyList<string> OperationKeys
    {
        get; init;
    }

    public required IReadOnlyList<ObservationOperation> Operations
    {
        get; init;
    }

    public required ProtocolStateCatalog ProtocolStates
    {
        get; init;
    }

    public required ErrorAuthorityBinding ErrorAuthority
    {
        get; init;
    }

    public required EndpointContractAuthorityBinding EndpointContractAuthority
    {
        get; init;
    }

    public required string ObservationDigest
    {
        get; init;
    }
}

internal sealed class ObservationOperation
{
    public required string Method
    {
        get; init;
    }

    public required string Path
    {
        get; init;
    }

    public required string OperationId
    {
        get; init;
    }

    public required string Protocol
    {
        get; init;
    }

    public required int AedsVersion
    {
        get; init;
    }

    public string? RequestFrame
    {
        get; init;
    }

    public required string ResponseFrame
    {
        get; init;
    }

    public required string ErrorFrame
    {
        get; init;
    }

    public required string Auth
    {
        get; init;
    }

    public required string CredentialPolicy
    {
        get; init;
    }

    public required string Permission
    {
        get; init;
    }

    public required bool Pow
    {
        get; init;
    }

    public required string RateLimit
    {
        get; init;
    }

    public required string Cache
    {
        get; init;
    }

    public required int SuccessStatus
    {
        get; init;
    }

    public required OperationRequestContract Request
    {
        get; init;
    }

    public required IReadOnlyList<OperationResponseContract> Responses
    {
        get; init;
    }

    public required IReadOnlyList<string> PublicErrorRefs
    {
        get; init;
    }

    public required IReadOnlyList<int> PublicErrorStatuses
    {
        get; init;
    }

    public required IReadOnlyDictionary<string, IReadOnlyList<string>> PublicErrorStatusEvidence
    {
        get; init;
    }

    public required string PublicErrorRefState
    {
        get; init;
    }

    public required string ErrorAuthorityBehaviorId
    {
        get; init;
    }

    public required string ResultPlacement
    {
        get; init;
    }

    public required string ProtocolState
    {
        get; init;
    }

    public string? SourceIdentity
    {
        get; init;
    }
}

internal sealed record OperationRequestContract(
    string Direction,
    string Source,
    string? SchemaRef,
    string Encoding,
    bool Required,
    bool Nullable,
    IReadOnlyList<string> RequiredFields,
    IReadOnlyList<RequestParameterContract> Parameters,
    IReadOnlyDictionary<string, RequestPropertyContract> Properties,
    IReadOnlyDictionary<string, RequestSchemaDefinition> Definitions,
    IReadOnlyList<string> OneOf,
    string? Discriminator,
    IReadOnlyDictionary<string, RequestBoundContract> Bounds,
    string FieldSetState,
    string BoundsState,
    string UnionState,
    string? SchemaDigest,
    IReadOnlyList<string> SourceTypes,
    IReadOnlyList<string> ReaderIdentities);

internal sealed record RequestSchemaDefinition(
    string TypeIdentity,
    IReadOnlyList<string> RequiredFields,
    IReadOnlyDictionary<string, RequestPropertyContract> Properties,
    IReadOnlyList<string> OneOf,
    string? Discriminator,
    IReadOnlyDictionary<string, RequestBoundContract> Bounds);

internal sealed record RequestPropertyContract(
    string Name,
    string Type,
    bool Required,
    bool Nullable,
    string? Format,
    string? SchemaRef,
    string? ItemType,
    string? ItemSchemaRef,
    RequestValueContract? Item,
    IReadOnlyList<string> EnumValues,
    RequestBoundContract Bounds);

internal sealed record RequestValueContract(
    string Type,
    bool Nullable,
    string? Format,
    string? SchemaRef,
    RequestValueContract? Item,
    IReadOnlyList<string> EnumValues,
    RequestBoundContract Bounds);

internal sealed record RequestBoundContract(
    string? Minimum,
    string? Maximum,
    int? MinLength,
    int? MaxLength,
    int? MinItems,
    int? MaxItems,
    int? MinProperties,
    int? MaxProperties);

internal sealed record RequestParameterContract(
    string Name,
    string Direction,
    string Source,
    string SchemaRef,
    bool Required,
    bool Nullable,
    RequestBoundContract Bounds,
    IReadOnlyList<string> Evidence);

internal sealed record OperationResponseContract(
    int? Status,
    string Kind,
    string SchemaRef,
    string ContentType,
    string ResultPlacement,
    bool Nullable,
    string? PublicErrorRef);

internal sealed record ProtocolStateCatalog(
    IReadOnlyList<int> SupportedVersions,
    IReadOnlyList<string> ActiveFrameIds,
    IReadOnlyList<int> RetiredFrameValues,
    IReadOnlyList<string> MigrationOnlyFrameIds,
    bool AedsOnly);

internal sealed record ErrorAuthorityBinding(
    string BehaviorId,
    string CatalogDigest,
    string DocumentPath,
    IReadOnlyList<string> FactIds);

internal sealed record EndpointContractAuthorityBinding(
    string Schema,
    string DocumentPath,
    string ContentDigest);

internal static class ObservationMerger
{
    public static ObservationDocument Merge(
        IReadOnlyList<ObservedOperation> observed,
        AedsEndpointContractCatalog contracts,
        ProtocolStateCatalog protocolStates,
        ErrorAuthorityBinding errorAuthority)
    {
        Dictionary<string, AedsEndpointContract> byKey = contracts.Operations
            .GroupBy(static item => MatchKey(item.Method, item.Path), StringComparer.Ordinal)
            .ToDictionary(
                static group => group.Key,
                static group =>
                {
                    if (group.Count() != 1)
                    {
                        throw new InvalidOperationException($"duplicate contract key {group.Key}");
                    }

                    return group.Single();
                },
                StringComparer.Ordinal);

        Dictionary<string, ObservedOperation> observedByKey = observed
            .GroupBy(static item => MatchKey(item.Method, item.Path), StringComparer.Ordinal)
            .ToDictionary(
                static group => group.Key,
                static group =>
                {
                    if (group.Count() != 1)
                    {
                        throw new InvalidOperationException($"duplicate observed key {group.Key}");
                    }

                    return group.Single();
                },
                StringComparer.Ordinal);

        List<string> missingContracts = observedByKey.Keys
            .Where(key => !byKey.ContainsKey(key))
            .OrderBy(static key => key, StringComparer.Ordinal)
            .ToList();
        List<string> orphanContracts = byKey.Keys
            .Where(key => !observedByKey.ContainsKey(key))
            .OrderBy(static key => key, StringComparer.Ordinal)
            .ToList();
        if (missingContracts.Count > 0 || orphanContracts.Count > 0)
        {
            throw new InvalidOperationException(
                "endpoint/contract set drift\n"
                + $"missingContracts={string.Join(", ", missingContracts)}\n"
                + $"orphanContracts={string.Join(", ", orphanContracts)}");
        }

        List<ObservationOperation> operations = [];
        HashSet<string> operationIds = new(StringComparer.Ordinal);
        foreach (string key in observedByKey.Keys.OrderBy(static value => value, StringComparer.Ordinal))
        {
            ObservedOperation live = observedByKey[key];
            AedsEndpointContract contract = byKey[key];
            if (!live.Contract.IsAeds)
            {
                throw new InvalidOperationException(
                    $"{key} compiled endpoint is not an AEDS frame contract: "
                    + $"contentType={live.Contract.ContentType} resultPlacement={live.Contract.ResultPlacement}");
            }
            RequireEqual(key, "operationId", contract.OperationId, live.Contract.OperationId);
            RequireEqual(key, "requestFrame", contract.RequestFrame, live.Contract.RequestFrame);
            RequireEqual(key, "responseFrame", contract.ResponseFrame, live.Contract.ResponseFrame);
            RequireEqual(key, "errorFrame", contract.ErrorFrame, live.Contract.ErrorFrame);
            RequireEqual(key, "successStatus", contract.SuccessStatus, live.Contract.SuccessStatus);
            string operationId = live.Contract.OperationId;
            if (!operationIds.Add(operationId))
            {
                throw new InvalidOperationException($"duplicate operationId after merge: {operationId}");
            }

            if (string.IsNullOrWhiteSpace(contract.ResponseFrame))
            {
                throw new InvalidOperationException($"{key} missing responseFrame");
            }

            if (!string.Equals(contract.ErrorFrame, "ApiError", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{key} errorFrame must be ApiError");
            }

            IReadOnlyDictionary<int, IReadOnlyList<string>> publicErrorEvidence = live.CompiledErrorStatusEvidence
                .Where(pair => pair.Key != contract.SuccessStatus)
                .ToDictionary(static pair => pair.Key, static pair => pair.Value);

            OperationRequestContract request = BuildRequest(
                live.Contract.RequestFrame,
                operationId,
                live.RequestTypes,
                live.RequestParameters);
            string? actualRequestType = request.SourceTypes.SingleOrDefault();
            string? actualEncoding = live.Contract.RequestFrame is null ? null : request.Encoding;
            if (!string.Equals(contract.RequestType, actualRequestType, StringComparison.Ordinal)
                || !string.Equals(contract.RequestEncoding, actualEncoding, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"{key} compiled request/shared contract conflict: "
                    + $"contract={contract.RequestType ?? "none"}/{contract.RequestEncoding ?? "none"} "
                    + $"compiled={actualRequestType ?? "none"}/{actualEncoding ?? "none"}");
            }

            operations.Add(new ObservationOperation
            {
                Method = live.Method,
                // Prefer live endpoint template (includes route constraints) as implementation fact.
                Path = live.Path,
                OperationId = operationId,
                Protocol = contracts.Protocol,
                AedsVersion = contracts.AedsVersion,
                RequestFrame = live.Contract.RequestFrame,
                ResponseFrame = live.Contract.ResponseFrame!,
                ErrorFrame = live.Contract.ErrorFrame!,
                Auth = live.Auth,
                CredentialPolicy = live.CredentialPolicy,
                Permission = live.Permission,
                Pow = live.Pow,
                RateLimit = live.RateLimit,
                Cache = live.Cache,
                SuccessStatus = live.Contract.SuccessStatus!.Value,
                Request = request,
                Responses = BuildResponses(live.Contract, publicErrorEvidence.Keys),
                PublicErrorRefs = BuildPublicErrorRefs(publicErrorEvidence.Keys),
                PublicErrorStatuses = publicErrorEvidence.Keys.Order().ToArray(),
                PublicErrorStatusEvidence = publicErrorEvidence.ToDictionary(
                    static pair => pair.Key.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    static pair => pair.Value,
                    StringComparer.Ordinal),
                PublicErrorRefState = "operation-status-authority-bound",
                ErrorAuthorityBehaviorId = "configuration-error-security-policy",
                ResultPlacement = live.Contract.ResultPlacement,
                ProtocolState = "active-aeds-only",
                SourceIdentity = live.SourceIdentity
            });
        }

        var document = new ObservationDocument
        {
            Schema = "fsusblog.api-aeds-observation.v5",
            Protocol = contracts.Protocol,
            AedsVersion = contracts.AedsVersion,
            OperationCount = operations.Count,
            OperationKeys = operations.Select(static item => MatchKey(item.Method, item.Path)).ToArray(),
            Operations = operations,
            ProtocolStates = protocolStates,
            ErrorAuthority = errorAuthority,
            EndpointContractAuthority = new EndpointContractAuthorityBinding(
                contracts.Schema,
                "src/shared/Contracts/Validation/aeds-endpoint-contracts.json",
                contracts.ContentDigest),
            ObservationDigest = string.Empty
        };

        string digest = ObservationDigest.Compute(document);

        return new ObservationDocument
        {
            Schema = document.Schema,
            Protocol = document.Protocol,
            AedsVersion = document.AedsVersion,
            OperationCount = document.OperationCount,
            OperationKeys = document.OperationKeys,
            Operations = document.Operations,
            ProtocolStates = document.ProtocolStates,
            ErrorAuthority = document.ErrorAuthority,
            EndpointContractAuthority = document.EndpointContractAuthority,
            ObservationDigest = digest
        };
    }

    private static IReadOnlyList<OperationResponseContract> BuildResponses(
        CompiledEndpointContract contract,
        IEnumerable<int> errorStatuses)
    {
        List<OperationResponseContract> responses =
        [
            new OperationResponseContract(
                contract.SuccessStatus,
                "success",
                $"aeds://frame/{contract.ResponseFrame}",
                contract.ContentType,
                contract.ResultPlacement,
                false,
                null)
        ];
        responses.AddRange(errorStatuses
            .Distinct()
            .Where(static status => status is >= 400 and <= 599)
            .Order()
            .Select(status => new OperationResponseContract(
                status,
                "error",
                $"aeds://frame/{contract.ErrorFrame}",
                contract.ContentType,
                contract.ResultPlacement,
                false,
                PublicErrorRef(status))));
        if (responses.Count == 1)
        {
            throw new InvalidOperationException($"{contract.OperationId} has no observed public error status");
        }
        return responses;
    }

    private static IReadOnlyList<string> BuildPublicErrorRefs(IEnumerable<int> statuses)
        => statuses
            .Distinct()
            .Where(static status => status is >= 400 and <= 599)
            .Order()
            .Select(PublicErrorRef)
            .ToArray();

    private static string PublicErrorRef(int status)
        => $"configuration-error-security-policy:error-transport-mappings:{status}";

    private static void RequireEqual<T>(string key, string field, T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            string expectedText = expected is null ? "none" : expected.ToString() ?? "none";
            string actualText = actual is null ? "none" : actual.ToString() ?? "none";
            throw new InvalidOperationException(
                $"{key} compiled/shared {field} conflict: contract={expectedText} compiled={actualText}");
        }
    }

    private static OperationRequestContract BuildRequest(
        string? requestFrame,
        string operationId,
        IReadOnlyList<ObservedRequestType> requestTypes,
        IReadOnlyList<RequestParameterContract> requestParameters)
        => RequestContractObserver.Build(requestFrame, operationId, requestParameters, requestTypes);

    internal static string MatchKey(string method, string path)
        => $"{method.ToUpperInvariant()} {StripRouteConstraints(path)}";

    internal static string StripRouteConstraints(string path)
        => System.Text.RegularExpressions.Regex.Replace(
            path,
            @"\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}",
            "{$1}");
}

internal static class ObservationDigest
{
    public static string Compute(ObservationDocument document)
    {
        // Keep these property names and ordering explicit. The digest predates the public
        // camel-case projection and is intentionally over this PascalCase canonical payload.
        string canonical = System.Text.Json.JsonSerializer.Serialize(new
        {
            document.Schema,
            document.Protocol,
            document.AedsVersion,
            document.OperationCount,
            document.OperationKeys,
            Operations = document.Operations,
            document.ProtocolStates,
            document.ErrorAuthority,
            document.EndpointContractAuthority
        });
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
}
