using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Shared.Contracts.Governance;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ApiErrorSemanticMapperTests
{
    [Theory]
    [InlineData(ApiErrorTransportMappingId.Generic400Validation, 400, ErrorCode.Validation)]
    [InlineData(ApiErrorTransportMappingId.Generic401Unauthorized, 401, ErrorCode.Unauthorized)]
    [InlineData(ApiErrorTransportMappingId.Generic403Forbidden, 403, ErrorCode.Forbidden)]
    [InlineData(ApiErrorTransportMappingId.Generic404NotFound, 404, ErrorCode.NotFound)]
    [InlineData(ApiErrorTransportMappingId.Generic405InfraFailure, 405, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic406InfraFailure, 406, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic409Conflict, 409, ErrorCode.Conflict)]
    [InlineData(ApiErrorTransportMappingId.Generic410InfraFailure, 410, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic411InfraFailure, 411, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic413InfraFailure, 413, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic415InfraFailure, 415, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic422InfraFailure, 422, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic423Forbidden, 423, ErrorCode.Forbidden)]
    [InlineData(ApiErrorTransportMappingId.Generic426InfraFailure, 426, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic428InfraFailure, 428, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic429InfraFailure, 429, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic500InfraFailure, 500, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic501InfraFailure, 501, ErrorCode.InfraFailure)]
    [InlineData(ApiErrorTransportMappingId.Generic503InfraFailure, 503, ErrorCode.InfraFailure)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void GenericStatus_EnumerationLookupEnvelopeAndErrorCreationAgree(
        ApiErrorTransportMappingId mappingId,
        int status,
        ErrorCode expected)
    {
        ApiErrorSemanticMapper.TransportMapping mapping = Assert.Single(
            ApiErrorSemanticMapper.GenericStatusErrorMappings,
            mapping => mapping.HttpStatus == status);
        Assert.Equal(mappingId, mapping.Id);
        Assert.Equal(expected, mapping.ErrorCode);
        Assert.Equal(mappingId, ApiErrorSemanticMapper.GetGenericMappingId(status));
        Assert.Equal(mappingId, new BinaryEnvelopePolicy().GetGenericMappingId(status));
        ErrorDetail error = ApiErrorSemanticMapper.CreateError(mappingId, "original-message", "trace", "details");
        Assert.Equal(expected, error.Code);
        Assert.Equal("original-message", error.Message);
        Assert.Equal("trace", error.TraceId);
        Assert.Equal("details", error.Details);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary, InvariantId = "transport-authority-finite-immutable")]
    public void GenericStatus_EnumerationIsFiniteExactAndImmutable()
    {
        int[] expected = [400, 401, 403, 404, 405, 406, 409, 410, 411, 413, 415, 422, 423, 426, 428, 429, 500, 501, 503];
        Assert.Equal(expected, ApiErrorSemanticMapper.StatusMappingKeys);
        Assert.Equal(expected, ApiErrorSemanticMapper.GenericStatusErrorMappings.Select(static mapping => mapping.HttpStatus).Order());
        AssertImmutable(ApiErrorSemanticMapper.StatusMappingKeys, 599);
        ApiErrorSemanticMapper.TransportMapping extra = new(
            ApiErrorTransportMappingId.None,
            ApiErrorTransportMappingKind.GenericStatusDefault,
            599,
            ErrorCode.InfraFailure,
            "unregistered");
        AssertImmutable(ApiErrorSemanticMapper.GenericStatusErrorMappings, extra);
        AssertImmutable(ApiErrorSemanticMapper.TransportMappings, extra);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(200)]
    [InlineData(399)]
    [InlineData(416)]
    [InlineData(418)]
    [InlineData(599)]
    [InlineData(600)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "unknown-status-not-public-authority")]
    public void UnknownStatus_MapperAndEnvelopeRefuseUnregisteredAuthority(int status)
    {
        Assert.DoesNotContain(status, ApiErrorSemanticMapper.StatusMappingKeys);
        Assert.DoesNotContain(ApiErrorSemanticMapper.GenericStatusErrorMappings, mapping => mapping.HttpStatus == status);
        Assert.Throws<InvalidOperationException>(() => ApiErrorSemanticMapper.GetGenericMappingId(status));
        Assert.Throws<InvalidOperationException>(() => new BinaryEnvelopePolicy().GetGenericMappingId(status));
    }

    [Theory]
    [InlineData(ErrorCode.None, 500)]
    [InlineData(ErrorCode.Validation, 400)]
    [InlineData(ErrorCode.NotFound, 404)]
    [InlineData(ErrorCode.Conflict, 409)]
    [InlineData(ErrorCode.Unauthorized, 401)]
    [InlineData(ErrorCode.Forbidden, 403)]
    [InlineData(ErrorCode.InfraFailure, 500)]
    [InlineData(ErrorCode.Unknown, 500)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ReverseMapping_PreservesOriginalIndependentPolicy(ErrorCode code, int status)
    {
        Assert.Equal(status, ApiErrorSemanticMapper.MapStatusCode(ErrorDetail.Create(code, "original")));
    }

    private static void AssertImmutable<T>(IReadOnlyList<T> values, T extra)
    {
        T[] expected = values.ToArray();
        IList<T> list = Assert.IsAssignableFrom<IList<T>>(values);
        Assert.True(list.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => list.Add(extra));
        Assert.Throws<NotSupportedException>(() => list[0] = extra);
        Assert.Throws<NotSupportedException>(() => list.RemoveAt(0));
        Assert.Equal(expected, values);
    }
}
