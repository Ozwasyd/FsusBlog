using System.Net;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.Governance;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class ProductionStartupValidatorTests
{
    private static string DefaultJwtSecretSample
        => string.Concat("Were_I_you", "_I_would_get_high_like_some_airplanes");

    private static string LocalReleaseJwtSecretSample
        => string.Concat("Local_Release", "_Smoke_Key_For_FsusBlog_2026_Only");

    private static string RiskPseudonymKey
        => Convert.ToBase64String(Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray());

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Mutation)]
    public void ApiErrorSemanticMapper_TransportMappings_AreExactAndExecutable()
    {
        (ApiErrorTransportMappingId Id, ApiErrorTransportMappingKind Kind, int HttpStatus, ErrorCode ErrorCode)[] expected =
        [
            (ApiErrorTransportMappingId.Generic400Validation, ApiErrorTransportMappingKind.GenericStatusDefault, 400, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Generic401Unauthorized, ApiErrorTransportMappingKind.GenericStatusDefault, 401, ErrorCode.Unauthorized),
            (ApiErrorTransportMappingId.Generic403Forbidden, ApiErrorTransportMappingKind.GenericStatusDefault, 403, ErrorCode.Forbidden),
            (ApiErrorTransportMappingId.Generic404NotFound, ApiErrorTransportMappingKind.GenericStatusDefault, 404, ErrorCode.NotFound),
            (ApiErrorTransportMappingId.Generic405InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 405, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic406InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 406, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic409Conflict, ApiErrorTransportMappingKind.GenericStatusDefault, 409, ErrorCode.Conflict),
            (ApiErrorTransportMappingId.Generic410InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 410, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic411InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 411, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic413InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 413, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic415InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 415, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic422InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 422, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic423Forbidden, ApiErrorTransportMappingKind.GenericStatusDefault, 423, ErrorCode.Forbidden),
            (ApiErrorTransportMappingId.Generic426InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 426, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic428InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 428, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic429InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 429, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic500InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 500, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic501InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 501, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Generic503InfraFailure, ApiErrorTransportMappingKind.GenericStatusDefault, 503, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Default400Validation, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 400, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Default401Unauthorized, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 401, ErrorCode.Unauthorized),
            (ApiErrorTransportMappingId.Default403Forbidden, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 403, ErrorCode.Forbidden),
            (ApiErrorTransportMappingId.Default404NotFound, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 404, ErrorCode.NotFound),
            (ApiErrorTransportMappingId.Default409Conflict, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 409, ErrorCode.Conflict),
            (ApiErrorTransportMappingId.Default500InfraFailure, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 500, ErrorCode.InfraFailure),
            (ApiErrorTransportMappingId.Default500Unknown, ApiErrorTransportMappingKind.ErrorCodeDefaultStatus, 500, ErrorCode.Unknown),
            (ApiErrorTransportMappingId.Operation401Validation, ApiErrorTransportMappingKind.OperationStatusPair, 401, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation403Validation, ApiErrorTransportMappingKind.OperationStatusPair, 403, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation406Validation, ApiErrorTransportMappingKind.OperationStatusPair, 406, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation409Validation, ApiErrorTransportMappingKind.OperationStatusPair, 409, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation410Validation, ApiErrorTransportMappingKind.OperationStatusPair, 410, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation411Validation, ApiErrorTransportMappingKind.OperationStatusPair, 411, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation413Validation, ApiErrorTransportMappingKind.OperationStatusPair, 413, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation422Validation, ApiErrorTransportMappingKind.OperationStatusPair, 422, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation423Validation, ApiErrorTransportMappingKind.OperationStatusPair, 423, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation426Validation, ApiErrorTransportMappingKind.OperationStatusPair, 426, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation428Validation, ApiErrorTransportMappingKind.OperationStatusPair, 428, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation428Forbidden, ApiErrorTransportMappingKind.OperationStatusPair, 428, ErrorCode.Forbidden),
            (ApiErrorTransportMappingId.Operation429Validation, ApiErrorTransportMappingKind.OperationStatusPair, 429, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation429Forbidden, ApiErrorTransportMappingKind.OperationStatusPair, 429, ErrorCode.Forbidden),
            (ApiErrorTransportMappingId.Operation503Validation, ApiErrorTransportMappingKind.OperationStatusPair, 503, ErrorCode.Validation),
            (ApiErrorTransportMappingId.Operation503Forbidden, ApiErrorTransportMappingKind.OperationStatusPair, 503, ErrorCode.Forbidden)
        ];

        Assert.Equal(
            expected,
            ApiErrorSemanticMapper.TransportMappings
                .Select(static mapping => (mapping.Id, mapping.Kind, mapping.HttpStatus, mapping.ErrorCode)));
        Assert.Equal(
            [400, 401, 403, 404, 405, 406, 409, 410, 411, 413, 415, 422, 423, 426, 428, 429, 500, 501, 503],
            ApiErrorSemanticMapper.StatusMappingKeys);
        Assert.All(
            ApiErrorSemanticMapper.TransportMappings,
            static mapping =>
            {
                Assert.False(string.IsNullOrWhiteSpace(mapping.DefaultMessage));
                Assert.Equal(mapping, ApiErrorSemanticMapper.GetMapping(mapping.Id));
            });
        Assert.Equal(
            expected.Where(static mapping => mapping.Kind == ApiErrorTransportMappingKind.GenericStatusDefault),
            ApiErrorSemanticMapper.GenericStatusErrorMappings
                .Select(static mapping => (mapping.Id, mapping.Kind, mapping.HttpStatus, mapping.ErrorCode)));
        Assert.All(
            ApiErrorSemanticMapper.GenericStatusErrorMappings,
            static mapping => Assert.Equal(
                mapping.Id,
                ApiErrorSemanticMapper.GetGenericMappingId(mapping.HttpStatus)));
        Assert.All(
            ApiErrorSemanticMapper.TransportMappings.Where(
                static mapping => mapping.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus),
            static mapping =>
            {
                Assert.Equal(mapping.Id, ApiErrorSemanticMapper.GetDefaultMappingId(mapping.ErrorCode));
                ErrorDetail error = ApiErrorSemanticMapper.CreateError(mapping.Id);
                Assert.Equal(mapping.HttpStatus, ApiErrorSemanticMapper.MapStatusCode(error));
            });
        foreach (IGrouping<(int HttpStatus, ErrorCode ErrorCode), ApiErrorSemanticMapper.TransportMapping> pair in
            ApiErrorSemanticMapper.TransportMappings.GroupBy(
                static mapping => (mapping.HttpStatus, mapping.ErrorCode)))
        {
            ApiErrorSemanticMapper.TransportMapping expectedMapping = pair
                .OrderBy(static mapping => mapping.Kind switch
                {
                    ApiErrorTransportMappingKind.OperationStatusPair => 0,
                    ApiErrorTransportMappingKind.ErrorCodeDefaultStatus => 1,
                    _ => 2
                })
                .First();
            Assert.Equal(
                expectedMapping.Id,
                ApiErrorSemanticMapper.RequireTransportMappingId(pair.Key.HttpStatus, pair.Key.ErrorCode));
        }

        const ApiErrorTransportMappingId FallbackId = ApiErrorTransportMappingId.Generic500InfraFailure;
        foreach (string? missingMessage in new[] { null, string.Empty, "  " })
        {
            ErrorDetail fallback = ApiErrorSemanticMapper.CreateError(
                FallbackId,
                missingMessage,
                "trace-fallback",
                "details-fallback");
            Assert.Equal(ErrorCode.InfraFailure, fallback.Code);
            Assert.Equal("Request failed", fallback.Message);
            Assert.Equal("trace-fallback", fallback.TraceId);
            Assert.Equal("details-fallback", fallback.Details);
        }

        ErrorDetail explicitMessage = ApiErrorSemanticMapper.CreateError(
            FallbackId,
            "Explicit failure",
            "trace-explicit",
            "details-explicit");
        Assert.Equal("Explicit failure", explicitMessage.Message);
        Assert.Equal("trace-explicit", explicitMessage.TraceId);
        Assert.Equal("details-explicit", explicitMessage.Details);
        InvalidOperationException unregistered = Assert.Throws<InvalidOperationException>(() =>
            ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status418ImATeapot, ErrorCode.InfraFailure));
        Assert.Equal("Unregistered ApiError transport mapping: HTTP 418/InfraFailure.", unregistered.Message);
        InvalidOperationException unknownGeneric = Assert.Throws<InvalidOperationException>(() =>
            ApiErrorSemanticMapper.GetGenericMappingId(StatusCodes.Status418ImATeapot));
        Assert.Equal("Unregistered generic ApiError status mapping: HTTP 418.", unknownGeneric.Message);
        InvalidOperationException mismatch = Assert.Throws<InvalidOperationException>(() =>
            ApiErrorSemanticMapper.ValidateError(
                ApiErrorTransportMappingId.Operation428Forbidden,
                ErrorDetail.Create(ErrorCode.Validation, "wrong-code")));
        Assert.Equal(
            "ApiError transport mapping Operation428Forbidden requires Forbidden, received Validation.",
            mismatch.Message);
        InvalidOperationException unknownId = Assert.Throws<InvalidOperationException>(
            () => ApiErrorSemanticMapper.GetMapping(ApiErrorTransportMappingId.None));
        Assert.Equal("Unknown ApiError transport mapping ID: None.", unknownId.Message);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Mutation)]
    public void ApiErrorSemanticMapper_CatalogValidation_RejectsDuplicateMissingAndExtraAuthority()
    {
        ApiErrorSemanticMapper.TransportMapping[] canonical = [.. ApiErrorSemanticMapper.TransportMappings];

        static InvalidOperationException Reject(ApiErrorSemanticMapper.TransportMapping[] mappings)
            => Assert.Throws<InvalidOperationException>(() => ApiErrorSemanticMapper.ValidateCatalog(mappings));

        Assert.Equal(
            "ApiError transport mapping catalog must not be empty.",
            Reject([]).Message);
        Assert.Equal(
            "Duplicate ApiError transport mapping ID: Generic400Validation.",
            Reject([.. canonical, canonical[0]]).Message);
        Assert.Equal(
            "ApiError transport mapping IDs and catalog entries must match exactly.",
            Reject(canonical[..^1]).Message);
        Assert.Equal(
            "ApiError transport mapping IDs and catalog entries must match exactly.",
            Reject(
        [
            .. canonical,
            new(
                ApiErrorTransportMappingId.None,
                ApiErrorTransportMappingKind.OperationStatusPair,
                StatusCodes.Status418ImATeapot,
                ErrorCode.Validation,
                "invalid extra")
        ]).Message);

        ApiErrorSemanticMapper.TransportMapping[] duplicateTuple = [.. canonical];
        duplicateTuple[^1] = duplicateTuple[^1] with
        {
            HttpStatus = duplicateTuple[^2].HttpStatus,
            ErrorCode = duplicateTuple[^2].ErrorCode
        };
        Assert.StartsWith(
            "Duplicate ApiError transport typed mapping tuple:",
            Reject(duplicateTuple).Message,
            StringComparison.Ordinal);

        ApiErrorSemanticMapper.TransportMapping[] duplicateGenericStatus = [.. canonical];
        duplicateGenericStatus[1] = duplicateGenericStatus[1] with
        {
            HttpStatus = duplicateGenericStatus[0].HttpStatus
        };
        Assert.Equal(
            "Duplicate ApiError transport generic status: 400.",
            Reject(duplicateGenericStatus).Message);

        ApiErrorSemanticMapper.TransportMapping[] duplicateReverseCode = [.. canonical];
        int firstReverse = Array.FindIndex(
            duplicateReverseCode,
            static mapping => mapping.Kind == ApiErrorTransportMappingKind.ErrorCodeDefaultStatus);
        duplicateReverseCode[firstReverse + 1] = duplicateReverseCode[firstReverse + 1] with
        {
            ErrorCode = duplicateReverseCode[firstReverse].ErrorCode
        };
        Assert.Equal(
            "Duplicate ApiError transport default ErrorCode: Validation.",
            Reject(duplicateReverseCode).Message);

        ApiErrorSemanticMapper.TransportMapping[] mismatchedIds = [.. canonical];
        mismatchedIds[^1] = mismatchedIds[^1] with
        {
            Id = ApiErrorTransportMappingId.None
        };
        Assert.Equal(
            "ApiError transport mapping IDs and catalog entries must match exactly.",
            Reject(mismatchedIds).Message);

        ApiErrorSemanticMapper.TransportMapping[] lowStatus = [.. canonical];
        lowStatus[^1] = lowStatus[^1] with
        {
            HttpStatus = 399
        };
        Assert.Equal(
            "Invalid ApiError transport mapping Operation503Forbidden.",
            Reject(lowStatus).Message);

        ApiErrorSemanticMapper.TransportMapping[] highStatus = [.. canonical];
        highStatus[^1] = highStatus[^1] with
        {
            HttpStatus = 600
        };
        Assert.Equal(
            "Invalid ApiError transport mapping Operation503Forbidden.",
            Reject(highStatus).Message);

        ApiErrorSemanticMapper.TransportMapping[] upperBoundaryStatus = canonical
            .Select(static mapping => mapping.HttpStatus == StatusCodes.Status503ServiceUnavailable
                ? mapping with
                {
                    HttpStatus = 599
                }
                : mapping)
            .ToArray();
        Assert.Equal(upperBoundaryStatus, ApiErrorSemanticMapper.ValidateCatalog(upperBoundaryStatus));

        ApiErrorSemanticMapper.TransportMapping[] noneCode = [.. canonical];
        noneCode[^1] = noneCode[^1] with
        {
            ErrorCode = ErrorCode.None
        };
        Assert.Equal(
            "Invalid ApiError transport mapping Operation503Forbidden.",
            Reject(noneCode).Message);

        ApiErrorSemanticMapper.TransportMapping[] operationUnknown = [.. canonical];
        operationUnknown[^1] = operationUnknown[^1] with
        {
            ErrorCode = ErrorCode.Unknown
        };
        Assert.Equal(
            "Invalid ApiError transport mapping Operation503Forbidden.",
            Reject(operationUnknown).Message);

        ApiErrorSemanticMapper.TransportMapping[] blankMessage = [.. canonical];
        blankMessage[^1] = blankMessage[^1] with
        {
            DefaultMessage = " "
        };
        Assert.Equal(
            "Invalid ApiError transport mapping Operation503Forbidden.",
            Reject(blankMessage).Message);

        ApiErrorSemanticMapper.TransportMapping[] wrongGeneric500 = [.. canonical];
        int generic500 = Array.FindIndex(
            wrongGeneric500,
            static mapping => mapping.Id == ApiErrorTransportMappingId.Generic500InfraFailure);
        wrongGeneric500[generic500] = wrongGeneric500[generic500] with
        {
            Kind = ApiErrorTransportMappingKind.OperationStatusPair
        };
        Assert.Equal(
            "Missing canonical ApiError transport mapping Generic500InfraFailure.",
            Reject(wrongGeneric500).Message);

        ApiErrorSemanticMapper.TransportMapping[] wrongDefault500 = [.. canonical];
        int default500 = Array.FindIndex(
            wrongDefault500,
            static mapping => mapping.Id == ApiErrorTransportMappingId.Default500InfraFailure);
        wrongDefault500[default500] = wrongDefault500[default500] with
        {
            HttpStatus = 502
        };
        Assert.Equal(
            "Missing canonical ApiError transport mapping Default500InfraFailure.",
            Reject(wrongDefault500).Message);

        ApiErrorSemanticMapper.TransportMapping[] wrongUnknown500 = [.. canonical];
        int unknown500 = Array.FindIndex(
            wrongUnknown500,
            static mapping => mapping.Id == ApiErrorTransportMappingId.Default500Unknown);
        wrongUnknown500[unknown500] = wrongUnknown500[unknown500] with
        {
            HttpStatus = 502
        };
        Assert.Equal(
            "Missing canonical ApiError transport mapping Default500Unknown.",
            Reject(wrongUnknown500).Message);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "api-error-status-mapping-exact-roster")]
    public void ApiErrorSemanticMapper_CatalogValidation_RejectsUndefinedErrorCode()
    {
        ApiErrorSemanticMapper.TransportMapping[] canonical = [.. ApiErrorSemanticMapper.TransportMappings];
        Assert.Equal(canonical, ApiErrorSemanticMapper.ValidateCatalog(canonical));
        int index = Array.FindIndex(canonical,
            static mapping => mapping.Id == ApiErrorTransportMappingId.Operation503Forbidden);
        Assert.True(index >= 0);
        Assert.Equal(ErrorCode.Forbidden, canonical[index].ErrorCode);

        ApiErrorSemanticMapper.TransportMapping[] undefinedCode = [.. canonical];
        undefinedCode[index] = undefinedCode[index] with
        {
            ErrorCode = (ErrorCode)byte.MaxValue
        };
        Assert.False(Enum.IsDefined(undefinedCode[index].ErrorCode));
        Assert.Equal(canonical.Select(static mapping => mapping.Id),
            undefinedCode.Select(static mapping => mapping.Id));
        Assert.Equal(canonical.Select(static mapping => mapping.HttpStatus),
            undefinedCode.Select(static mapping => mapping.HttpStatus));
        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => ApiErrorSemanticMapper.ValidateCatalog(undefinedCode));
        Assert.Equal("Invalid ApiError transport mapping Operation503Forbidden.", exception.Message);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "api-error-status-mapping-exact-roster")]
    public void ApiErrorSemanticMapper_CatalogValidation_RejectsUndefinedMappingKind()
    {
        ApiErrorSemanticMapper.TransportMapping[] canonical = [.. ApiErrorSemanticMapper.TransportMappings];
        Assert.Equal(canonical, ApiErrorSemanticMapper.ValidateCatalog(canonical));
        int index = Array.FindIndex(canonical,
            static mapping => mapping.Id == ApiErrorTransportMappingId.Operation503Forbidden);
        Assert.True(index >= 0);
        Assert.Equal(ApiErrorTransportMappingKind.OperationStatusPair, canonical[index].Kind);

        ApiErrorSemanticMapper.TransportMapping[] undefinedKind = [.. canonical];
        undefinedKind[index] = undefinedKind[index] with
        {
            Kind = (ApiErrorTransportMappingKind)int.MaxValue
        };
        Assert.False(Enum.IsDefined(undefinedKind[index].Kind));
        Assert.Equal(canonical.Select(static mapping => mapping.Id),
            undefinedKind.Select(static mapping => mapping.Id));
        Assert.Equal(canonical.Select(static mapping => mapping.HttpStatus),
            undefinedKind.Select(static mapping => mapping.HttpStatus));
        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => ApiErrorSemanticMapper.ValidateCatalog(undefinedKind));
        Assert.Equal("Invalid ApiError transport mapping Operation503Forbidden.", exception.Message);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "api-error-status-mapping-exact-roster")]
    public void ApiErrorSemanticMapper_StatusMappingKeys_RejectMissingExtraUnsortedAndEveryStatusOmission()
    {
        ApiErrorSemanticMapper.TransportMapping[] mappings = [.. ApiErrorSemanticMapper.TransportMappings];
        int[] keys = [.. ApiErrorSemanticMapper.StatusMappingKeys];

        static InvalidOperationException Reject(
            IReadOnlyList<ApiErrorSemanticMapper.TransportMapping> candidateMappings,
            IReadOnlyList<int> candidateKeys)
            => Assert.Throws<InvalidOperationException>(() =>
                ApiErrorSemanticMapper.ValidateStatusMappingKeys(candidateMappings, candidateKeys));

        Assert.Equal(
            "ApiError status mapping keys must not be empty.",
            Reject(mappings, []).Message);
        Assert.Equal(
            "ApiError status mapping keys and transport mapping statuses must match exactly.",
            Reject(mappings, keys[..^1]).Message);
        Assert.Equal(
            "ApiError status mapping keys and transport mapping statuses must match exactly.",
            Reject(mappings, [.. keys, StatusCodes.Status504GatewayTimeout]).Message);

        int[] unsorted = [.. keys];
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        Assert.Equal(
            "ApiError status mapping keys must be strictly ascending and unique.",
            Reject(mappings, unsorted).Message);

        int[] duplicate = [keys[0], .. keys];
        Assert.Equal(
            "ApiError status mapping keys must be strictly ascending and unique.",
            Reject(mappings, duplicate).Message);

        foreach (int status in keys)
        {
            ApiErrorSemanticMapper.TransportMapping[] omitted = mappings
                .Where(mapping => mapping.HttpStatus != status)
                .ToArray();
            Assert.Equal(
                "ApiError status mapping keys and transport mapping statuses must match exactly.",
                Reject(omitted, keys).Message);
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AcceptsProductionConfigurationWithHttpsAndRedisPassword()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:RotationWindowDays"] = "30",
            ["AllowedHosts"] = "example.com;www.example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["Security:Pow:SigningKey"] = TestSecrets.PowSigningKey,
            [UserSessionPolicy.MaxActiveSessionsConfigurationKey] = "10",
            [MfaChallengeService.ProofFreshnessMinutesConfigurationKey] = "5",
            ["AuthEnrollment:ProvisionalTtlMinutes"] = "20",
            ["AuthEnrollment:CleanupIntervalMinutes"] = "5",
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k1",
            ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64),
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = RiskPseudonymKey,
            ["Security:RecoveryKeyPepper"] = TestSecrets.RecoveryKeyPepper,
            ["PublicAot:ManifestToken"] = "public-aot-manifest-token-with-enough-entropy",
            ["MfaChallenge:TicketSigningKey"] = TestSecrets.MfaTicketSigningKey,
            ["HumanReadProof:SigningKey"] = TestSecrets.HumanReadProofSigningKey,
            ["HumanReadProof:Dedup:CurrentKeyEpoch"] = "1",
            ["HumanReadProof:Dedup:CurrentKey"] = TestSecrets.HumanReadProofDedupKey,
            [ReadAnalyticsPrivacyPolicy.NoiseKeySetting] = TestSecrets.ReadAnalyticsNoiseKey,
            ["Audit:TamperEvidenceKey"] = TestSecrets.AuditTamperEvidenceKey,
            ["Audit:DetachedCheckpoint:Enabled"] = "true",
            ["Audit:DetachedCheckpoint:DirectoryName"] = "audit-checkpoints",
            ["Audit:DetachedCheckpoint:IntervalSeconds"] = "300",
            ["Audit:DetachedCheckpoint:MaxRecords"] = "1000",
            ["Audit:DetachedCheckpoint:CurrentKeyId"] = "audit-checkpoint-2026-07",
            ["Audit:DetachedCheckpoint:Keys:0:KeyId"] = "audit-checkpoint-2026-07",
            ["Audit:DetachedCheckpoint:Keys:0:Version"] = "1",
            ["Audit:DetachedCheckpoint:Keys:0:PublicKeyPath"] = "/run/secrets/fsusblog-audit-checkpoint-public.der",
            ["Audit:DetachedCheckpoint:Keys:0:PrivateKeyPath"] = "/run/secrets/fsusblog-audit-checkpoint-private.der",
            ["Audit:DetachedCheckpoint:Keys:0:NotBeforeUtc"] = "2026-07-01T00:00:00Z",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "1",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = TestSecrets.VisitLogIpPseudonymKey,
            ["Moderation:RegionPolicy:IpHashKey"] = TestSecrets.RegionIpHashKey,
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Subscription:EmailHashPepper"] = TestSecrets.SubscriptionEmailHashPepper,
            [MessageAdminSessionAuditReference.KeyName] = TestSecrets.MessageAdminSessionAuditReferenceKey,
            ["AnonymousIdentity:NullifierPepper"] = TestSecrets.AnonymousNullifierPepper,
            ["AnonymousCredentialRoot:AttestationKey"] = TestSecrets.AnonymousRootAttestationKey,
            ["DataProtection:ApplicationName"] = "FsusBlog",
            ["DataProtection:KeyRingPath"] = "/var/lib/fsusblog/shared/data-protection/keyring",
            ["DataProtection:KeyProtection:Mode"] = "Certificate",
            ["DataProtection:KeyProtection:CurrentCertificate:Path"] = "/run/secrets/fsusblog-data-protection-current.pfx",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["FSUSBLOG_RELEASE_ID"] = "20260711010101-0123456789ab",
            ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = "2026-07-11T01:01:01Z",
            ["FSUSBLOG_RELEASE_SLOT"] = "candidate",
            ["FSUSBLOG_COMMIT_SHA"] = "0123456789abcdef0123456789abcdef01234567",
            ["FSUSBLOG_IMAGE_DIGEST"] = $"sha256:{new string('a', 64)}",
            ["FSUSBLOG_IMAGE_REF"] = $"ghcr.io/fsusblog/app@sha256:{new string('a', 64)}",
            [ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey] = "5000",
            [ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey] = "30",
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = "1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Empty(errors);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-local-demo-fixture-gates-disabled")]
    public void ValidateCore_RejectsLocalDemoPrepareAndCleanupGatesOutsideDevelopment()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey] = "true",
            [LocalDemoFixtureEndpoints.AllowLocalDemoFixtureCleanupConfigurationKey] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains("fsus:allowLocalDemoFixture must be false outside Development.", errors);
        Assert.Contains("fsus:allowLocalDemoFixtureCleanup must be false outside Development.", errors);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-local-security-fixture-gate-disabled")]
    public void ValidateCore_RejectsLocalSecurityFixtureGateOutsideDevelopment()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains("fsus:allowLocalSecurityFixture must be false outside Development.", errors);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary, InvariantId = "session-limit-boundary")]
    public void ValidateCore_RejectsOutOfRangeActiveUserSessionLimit()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [UserSessionPolicy.MaxActiveSessionsConfigurationKey] = "51"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(UserSessionPolicy.MaxActiveSessionsConfigurationKey, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-session-metadata-retention-range")]
    public void ValidateCore_RejectsOutOfRangeUserSessionMetadataRetention()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [UserSessionMetadataRetentionPolicy.RetentionDaysConfigurationKey] = "91"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(
            errors,
            error => error.Contains(UserSessionMetadataRetentionPolicy.RetentionDaysConfigurationKey, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-step-up-freshness-range")]
    public void ValidateCore_RejectsOutOfRangeStepUpFreshness()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [MfaChallengeService.ProofFreshnessMinutesConfigurationKey] = "16"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(MfaChallengeService.ProofFreshnessMinutesConfigurationKey, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AcceptsBoundedIndependentPreviousJwtKey()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:PreviousKeys:0:Version"] = "v1-2026-01",
            ["Jwt:PreviousKeys:0:Key"] = TestSecrets.SecondaryJwtSigningKey,
            ["Jwt:PreviousKeys:0:AcceptUntilUtc"] = DateTimeOffset.UtcNow.AddDays(7).ToString("O")
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Empty(errors);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "risk-pseudonym-key-required")]
    public void ValidateCore_RejectsMissingWeakOrReusedRiskPseudonymKey()
    {
        IReadOnlyList<string> missing = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [SecurityRiskPseudonymizer.CurrentKeyKey] = null
            }),
            enforceProductionRules: true);
        IReadOnlyList<string> weak = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [SecurityRiskPseudonymizer.CurrentKeyKey] = Convert.ToBase64String(new byte[32])
            }),
            enforceProductionRules: true);
        IReadOnlyList<string> reused = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [SecurityRiskPseudonymizer.CurrentKeyKey] = TestSecrets.JwtSigningKey
            }),
            enforceProductionRules: true);

        Assert.Contains(missing, static error => error.Contains(SecurityRiskPseudonymizer.CurrentKeyKey, StringComparison.Ordinal));
        Assert.Contains(weak, static error => error.Contains("strong base64", StringComparison.Ordinal));
        Assert.Contains(reused, static error => error.Contains("must not reuse Jwt:SecretKey", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "message-admin-audit-key-independent-strong")]
    public void ValidateCore_RejectsMissingWeakOrJwtReusedMessageAdminSessionAuditReferenceKey()
    {
        IReadOnlyList<string> missing = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [MessageAdminSessionAuditReference.KeyName] = null
            }),
            enforceProductionRules: true);
        IReadOnlyList<string> weak = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [MessageAdminSessionAuditReference.KeyName] = "weak"
            }),
            enforceProductionRules: true);
        IReadOnlyList<string> reused = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [MessageAdminSessionAuditReference.KeyName] = TestSecrets.JwtSigningKey
            }),
            enforceProductionRules: true);

        Assert.Contains(missing, static error => error.Contains(MessageAdminSessionAuditReference.KeyName, StringComparison.Ordinal));
        Assert.Contains(weak, static error => error.Contains("at least 32 characters", StringComparison.Ordinal));
        Assert.Contains(reused, static error => error.Contains("must not equal Jwt:SecretKey", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "jwt-previous-key-rotation-bounded-independent")]
    public void ValidateCore_RejectsDuplicateWeakOrUnboundedPreviousJwtKey()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:PreviousKeys:0:Version"] = "v2-2026-07",
            ["Jwt:PreviousKeys:0:Key"] = "weak",
            ["Jwt:PreviousKeys:0:AcceptUntilUtc"] = DateTimeOffset.UtcNow.AddDays(31).ToString("O")
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("PreviousKeys:0:Version", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("PreviousKeys:0:Key", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RotationWindowDays", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-jwt-key-version-required")]
    public void ValidateCore_RejectsMissingOrDevelopmentJwtKeyVersion()
    {
        IReadOnlyList<string> missingErrors = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?> { ["Jwt:KeyVersion"] = null }),
            enforceProductionRules: true);
        IReadOnlyList<string> developmentErrors = ProductionStartupValidator.ValidateCore(
            CreateValidProductionConfiguration(new Dictionary<string, string?> { ["Jwt:KeyVersion"] = "dev-v2" }),
            enforceProductionRules: true);

        Assert.Contains(missingErrors, static error => error.Contains("Jwt:KeyVersion is required", StringComparison.Ordinal));
        Assert.Contains(developmentErrors, static error => error.Contains("development version", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("FSUSBLOG_RELEASE_ID", null)]
    [InlineData("FSUSBLOG_RELEASE_ID", "latest")]
    [InlineData("FSUSBLOG_RELEASE_SLOT", "Candidate Slot")]
    [InlineData("FSUSBLOG_COMMIT_SHA", "0123456789ab")]
    [InlineData("FSUSBLOG_IMAGE_DIGEST", "sha256:abc")]
    [InlineData("FSUSBLOG_IMAGE_REF", "ghcr.io/fsusblog/app:final-current")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-release-identity-immutable-consistent")]
    public void ValidateCore_RejectsMissingMutableOrInconsistentProductionReleaseIdentity(string key, string? value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Release identity invalid", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "http://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "https://internal-admin/api/secrets")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "http://www.bing.com/toolbox/bingbot.json")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "https://169.254.169.254/latest/meta-data/")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "crawler-range-source-url-trusted")]
    public void ValidateCore_RejectsUnsafeCrawlerRangeUrls(string key, string value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "https://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "https://www.bing.com/toolbox/bingbot.json")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AcceptsOfficialCrawlerRangeUrls(string key, string value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "enabled-antispam-native-runtime-required")]
    public void ValidateCore_RejectsEnabledAntiSpamModelWithoutValidBuiltInRuntime()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Moderation:AntiSpamModel:Enabled"] = "true",
            ["Moderation:AntiSpamModel:RuntimePath"] = "/missing/fsus-antispammodel",
            ["Moderation:AntiSpamModel:TrustedSigningKey"] = TestSecrets.ModerationPepper
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Moderation:AntiSpamModel:RuntimePath", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("fsus_antispam_runtime_missing", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "perception-sealed-token-signing-key-required")]
    public void ValidateCore_RejectsProductionPerceptionSealedTokenWithoutSigningKey()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionSealedToken:Keys:k1"] = null
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Security:PerceptionSealedToken:Keys:k1", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "perception-current-key-version-resolvable")]
    public void ValidateCore_RejectsProductionPerceptionSealedTokenStaleCurrentKeyVersion()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k2"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Security:PerceptionSealedToken:CurrentKeyVersion", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("k2", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-default-secret-and-insecure-origin-refused")]
    public void ValidateCore_RejectsProductionDefaultsAndInsecureOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=,abortConnect=false",
            ["Jwt:SecretKey"] = DefaultJwtSecretSample,
            ["AllowedHosts"] = "*",
            ["CORS_ALLOWED_HOSTS"] = "http://example.com",
            ["Seo:BaseUrl"] = "http://example.com",
            ["Fido2:ServerDomain"] = "localhost",
            ["Fido2:Origins:0"] = "http://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "1",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = "replace-with-base64-visit-log-key"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:Redis", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RedisOptions:Configuration", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Security:Pow:SigningKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Security:RecoveryKeyPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("PublicAot:ManifestToken", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains(VisitLogIpPseudonymizer.CurrentKeyKey, StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Moderation:Pepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Moderation:RegionPolicy:IpHashKey", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:Pow:SigningKey")]
    [InlineData("Security:RecoveryKeyPepper")]
    [InlineData("PublicAot:ManifestToken")]
    [InlineData("Audit:TamperEvidenceKey")]
    [InlineData("AnonymousCredentialIssuer:SubjectHashPepper")]
    [InlineData("VisitLog:IpPseudonymization:CurrentKey")]
    [InlineData("Moderation:RegionPolicy:IpHashKey")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-security-secret-required")]
    public void ValidateCore_RejectsProductionWhenIndependentSecuritySecretIsMissing(string key)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = null
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:Pow:SigningKey")]
    [InlineData("Security:RecoveryKeyPepper")]
    [InlineData("PublicAot:ManifestToken")]
    [InlineData("Audit:TamperEvidenceKey")]
    [InlineData("AnonymousCredentialIssuer:SubjectHashPepper")]
    [InlineData("VisitLog:IpPseudonymization:CurrentKey")]
    [InlineData("Moderation:RegionPolicy:IpHashKey")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-security-secret-independent-from-jwt")]
    public void ValidateCore_RejectsProductionSecuritySecretSharedWithJwtSecret(string key)
    {
        const string SharedSecret = "shared-jwt-secret-that-must-not-seed-other-security-domains";
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = SharedSecret,
            [key] = SharedSecret
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal)
            && error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("short-key")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "audit-tamper-evidence-key-strong")]
    public void ValidateCore_RejectsWeakAuditTamperEvidenceKey(string keyValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = keyValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Audit:TamperEvidenceKey", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Audit:DetachedCheckpoint:Enabled", "false")]
    [InlineData("Audit:DetachedCheckpoint:IntervalSeconds", "1")]
    [InlineData("Audit:DetachedCheckpoint:MaxRecords", "10001")]
    [InlineData("Audit:DetachedCheckpoint:CurrentKeyId", "missing-key")]
    [InlineData("Audit:DetachedCheckpoint:Keys:0:PrivateKeyPath", "relative-private.der")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "audit-detached-checkpoint-configuration-safe")]
    public void ValidateCore_RejectsUnsafeDetachedAuditCheckpointConfiguration(string key, string value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Audit:DetachedCheckpoint", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-security-secret-independent-from-jwt")]
    public void SecurityDomainSecrets_DoNotFallBackToJwtSecretOrHardCodedMaterial()
    {
        (Type Type, string Setting)[] securityDomains =
        [
            (typeof(AuditTamperEvidence), "Audit:TamperEvidenceKey"),
            (typeof(RedisPowService), "Security:Pow:SigningKey"),
            (typeof(RecoveryKeyService), "Security:RecoveryKeyPepper"),
            (typeof(BlindCredentialIssuanceService), "AnonymousCredentialIssuer:SubjectHashPepper"),
            (typeof(VisitLogIpPseudonymizer), "VisitLog:IpPseudonymization:CurrentKey"),
            (typeof(ClientRegionResolver), "Moderation:RegionPolicy:IpHashKey")
        ];

        foreach ((Type type, string setting) in securityDomains)
        {
            IConfiguration reusedJwt = CreateValidProductionConfiguration(new Dictionary<string, string?>
            {
                [setting] = TestSecrets.JwtSigningKey
            });
            IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(reusedJwt, enforceProductionRules: true);
            Assert.Contains(errors, error =>
                error.Contains(setting, StringComparison.Ordinal) &&
                error.Contains("Jwt:SecretKey", StringComparison.Ordinal));

            string runtimeShape = RuntimeMetadataInspection.DescribeType(type);
            Assert.DoesNotContain("Jwt:SecretKey", runtimeShape, StringComparison.Ordinal);
            Assert.DoesNotContain("Fallback:", runtimeShape, StringComparison.Ordinal);
            Assert.DoesNotContain("development-key", runtimeShape, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("development-anonymous-credential-subject-hash-pepper", runtimeShape, StringComparison.Ordinal);
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SharedAppsettings_DoesNotContainReusableJwtSecret()
    {
        IConfiguration appsettings = new ConfigurationBuilder()
            .SetBasePath(BackendTestPaths.FromRoot("src", "backend"))
            .AddJsonFile("appsettings.json", optional: false, reloadOnChange: false)
            .Build();

        Assert.NotEqual(DefaultJwtSecretSample, appsettings["Jwt:SecretKey"]);
        Assert.NotEqual(LocalReleaseJwtSecretSample, appsettings["Jwt:SecretKey"]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-insecure-startup-cannot-bypass-jwt-key")]
    public async Task HostedService_DoesNotBypassDefaultJwtSecretEvenWhenInsecureStartupAllowed()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = DefaultJwtSecretSample,
            ["FSUSBLOG_ALLOW_INSECURE_STARTUP"] = "true"
        });
        var runtimeState = new StartupRuntimeState();
        var service = new ProductionStartupValidationHostedService(
            configuration,
            new TestWebHostEnvironment(Environments.Production),
            new StaticZkProofVerifier(configured: false),
            new StaticRootReader(rootReady: false),
            new UnavailableRfc9474BlindCredentialSigner(configuration),
            new StaticBlindCredentialRuntimeGate(false),
            runtimeState,
            NullLogger<ProductionStartupValidationHostedService>.Instance);

        ProductionStartupValidationException ex = await Assert.ThrowsAsync<ProductionStartupValidationException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Contains(ex.Errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        StartupLifecycleTaskReport task = runtimeState.CreateSnapshot().Tasks["productionStartupValidation"];
        Assert.Equal("failed", task.Status);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-insecure-startup-cannot-bypass-key-protector")]
    public async Task HostedService_DoesNotBypassMissingDataProtectionProtectorWhenInsecureStartupAllowed()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["DataProtection:KeyProtection:Mode"] = null,
            ["DataProtection:KeyProtection:CurrentCertificate:Path"] = null,
            ["FSUSBLOG_ALLOW_INSECURE_STARTUP"] = "true"
        });
        var runtimeState = new StartupRuntimeState();
        var service = new ProductionStartupValidationHostedService(
            configuration,
            new TestWebHostEnvironment(Environments.Production),
            new StaticZkProofVerifier(configured: false),
            new StaticRootReader(rootReady: false),
            new UnavailableRfc9474BlindCredentialSigner(configuration),
            new StaticBlindCredentialRuntimeGate(false),
            runtimeState,
            NullLogger<ProductionStartupValidationHostedService>.Instance);

        ProductionStartupValidationException exception =
            await Assert.ThrowsAsync<ProductionStartupValidationException>(
                () => service.StartAsync(CancellationToken.None));

        Assert.Contains(exception.Errors, static error =>
            error.Contains("DataProtection:", StringComparison.Ordinal));
        Assert.Equal(
            "failed",
            runtimeState.CreateSnapshot().Tasks["productionStartupValidation"].Status);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("false")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-anonymous-identity-mode-required")]
    public void ValidateCore_RejectsProductionWhenAnonymousIdentityModeIsMissingOrDisabled(string? modeValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = modeValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(
            errors,
            static error => error.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("1")]
    [InlineData("true")]
    [InlineData("enabled")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AcceptsProductionWhenAnonymousIdentityModeIsEnabled(string modeValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = modeValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(
            errors,
            static error => error.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-auth-cookies-secure-transport")]
    public void ValidateCore_RejectsProductionInsecureAuthCookies()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:RotationWindowDays"] = "30",
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("AuthCookies:AllowInsecureTransportCookies", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_IgnoresRemovedLegacyPlainCookieReadSwitch()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["AuthCookies:AllowLegacyPlainCookieRead"] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(errors, static error => error.Contains("AuthCookies:AllowLegacyPlainCookieRead", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-required-settings-present")]
    public void ValidateCore_RejectsMissingRequiredProductionSettings()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:DefaultConnection", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:Redis", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RedisOptions:Configuration", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains(VisitLogIpPseudonymizer.CurrentKeyKey, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AllowsDevelopmentConfigurationToUseLocalDefaults()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: false);

        Assert.DoesNotContain(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-data-protection-protector-required")]
    public void ValidateCore_RejectsMissingProductionDataProtectionProtector()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["DataProtection:KeyProtection:Mode"] = null,
            ["DataProtection:KeyProtection:CurrentCertificate:Path"] = null
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains(errors, static error =>
            error.Contains("DataProtection:KeyProtection:Mode", StringComparison.Ordinal));
        Assert.Contains(errors, static error =>
            error.Contains("CurrentCertificate:Path", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "data-protection-protector-outside-keyring")]
    public void ValidateCore_RejectsProtectorCertificateStoredInsideSharedKeyRing()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["DataProtection:KeyProtection:CurrentCertificate:Path"] =
                "/var/lib/fsusblog/shared/data-protection/keyring/current.pfx"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains(errors, static error =>
            error.Contains("must not be stored inside", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void CreateValidationReport_ExposesVersionedSchemaRequirements()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);

        Assert.Equal(21, report.SchemaVersion);
        Assert.Equal(ProductionStartupValidator.CurrentSchema.Version, report.SchemaVersion);
        Assert.Equal(
            ProductionStartupValidator.CurrentSchema.RequiredSettings.Order(StringComparer.Ordinal),
            report.Requirements.Select(static requirement => requirement.Key).Order(StringComparer.Ordinal));
        Assert.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Jwt:SecretKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Jwt:KeyVersion", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Jwt:RotationWindowDays", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Audit:DetachedCheckpoint:Enabled", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AllowedHosts", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:ServerDomain", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:Origins", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:Pow:SigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:PerceptionSealedToken:CurrentKeyVersion", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:RecoveryKeyPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("PublicAot:ManifestToken", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("MfaChallenge:TicketSigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("HumanReadProof:SigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("HumanReadProof:Dedup:CurrentKeyEpoch", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("HumanReadProof:Dedup:CurrentKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(ReadAnalyticsPrivacyPolicy.NoiseKeySetting, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Audit:TamperEvidenceKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousCredentialIssuer:SubjectHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(VisitLogIpPseudonymizer.CurrentEpochKey, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(VisitLogIpPseudonymizer.CurrentKeyKey, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Moderation:RegionPolicy:IpHashKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Moderation:Pepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Subscription:EmailHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(MessageAdminSessionAuditReference.KeyName, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousIdentity:NullifierPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousCredentialRoot:AttestationKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("DataProtection:KeyProtection:Mode", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("DataProtection:KeyProtection:CurrentCertificate:Path", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.All(
            ProductionStartupValidator.CurrentSchema.DefaultJwtSecrets,
            static secret => Assert.StartsWith("sha256:", secret, StringComparison.Ordinal));
        Assert.DoesNotContain(
            ProductionStartupValidator.CurrentSchema.DefaultJwtSecrets,
            static secret => secret.Contains("MUST_BE_OVERRIDDEN", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(VisitLogIpPseudonymizer.CurrentKeyKey)]
    [InlineData(SecurityRiskPseudonymizer.CurrentKeyKey)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pseudonym-domain-key-material-independent")]
    public void ValidateCore_RejectsDedupKeyReuseAcrossPseudonymDomains(string reusedKeySetting)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["HumanReadProof:Dedup:CurrentKey"] = TestSecrets.HumanReadProofDedupKey,
            [reusedKeySetting] = TestSecrets.HumanReadProofDedupKey
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains(errors, error =>
            error.Contains("HumanReadProof:Dedup:CurrentKey", StringComparison.Ordinal)
            && error.Contains(reusedKeySetting, StringComparison.Ordinal)
            && error.Contains("independent key material", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("HumanReadProof:SigningKey", "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8=")]
    [InlineData("HumanReadProof:Dedup:CurrentKey", "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8=")]
    [InlineData(ReadAnalyticsPrivacyPolicy.NoiseKeySetting, "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-read-analytics-development-key-refused")]
    public void ValidateCore_RejectsCommittedDevelopmentReadAnalyticsKeysInProduction(
        string setting,
        string developmentValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [setting] = developmentValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);

        Assert.Contains(errors, error =>
            error.Contains(setting, StringComparison.Ordinal)
            && error.Contains("development/template/default", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-fido-origins-trusted-consistent")]
    public void ValidateCore_RejectsFido2OriginsThatDoNotMatchTrustedProductionOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:RotationWindowDays"] = "30",
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "login.example.com",
            ["Fido2:Origins:0"] = "https://evil.example",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["ReverseProxy:KnownProxies"] = "127.0.0.1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins must include Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins origin must also be listed", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-origin-host-coverage-required")]
    public void ValidateCore_RejectsAllowedHostsThatDoNotCoverTrustedProductionOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://www.example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["ReverseProxy:KnownProxies"] = "127.0.0.1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS host must be listed in AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins host must be listed in AllowedHosts", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-reverse-proxy-trust-bounded")]
    public void ValidateCore_RejectsUnsafeReverseProxyTrustEntries()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["ReverseProxy:KnownProxies"] = "0.0.0.0",
            ["ReverseProxy:KnownNetworks"] = "0.0.0.0/0"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("ReverseProxy:KnownProxies", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy:KnownNetworks", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ReverseProxyForwardedHeaders_ConfiguresExplicitTrustedProxiesAndNetworks()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownProxies"] = "127.0.0.1,::1",
            ["ReverseProxy:KnownNetworks"] = "10.0.0.0/8;172.16.0.0/12"
        });
        ForwardedHeadersOptions options = new();

        ReverseProxyForwardedHeaders.Configure(options, configuration, isProduction: true);

        Assert.Contains(IPAddress.Loopback, options.KnownProxies);
        Assert.Contains(IPAddress.IPv6Loopback, options.KnownProxies);
        Assert.Equal(2, options.KnownIPNetworks.Count);
    }

    [Theory]
    [InlineData("AnonymousIdentity:ZkProd:AllowDevVerifier")]
    [InlineData("AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-bypass-flags-forbidden")]
    public void ValidateCore_RejectsProductionZkProdUnsafeBypassFlagsEvenWhenZkProdDisabled(string key)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: false,
                CredentialRootReady: false));

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-native-verifier-required")]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutNativeVerifier()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: false,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("native verifier", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-trusted-setup-verified")]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutTrustedSetupVerification()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "false"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("trusted setup", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-trusted-setup-production-usable")]
    public void ValidateCore_RejectsProductionZkProdWhenManifestIsNotProductionUsable()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = "27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c",
            ["AnonymousIdentity:ZkProd:TrustedSetupManifestPath"] = "security/zk/provenance/comment-v5-trusted-setup.manifest.json",
            ["AnonymousIdentity:ZkProd:VerifyingKeyManifestPath"] = "config/zk/anonymous-comment-v5-verifying-key.manifest.json"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true,
                CredentialIssuerConfigured: true));

        Assert.Contains(errors, static error => error.Contains("trusted setup", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-credential-root-ready")]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutCredentialRootReadiness()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: false));

        Assert.Contains(errors, static error => error.Contains("credential root", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-credential-ready")]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutCredentialReadiness()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:CredentialReady"] = "false"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("blind credential", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "production-zk-credential-issuer-ready")]
    public void ValidateCore_RejectsProductionZkProdReadyWhenCredentialIssuerUnavailable()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("blind issuer", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ValidateCore_AcceptsProductionZkProdWhenAllConfiguredReadinessGatesPass()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true,
                CredentialIssuerConfigured: true));

        Assert.DoesNotContain(errors, static error => error.Contains("AnonymousIdentity:ZkProd", StringComparison.Ordinal));
    }

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static IConfiguration CreateValidProductionConfiguration(Dictionary<string, string?> overrides)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:RotationWindowDays"] = "30",
            ["AllowedHosts"] = "example.com;www.example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["Security:Pow:SigningKey"] = TestSecrets.PowSigningKey,
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k1",
            ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64),
            [SecurityRiskPseudonymizer.CurrentEpochKey] = "1",
            [SecurityRiskPseudonymizer.CurrentKeyKey] = RiskPseudonymKey,
            ["Security:RecoveryKeyPepper"] = TestSecrets.RecoveryKeyPepper,
            [UserSessionPolicy.MaxActiveSessionsConfigurationKey] = "10",
            [MfaChallengeService.ProofFreshnessMinutesConfigurationKey] = "5",
            ["AuthEnrollment:ProvisionalTtlMinutes"] = "20",
            ["AuthEnrollment:CleanupIntervalMinutes"] = "5",
            ["PublicAot:ManifestToken"] = "public-aot-manifest-token-with-enough-entropy",
            ["MfaChallenge:TicketSigningKey"] = TestSecrets.MfaTicketSigningKey,
            ["HumanReadProof:SigningKey"] = TestSecrets.HumanReadProofSigningKey,
            ["HumanReadProof:Dedup:CurrentKeyEpoch"] = "1",
            ["HumanReadProof:Dedup:CurrentKey"] = TestSecrets.HumanReadProofDedupKey,
            [ReadAnalyticsPrivacyPolicy.NoiseKeySetting] = TestSecrets.ReadAnalyticsNoiseKey,
            ["Audit:TamperEvidenceKey"] = TestSecrets.AuditTamperEvidenceKey,
            ["Audit:DetachedCheckpoint:Enabled"] = "true",
            ["Audit:DetachedCheckpoint:DirectoryName"] = "audit-checkpoints",
            ["Audit:DetachedCheckpoint:IntervalSeconds"] = "300",
            ["Audit:DetachedCheckpoint:MaxRecords"] = "1000",
            ["Audit:DetachedCheckpoint:CurrentKeyId"] = "audit-checkpoint-2026-07",
            ["Audit:DetachedCheckpoint:Keys:0:KeyId"] = "audit-checkpoint-2026-07",
            ["Audit:DetachedCheckpoint:Keys:0:Version"] = "1",
            ["Audit:DetachedCheckpoint:Keys:0:PublicKeyPath"] = "/run/secrets/fsusblog-audit-checkpoint-public.der",
            ["Audit:DetachedCheckpoint:Keys:0:PrivateKeyPath"] = "/run/secrets/fsusblog-audit-checkpoint-private.der",
            ["Audit:DetachedCheckpoint:Keys:0:NotBeforeUtc"] = "2026-07-01T00:00:00Z",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            [VisitLogIpPseudonymizer.CurrentEpochKey] = "1",
            [VisitLogIpPseudonymizer.CurrentKeyKey] = TestSecrets.VisitLogIpPseudonymKey,
            ["Moderation:RegionPolicy:IpHashKey"] = TestSecrets.RegionIpHashKey,
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Subscription:EmailHashPepper"] = TestSecrets.SubscriptionEmailHashPepper,
            [MessageAdminSessionAuditReference.KeyName] = TestSecrets.MessageAdminSessionAuditReferenceKey,
            ["AnonymousIdentity:NullifierPepper"] = TestSecrets.AnonymousNullifierPepper,
            ["AnonymousCredentialRoot:AttestationKey"] = TestSecrets.AnonymousRootAttestationKey,
            ["DataProtection:ApplicationName"] = "FsusBlog",
            ["DataProtection:KeyRingPath"] = "/var/lib/fsusblog/shared/data-protection/keyring",
            ["DataProtection:KeyProtection:Mode"] = "Certificate",
            ["DataProtection:KeyProtection:CurrentCertificate:Path"] = "/run/secrets/fsusblog-data-protection-current.pfx",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["FSUSBLOG_RELEASE_ID"] = "20260711010101-0123456789ab",
            ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = "2026-07-11T01:01:01Z",
            ["FSUSBLOG_RELEASE_SLOT"] = "candidate",
            ["FSUSBLOG_COMMIT_SHA"] = "0123456789abcdef0123456789abcdef01234567",
            ["FSUSBLOG_IMAGE_DIGEST"] = $"sha256:{new string('a', 64)}",
            ["FSUSBLOG_IMAGE_REF"] = $"ghcr.io/fsusblog/app@sha256:{new string('a', 64)}",
            [ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey] = "5000",
            [ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey] = "30",
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = "1"
        };

        foreach ((string key, string? value) in overrides)
        {
            values[key] = value;
        }

        return CreateConfiguration(values);
    }

    private static IConfiguration CreateZkProdProductionConfiguration(Dictionary<string, string?> overrides)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["AnonymousIdentity:ZkProd:Enabled"] = "true",
            ["AnonymousIdentity:ZkProd:RequireNativeVerifier"] = "true",
            ["AnonymousIdentity:ZkProd:RequireCredential"] = "true",
            ["AnonymousIdentity:ZkProd:RequireTrustedSetupVerified"] = "true",
            ["AnonymousIdentity:ZkProd:AllowDevVerifier"] = "false",
            ["AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous"] = "false",
            ["AnonymousIdentity:ZkProd:VerifierBackend"] = "native_groth16",
            ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "true",
            ["AnonymousIdentity:ZkProd:CredentialReady"] = "true",
            ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = "27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c"
        };

        foreach ((string key, string? value) in overrides)
        {
            values[key] = value;
        }

        return CreateValidProductionConfiguration(values);
    }

    private sealed class StaticZkProofVerifier(bool configured) : IZkProofVerifier
    {
        public bool IsConfigured { get; } = configured;

        public Task<ZkProofVerificationResult> VerifyAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(ZkProofVerificationResult.VerifierUnavailable());
    }

    private sealed class StaticRootReader : IAnonymousCredentialRootReader
    {
        public StaticRootReader(bool rootReady)
        {
            CurrentSnapshot = rootReady
                ? new AnonymousCredentialRootRuntimeSnapshot(
                    [
                        new AnonymousCredentialAcceptedRoot(
                            1,
                            "root-hash",
                            "revocation-root-hash",
                            new string('f', 64),
                            AnonymousCredentialRootStatuses.Active,
                            DateTimeOffset.UtcNow.AddHours(1))
                    ],
                    1,
                    DateTimeOffset.UtcNow)
                : AnonymousCredentialRootRuntimeSnapshot.Empty;
        }

        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot
        {
            get;
        }

        public Task RefreshAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch) => CurrentSnapshot.AcceptedRoots.Count > 0;

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => CurrentSnapshot.AcceptedRoots.Count > 0;
    }

    private sealed class StaticBlindCredentialRuntimeGate(bool enabled) : IBlindCredentialRuntimeGate
    {
        public bool IsEnabled { get; } = enabled;
        public TimeSpan GetEnvelopeDelay(TimeSpan elapsed) => TimeSpan.Zero;
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
