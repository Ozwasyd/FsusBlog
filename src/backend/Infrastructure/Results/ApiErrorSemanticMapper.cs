using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

public enum ApiErrorTransportMappingId
{
    None,
    Generic400Validation,
    Generic401Unauthorized,
    Generic403Forbidden,
    Generic404NotFound,
    Generic405InfraFailure,
    Generic406InfraFailure,
    Generic409Conflict,
    Generic410InfraFailure,
    Generic411InfraFailure,
    Generic413InfraFailure,
    Generic415InfraFailure,
    Generic422InfraFailure,
    Generic423Forbidden,
    Generic426InfraFailure,
    Generic428InfraFailure,
    Generic429InfraFailure,
    Generic500InfraFailure,
    Generic501InfraFailure,
    Generic503InfraFailure,
    Default400Validation,
    Default401Unauthorized,
    Default403Forbidden,
    Default404NotFound,
    Default409Conflict,
    Default500InfraFailure,
    Default500Unknown,
    Operation401Validation,
    Operation403Validation,
    Operation406Validation,
    Operation409Validation,
    Operation410Validation,
    Operation411Validation,
    Operation413Validation,
    Operation422Validation,
    Operation423Validation,
    Operation426Validation,
    Operation428Validation,
    Operation428Forbidden,
    Operation429Validation,
    Operation429Forbidden,
    Operation503Validation,
    Operation503Forbidden
}

internal enum ApiErrorTransportMappingKind
{
    GenericStatusDefault,
    ErrorCodeDefaultStatus,
    OperationStatusPair
}

internal static class ApiErrorSemanticMapper
{
    private const string RequestFailedMessage = "Request failed";

    private static readonly IReadOnlyList<TransportMapping> s_transportMappings =
        ValidateCatalog(
        [
            Generic(ApiErrorTransportMappingId.Generic400Validation, StatusCodes.Status400BadRequest, ErrorCode.Validation, "Bad Request"),
            Generic(ApiErrorTransportMappingId.Generic401Unauthorized, StatusCodes.Status401Unauthorized, ErrorCode.Unauthorized, "Unauthorized"),
            Generic(ApiErrorTransportMappingId.Generic403Forbidden, StatusCodes.Status403Forbidden, ErrorCode.Forbidden, "Forbidden"),
            Generic(ApiErrorTransportMappingId.Generic404NotFound, StatusCodes.Status404NotFound, ErrorCode.NotFound, "Not Found"),
            Generic(ApiErrorTransportMappingId.Generic405InfraFailure, StatusCodes.Status405MethodNotAllowed, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic406InfraFailure, StatusCodes.Status406NotAcceptable, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic409Conflict, StatusCodes.Status409Conflict, ErrorCode.Conflict, "Conflict"),
            Generic(ApiErrorTransportMappingId.Generic410InfraFailure, StatusCodes.Status410Gone, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic411InfraFailure, StatusCodes.Status411LengthRequired, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic413InfraFailure, StatusCodes.Status413PayloadTooLarge, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic415InfraFailure, StatusCodes.Status415UnsupportedMediaType, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic422InfraFailure, StatusCodes.Status422UnprocessableEntity, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic423Forbidden, StatusCodes.Status423Locked, ErrorCode.Forbidden, "Locked"),
            Generic(ApiErrorTransportMappingId.Generic426InfraFailure, StatusCodes.Status426UpgradeRequired, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic428InfraFailure, StatusCodes.Status428PreconditionRequired, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic429InfraFailure, StatusCodes.Status429TooManyRequests, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic500InfraFailure, StatusCodes.Status500InternalServerError, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic501InfraFailure, StatusCodes.Status501NotImplemented, ErrorCode.InfraFailure),
            Generic(ApiErrorTransportMappingId.Generic503InfraFailure, StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure),
            Default(ApiErrorTransportMappingId.Default400Validation, StatusCodes.Status400BadRequest, ErrorCode.Validation),
            Default(ApiErrorTransportMappingId.Default401Unauthorized, StatusCodes.Status401Unauthorized, ErrorCode.Unauthorized),
            Default(ApiErrorTransportMappingId.Default403Forbidden, StatusCodes.Status403Forbidden, ErrorCode.Forbidden),
            Default(ApiErrorTransportMappingId.Default404NotFound, StatusCodes.Status404NotFound, ErrorCode.NotFound),
            Default(ApiErrorTransportMappingId.Default409Conflict, StatusCodes.Status409Conflict, ErrorCode.Conflict),
            Default(ApiErrorTransportMappingId.Default500InfraFailure, StatusCodes.Status500InternalServerError, ErrorCode.InfraFailure),
            Default(ApiErrorTransportMappingId.Default500Unknown, StatusCodes.Status500InternalServerError, ErrorCode.Unknown),
            Operation(ApiErrorTransportMappingId.Operation401Validation, StatusCodes.Status401Unauthorized, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation403Validation, StatusCodes.Status403Forbidden, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation406Validation, StatusCodes.Status406NotAcceptable, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation409Validation, StatusCodes.Status409Conflict, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation410Validation, StatusCodes.Status410Gone, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation411Validation, StatusCodes.Status411LengthRequired, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation413Validation, StatusCodes.Status413PayloadTooLarge, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation422Validation, StatusCodes.Status422UnprocessableEntity, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation423Validation, StatusCodes.Status423Locked, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation426Validation, StatusCodes.Status426UpgradeRequired, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation428Validation, StatusCodes.Status428PreconditionRequired, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation428Forbidden, StatusCodes.Status428PreconditionRequired, ErrorCode.Forbidden),
            Operation(ApiErrorTransportMappingId.Operation429Validation, StatusCodes.Status429TooManyRequests, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation429Forbidden, StatusCodes.Status429TooManyRequests, ErrorCode.Forbidden),
            Operation(ApiErrorTransportMappingId.Operation503Validation, StatusCodes.Status503ServiceUnavailable, ErrorCode.Validation),
            Operation(ApiErrorTransportMappingId.Operation503Forbidden, StatusCodes.Status503ServiceUnavailable, ErrorCode.Forbidden)
        ]);

    private static readonly IReadOnlyList<int> s_statusMappingKeys =
        BuildStatusMappingKeys(s_transportMappings);

    public static IReadOnlyList<TransportMapping> TransportMappings => s_transportMappings;

    public static IReadOnlyList<int> StatusMappingKeys => s_statusMappingKeys;

    public static IReadOnlyList<TransportMapping> GenericStatusErrorMappings
    {
        get;
    } =
        Array.AsReadOnly(s_transportMappings.Where(static mapping => mapping.Kind == ApiErrorTransportMappingKind.GenericStatusDefault).ToArray());

    public static ApiErrorTransportMappingId GetDefaultMappingId(ErrorCode errorCode)
    {
        foreach (TransportMapping mapping in s_transportMappings)
        {
            if (mapping.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus
                && mapping.ErrorCode == errorCode)
            {
                return mapping.Id;
            }
        }

        return ApiErrorTransportMappingId.Default500InfraFailure;
    }

    public static ApiErrorTransportMappingId GetGenericMappingId(int statusCode)
    {
        foreach (TransportMapping mapping in s_transportMappings)
        {
            if (mapping.Kind == ApiErrorTransportMappingKind.GenericStatusDefault
                && mapping.HttpStatus == statusCode)
            {
                return mapping.Id;
            }
        }

        throw new InvalidOperationException(
            $"Unregistered generic ApiError status mapping: HTTP {statusCode}.");
    }

    public static ApiErrorTransportMappingId RequireTransportMappingId(int statusCode, ErrorCode errorCode)
    {
        TransportMapping[] candidates = s_transportMappings
            .Where(mapping => mapping.HttpStatus == statusCode && mapping.ErrorCode == errorCode)
            .ToArray();
        if (candidates.Length == 0)
        {
            throw new InvalidOperationException($"Unregistered ApiError transport mapping: HTTP {statusCode}/{errorCode}.");
        }

        foreach (TransportMapping candidate in candidates)
        {
            if (candidate.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus)
            {
                return candidate.Id;
            }
        }

        return candidates[0].Id;
    }

    public static TransportMapping GetMapping(ApiErrorTransportMappingId mappingId)
    {
        foreach (TransportMapping mapping in s_transportMappings)
        {
            if (mapping.Id == mappingId)
            {
                return mapping;
            }
        }

        throw new InvalidOperationException($"Unknown ApiError transport mapping ID: {mappingId}.");
    }

    public static TransportMapping ValidateError(ApiErrorTransportMappingId mappingId, in ErrorDetail error)
    {
        TransportMapping mapping = GetMapping(mappingId);
        if (error.Code != mapping.ErrorCode)
        {
            throw new InvalidOperationException(
                $"ApiError transport mapping {mappingId} requires {mapping.ErrorCode}, received {error.Code}.");
        }

        return mapping;
    }

    public static int MapStatusCode(in ErrorDetail error)
        => GetMapping(GetDefaultMappingId(error.Code)).HttpStatus;

    public static ErrorDetail CreateError(
        ApiErrorTransportMappingId mappingId,
        string? message = null,
        string? traceId = null,
        string? details = null)
    {
        TransportMapping mapping = GetMapping(mappingId);
        return ErrorDetail.Create(
            mapping.ErrorCode,
            string.IsNullOrWhiteSpace(message) ? mapping.DefaultMessage : message,
            details,
            traceId);
    }

    internal static IReadOnlyList<TransportMapping> ValidateCatalog(IReadOnlyList<TransportMapping> mappings)
    {
        if (mappings.Count == 0)
        {
            throw new InvalidOperationException("ApiError transport mapping catalog must not be empty.");
        }

        EnsureUnique(mappings, static mapping => mapping.Id, "mapping ID");
        EnsureUnique(mappings, static mapping => (mapping.Kind, mapping.HttpStatus, mapping.ErrorCode), "typed mapping tuple");
        EnsureUnique(
            mappings.Where(static mapping => mapping.Kind == ApiErrorTransportMappingKind.GenericStatusDefault),
            static mapping => mapping.HttpStatus,
            "generic status");
        EnsureUnique(
            mappings.Where(static mapping => mapping.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus),
            static mapping => mapping.ErrorCode,
            "default ErrorCode");

        ApiErrorTransportMappingId[] expectedIds = Enum.GetValues<ApiErrorTransportMappingId>()
            .Where(static id => id != ApiErrorTransportMappingId.None)
            .ToArray();
        if (mappings.Count != expectedIds.Length
            || expectedIds.Any(id => mappings.All(mapping => mapping.Id != id)))
        {
            throw new InvalidOperationException("ApiError transport mapping IDs and catalog entries must match exactly.");
        }

        foreach (TransportMapping mapping in mappings)
        {
            if (mapping.HttpStatus is < 400 or > 599
                || mapping.ErrorCode == ErrorCode.None
                || (mapping.ErrorCode == ErrorCode.Unknown
                    && mapping.Kind != ApiErrorTransportMappingKind.ErrorCodeDefaultStatus)
                || string.IsNullOrWhiteSpace(mapping.DefaultMessage))
            {
                throw new InvalidOperationException($"Invalid ApiError transport mapping {mapping.Id}.");
            }
        }

        RequireExactMapping(
            mappings,
            ApiErrorTransportMappingId.Generic500InfraFailure,
            ApiErrorTransportMappingKind.GenericStatusDefault,
            StatusCodes.Status500InternalServerError,
            ErrorCode.InfraFailure);
        RequireExactMapping(
            mappings,
            ApiErrorTransportMappingId.Default500InfraFailure,
            ApiErrorTransportMappingKind.ErrorCodeDefaultStatus,
            StatusCodes.Status500InternalServerError,
            ErrorCode.InfraFailure);
        RequireExactMapping(
            mappings,
            ApiErrorTransportMappingId.Default500Unknown,
            ApiErrorTransportMappingKind.ErrorCodeDefaultStatus,
            StatusCodes.Status500InternalServerError,
            ErrorCode.Unknown);

        IReadOnlyList<int> statusMappingKeys = BuildStatusMappingKeys(mappings);
        int[] genericStatusKeys = mappings
            .Where(static mapping => mapping.Kind == ApiErrorTransportMappingKind.GenericStatusDefault)
            .Select(static mapping => mapping.HttpStatus)
            .Order()
            .ToArray();
        if (!statusMappingKeys.SequenceEqual(genericStatusKeys))
        {
            throw new InvalidOperationException(
                "Every ApiError transport status must have exactly one generic status mapping.");
        }

        return Array.AsReadOnly(mappings.ToArray());
    }

    internal static IReadOnlyList<int> ValidateStatusMappingKeys(
        IReadOnlyList<TransportMapping> mappings,
        IReadOnlyList<int> statusMappingKeys)
    {
        if (statusMappingKeys.Count == 0)
        {
            throw new InvalidOperationException("ApiError status mapping keys must not be empty.");
        }

        for (int index = 0; index < statusMappingKeys.Count; index++)
        {
            int status = statusMappingKeys[index];
            if (status is < 400 or > 599)
            {
                throw new InvalidOperationException($"Invalid ApiError status mapping key: {status}.");
            }

            if (index > 0 && status <= statusMappingKeys[index - 1])
            {
                throw new InvalidOperationException(
                    "ApiError status mapping keys must be strictly ascending and unique.");
            }
        }

        int[] expected = mappings
            .Select(static mapping => mapping.HttpStatus)
            .Distinct()
            .Order()
            .ToArray();
        if (!expected.SequenceEqual(statusMappingKeys))
        {
            throw new InvalidOperationException(
                "ApiError status mapping keys and transport mapping statuses must match exactly.");
        }

        return Array.AsReadOnly(statusMappingKeys.ToArray());
    }

    private static IReadOnlyList<int> BuildStatusMappingKeys(IReadOnlyList<TransportMapping> mappings)
    {
        int[] keys = mappings
            .Select(static mapping => mapping.HttpStatus)
            .Distinct()
            .Order()
            .ToArray();
        return ValidateStatusMappingKeys(mappings, keys);
    }

    private static void EnsureUnique<T>(IEnumerable<TransportMapping> mappings, Func<TransportMapping, T> key, string description)
        where T : notnull
    {
        if (mappings.GroupBy(key).FirstOrDefault(static group => group.Count() > 1) is { } duplicate)
        {
            throw new InvalidOperationException($"Duplicate ApiError transport {description}: {duplicate.Key}.");
        }
    }

    private static void RequireExactMapping(
        IReadOnlyList<TransportMapping> mappings,
        ApiErrorTransportMappingId id,
        ApiErrorTransportMappingKind kind,
        int status,
        ErrorCode code)
    {
        if (mappings.Count(mapping =>
                mapping.Id == id
                && mapping.Kind == kind
                && mapping.HttpStatus == status
                && mapping.ErrorCode == code) != 1)
        {
            throw new InvalidOperationException($"Missing canonical ApiError transport mapping {id}.");
        }
    }

    private static TransportMapping Generic(
        ApiErrorTransportMappingId id,
        int status,
        ErrorCode code,
        string defaultMessage = RequestFailedMessage)
        => new(id, ApiErrorTransportMappingKind.GenericStatusDefault, status, code, defaultMessage);

    private static TransportMapping Default(ApiErrorTransportMappingId id, int status, ErrorCode code)
        => new(id, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, status, code, RequestFailedMessage);

    private static TransportMapping Operation(ApiErrorTransportMappingId id, int status, ErrorCode code)
        => new(id, ApiErrorTransportMappingKind.OperationStatusPair, status, code, RequestFailedMessage);

    internal readonly record struct TransportMapping(
        ApiErrorTransportMappingId Id,
        ApiErrorTransportMappingKind Kind,
        int HttpStatus,
        ErrorCode ErrorCode,
        string DefaultMessage);
}
