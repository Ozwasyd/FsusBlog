using Xunit;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Shared.Contracts.Governance;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ApiErrorSemanticMapperTests
{
    [Theory]
    [InlineData(400, ErrorCode.Validation)]
    [InlineData(401, ErrorCode.Unauthorized)]
    [InlineData(403, ErrorCode.Forbidden)]
    [InlineData(404, ErrorCode.NotFound)]
    [InlineData(405, ErrorCode.InfraFailure)]
    [InlineData(406, ErrorCode.InfraFailure)]
    [InlineData(409, ErrorCode.Conflict)]
    [InlineData(410, ErrorCode.InfraFailure)]
    [InlineData(411, ErrorCode.InfraFailure)]
    [InlineData(413, ErrorCode.InfraFailure)]
    [InlineData(415, ErrorCode.InfraFailure)]
    [InlineData(416, ErrorCode.InfraFailure)]
    [InlineData(422, ErrorCode.InfraFailure)]
    [InlineData(423, ErrorCode.Forbidden)]
    [InlineData(426, ErrorCode.InfraFailure)]
    [InlineData(428, ErrorCode.InfraFailure)]
    [InlineData(429, ErrorCode.InfraFailure)]
    [InlineData(500, ErrorCode.InfraFailure)]
    [InlineData(503, ErrorCode.InfraFailure)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void PublicStatus_EnumerationLookupEnvelopeAndErrorCreationAgree(int status, ErrorCode expected)
    {
        Assert.Equal(expected, ApiErrorSemanticMapper.PublicStatusMappings[status]);
        Assert.Equal(expected, ApiErrorSemanticMapper.MapErrorCode(status));
        Assert.Equal(expected, new BinaryEnvelopePolicy().MapErrorCode(status));
        ErrorDetail error = ApiErrorSemanticMapper.CreateError(status, "original-message", "trace", "details");
        Assert.Equal(expected, error.Code);
        Assert.Equal("original-message", error.Message);
        Assert.Equal("trace", error.TraceId);
        Assert.Equal("details", error.Details);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary, InvariantId = "transport-authority-finite-immutable")]
    public void PublicStatus_EnumerationIsFiniteExactAndImmutable()
    {
        int[] expected = [400, 401, 403, 404, 405, 406, 409, 410, 411, 413, 415, 416, 422, 423, 426, 428, 429, 500, 503];
        Assert.Equal(expected, ApiErrorSemanticMapper.PublicStatusMappings.Keys.Order());
        IDictionary<int, ErrorCode> dictionary = ApiErrorSemanticMapper.PublicStatusMappings;
        Assert.True(dictionary.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => dictionary.Add(599, ErrorCode.InfraFailure));
        Assert.Throws<NotSupportedException>(() => dictionary[400] = ErrorCode.InfraFailure);
        Assert.Throws<NotSupportedException>(() => dictionary.Remove(413));
        Assert.Equal(expected, ApiErrorSemanticMapper.PublicStatusMappings.Keys.Order());
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(200)]
    [InlineData(399)]
    [InlineData(418)]
    [InlineData(599)]
    [InlineData(600)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "unknown-status-not-public-authority")]
    public void UnknownStatus_FallbackDoesNotClaimPublicMembership(int status)
    {
        Assert.False(ApiErrorSemanticMapper.PublicStatusMappings.ContainsKey(status));
        Assert.Equal(ErrorCode.InfraFailure, ApiErrorSemanticMapper.MapErrorCode(status));
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
}
