using System.Text.Json.Serialization;

namespace FsusBlog.OpenApiObservation;

internal sealed record ObservedOperation(
    string Method,
    string Path,
    string OperationId,
    string Auth,
    string Permission,
    bool Pow,
    string RateLimit,
    string Cache,
    string? SourceIdentity);

internal sealed record AedsEndpointContract(
    string Method,
    string Path,
    string OperationId,
    string? RequestFrame,
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
                PropertyNameCaseInsensitive = true
            })
            ?? throw new InvalidOperationException($"failed to parse contracts catalog: {path}");

        if (!string.Equals(document.Schema, "fsusblog.aeds-endpoint-contracts.v1", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"unsupported contracts schema: {document.Schema}");
        }

        if (document.Operations is null || document.Operations.Count == 0)
        {
            throw new InvalidOperationException("contracts catalog has no operations");
        }

        return new AedsEndpointContractCatalog
        {
            Schema = document.Schema ?? throw new InvalidOperationException("contracts schema required"),
            Protocol = document.Protocol ?? "AEDS",
            AedsVersion = document.AedsVersion ?? 2,
            Operations = document.Operations
                .Select(static item => new AedsEndpointContract(
                    Method: (item.Method ?? throw new InvalidOperationException("contract method required")).ToUpperInvariant(),
                    Path: Normalize(item.Path),
                    OperationId: item.OperationId ?? throw new InvalidOperationException("contract operationId required"),
                    RequestFrame: NormalizeFrame(item.RequestFrame),
                    ResponseFrame: item.ResponseFrame ?? throw new InvalidOperationException("contract responseFrame required"),
                    ErrorFrame: item.ErrorFrame ?? "ApiError",
                    SuccessStatus: item.SuccessStatus ?? 200))
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
    string Source,
    string? SchemaRef,
    bool Required,
    bool Nullable,
    IReadOnlyList<string> RequiredFields,
    IReadOnlyList<RouteParameterContract> Parameters,
    string FieldSetState,
    string BoundsState,
    string UnionState);

internal sealed record RouteParameterContract(
    string Name,
    string Source,
    string SchemaRef,
    bool Required,
    bool Nullable);

internal sealed record OperationResponseContract(
    int? Status,
    string SchemaRef,
    string ContentType,
    string ResultPlacement,
    bool Nullable);

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
            string operationId = string.IsNullOrWhiteSpace(contract.OperationId)
                ? live.OperationId
                : contract.OperationId;
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

            operations.Add(new ObservationOperation
            {
                Method = live.Method,
                // Prefer live endpoint template (includes route constraints) as implementation fact.
                Path = live.Path,
                OperationId = operationId,
                Protocol = contracts.Protocol,
                AedsVersion = contracts.AedsVersion,
                RequestFrame = contract.RequestFrame,
                ResponseFrame = contract.ResponseFrame,
                ErrorFrame = contract.ErrorFrame,
                Auth = live.Auth,
                Permission = live.Permission,
                Pow = live.Pow,
                RateLimit = live.RateLimit,
                Cache = live.Cache,
                SuccessStatus = contract.SuccessStatus,
                Request = BuildRequest(contract.RequestFrame, live.Path),
                Responses =
                [
                    new OperationResponseContract(
                        contract.SuccessStatus,
                        $"aeds://frame/{contract.ResponseFrame}",
                        "application/octet-stream",
                        "aeds.frame.payload",
                        false),
                    new OperationResponseContract(
                        null,
                        $"aeds://frame/{contract.ErrorFrame}",
                        "application/octet-stream",
                        "aeds.frame.payload",
                        false)
                ],
                PublicErrorRefs = ["configuration-error-security-policy:error-transport-mappings:ApiError"],
                PublicErrorRefState = "transport-frame-authority-only",
                ErrorAuthorityBehaviorId = "configuration-error-security-policy",
                ResultPlacement = "aeds.frame.payload",
                ProtocolState = "active-aeds-only",
                SourceIdentity = live.SourceIdentity
            });
        }

        var document = new ObservationDocument
        {
            Schema = "fsusblog.api-aeds-observation.v2",
            Protocol = contracts.Protocol,
            AedsVersion = contracts.AedsVersion,
            OperationCount = operations.Count,
            OperationKeys = operations.Select(static item => MatchKey(item.Method, item.Path)).ToArray(),
            Operations = operations,
            ProtocolStates = protocolStates,
            ErrorAuthority = errorAuthority,
            ObservationDigest = string.Empty
        };

        string canonical = System.Text.Json.JsonSerializer.Serialize(new
        {
            document.Schema,
            document.Protocol,
            document.AedsVersion,
            document.OperationCount,
            document.OperationKeys,
            Operations = document.Operations,
            document.ProtocolStates,
            document.ErrorAuthority
        });
        string digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical)))
            .ToLowerInvariant();

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
            ObservationDigest = digest
        };
    }

    private static OperationRequestContract BuildRequest(string? requestFrame, string route)
    {
        IReadOnlyList<RouteParameterContract> parameters = System.Text.RegularExpressions.Regex
            .Matches(route, @"\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\}")
            .Select(match => new RouteParameterContract(
                match.Groups[1].Value,
                "path",
                match.Groups[2].Success ? $"route://{match.Groups[2].Value}" : "route://string",
                true,
                false))
            .ToArray();
        return new OperationRequestContract(
            requestFrame is null ? "none" : "aeds-frame-body",
            requestFrame is null ? null : $"aeds://frame/{requestFrame}",
            requestFrame is not null,
            false,
            [],
            parameters,
            requestFrame is null ? "not-applicable" : "opaque-aeds-frame",
            requestFrame is null ? "not-applicable" : "opaque-aeds-frame",
            requestFrame is null ? "not-applicable" : "opaque-aeds-frame");
    }

    internal static string MatchKey(string method, string path)
        => $"{method.ToUpperInvariant()} {StripRouteConstraints(path)}";

    internal static string StripRouteConstraints(string path)
        => System.Text.RegularExpressions.Regex.Replace(
            path,
            @"\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}",
            "{$1}");
}
