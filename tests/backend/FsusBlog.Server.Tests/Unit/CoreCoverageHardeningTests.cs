using System.Buffers;
using System.Data;
using System.Data.Common;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.DependencyInjection;
using FsusBlog.Core.Mapping.Readers;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Implementations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CoreCoverageHardeningTests
{
    [Fact]
    public void AddFsusBlogCore_RegistersExpectedServicesWithExpectedLifetimes()
    {
        var services = new ServiceCollection();
        IConfiguration configuration = new ConfigurationBuilder().Build();

        IServiceCollection returned = services.AddFsusBlogCore(configuration);

        Assert.Same(services, returned);
        AssertRegistration<IArticleCoreService, ArticleCoreService>(services, ServiceLifetime.Scoped);
        AssertRegistration<ICommentCoreService, CommentCoreService>(services, ServiceLifetime.Scoped);
        AssertRegistration<IUserCoreService, UserCoreService>(services, ServiceLifetime.Scoped);
        AssertRegistration<ISystemCoreService, SystemCoreService>(services, ServiceLifetime.Scoped);
        AssertRegistration<IStatsCoreService, StatsCoreService>(services, ServiceLifetime.Scoped);
        AssertRegistration<IAedsEncoder, AedsEncoder>(services, ServiceLifetime.Singleton);
        AssertRegistration<AedsDecoderValidator, AedsDecoderValidator>(services, ServiceLifetime.Singleton);
    }

    [Fact]
    public void PodRowMapper_MapsPrimitiveAndNullableValues()
    {
        using DbDataReader reader = CreateReader();
        Assert.True(reader.Read());

        int intOrdinal = PodRowMapper.Ordinal(reader, "IntCol");
        int longOrdinal = PodRowMapper.Ordinal(reader, "LongCol");
        int dateOrdinal = PodRowMapper.Ordinal(reader, "DateCol");
        int stringOrdinal = PodRowMapper.Ordinal(reader, "StringCol");
        int boolOrdinal = PodRowMapper.Ordinal(reader, "BoolCol");
        int nullableIntOrdinal = PodRowMapper.Ordinal(reader, "NullableIntCol");
        int nullableDateOrdinal = PodRowMapper.Ordinal(reader, "NullableDateCol");

        Assert.Equal(7, PodRowMapper.Int32(reader, intOrdinal));
        Assert.Equal(9L, PodRowMapper.Int64(reader, longOrdinal));
        Assert.Equal(new DateTime(2024, 1, 2, 3, 4, 5, DateTimeKind.Utc), PodRowMapper.DateTime(reader, dateOrdinal));
        Assert.Equal("hello", PodRowMapper.String(reader, stringOrdinal));
        Assert.True(PodRowMapper.Bool(reader, boolOrdinal));
        Assert.Equal(15, PodRowMapper.NullableInt32(reader, nullableIntOrdinal));
        Assert.Equal(new DateTime(2024, 2, 3, 0, 0, 0, DateTimeKind.Utc), PodRowMapper.NullableDateTime(reader, nullableDateOrdinal));
    }

    [Fact]
    public void PodRowMapper_ReturnsFallbacksForDBNull()
    {
        using DbDataReader reader = CreateReader();
        Assert.True(reader.Read());
        Assert.True(reader.Read());

        int stringOrdinal = PodRowMapper.Ordinal(reader, "StringCol");
        int boolOrdinal = PodRowMapper.Ordinal(reader, "BoolCol");
        int nullableIntOrdinal = PodRowMapper.Ordinal(reader, "NullableIntCol");
        int nullableDateOrdinal = PodRowMapper.Ordinal(reader, "NullableDateCol");

        Assert.Equal("fallback", PodRowMapper.String(reader, stringOrdinal, "fallback"));
        Assert.False(PodRowMapper.Bool(reader, boolOrdinal));
        Assert.Null(PodRowMapper.NullableInt32(reader, nullableIntOrdinal));
        Assert.Null(PodRowMapper.NullableDateTime(reader, nullableDateOrdinal));
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenDecodeFails()
    {
        var encoder = new FakeEncoder
        {
            DecodeResult = Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "decode-failed")
        };
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [1, 2, 3]);

        Assert.False(result.IsSuccess);
        Assert.Equal("decode-failed", result.Error.Message);
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenFrameTypeMismatches()
    {
        var encoder = FakeEncoder.Success(new AedsDecodeResult(
            CreateHeader(AedsFrameHeader.CurrentVersion, AedsFrameType.AdminStats, 0, 1),
            new byte[] { 7 },
            AedsFrameType.AdminStats));
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [7]);

        Assert.False(result.IsSuccess);
        Assert.Contains("frame type", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenVersionMismatches()
    {
        var encoder = FakeEncoder.Success(new AedsDecodeResult(
            CreateHeader(1, AedsFrameType.ArticleList, 0, 1),
            new byte[] { 7 },
            AedsFrameType.ArticleList));
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [7]);

        Assert.False(result.IsSuccess);
        Assert.Contains("version", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenFlagsMismatches()
    {
        var encoder = FakeEncoder.Success(new AedsDecodeResult(
            CreateHeader(AedsFrameHeader.CurrentVersion, AedsFrameType.ArticleList, 0xBEEFu, 1),
            new byte[] { 7 },
            AedsFrameType.ArticleList));
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [7], flags: 0xCAFEu);

        Assert.False(result.IsSuccess);
        Assert.Contains("flags", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenPayloadLengthMismatches()
    {
        var encoder = FakeEncoder.Success(new AedsDecodeResult(
            CreateHeader(AedsFrameHeader.CurrentVersion, AedsFrameType.ArticleList, 0, 2),
            new byte[] { 1, 2 },
            AedsFrameType.ArticleList));
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [1]);

        Assert.False(result.IsSuccess);
        Assert.Contains("size", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AedsDecoderValidator_ReturnsFailureWhenPayloadContentMismatches()
    {
        var encoder = FakeEncoder.Success(new AedsDecodeResult(
            CreateHeader(AedsFrameHeader.CurrentVersion, AedsFrameType.ArticleList, 0, 1),
            new byte[] { 9 },
            AedsFrameType.ArticleList));
        var validator = new AedsDecoderValidator(encoder);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [1]);

        Assert.False(result.IsSuccess);
        Assert.Contains("content", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static DbDataReader CreateReader()
    {
        var table = new DataTable();
        table.Columns.Add("IntCol", typeof(int));
        table.Columns.Add("LongCol", typeof(long));
        table.Columns.Add("DateCol", typeof(DateTime));
        table.Columns.Add("StringCol", typeof(string));
        table.Columns.Add("BoolCol", typeof(bool));
        table.Columns.Add("NullableIntCol", typeof(int));
        table.Columns.Add("NullableDateCol", typeof(DateTime));

        table.Rows.Add(7, 9L, new DateTime(2024, 1, 2, 3, 4, 5, DateTimeKind.Utc), "hello", true, 15, new DateTime(2024, 2, 3, 0, 0, 0, DateTimeKind.Utc));
        table.Rows.Add(5, 6L, new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc), DBNull.Value, DBNull.Value, DBNull.Value, DBNull.Value);
        return table.CreateDataReader();
    }

    private static void AssertRegistration<TService, TImplementation>(IServiceCollection services, ServiceLifetime lifetime)
    {
        ServiceDescriptor? descriptor = services.LastOrDefault(static item =>
            item.ServiceType == typeof(TService) && item.ImplementationType == typeof(TImplementation));
        Assert.NotNull(descriptor);
        Assert.Equal(lifetime, descriptor.Lifetime);
    }

    private static AedsFrameHeader CreateHeader(ushort version, AedsFrameType frameType, uint flags, uint payloadLength)
        => new(AedsEncoder.Magic, (byte)version, AedsFrameHeader.Size, (ushort)flags, (ushort)frameType, payloadLength, 0);

    private sealed class FakeEncoder : IAedsEncoder
    {
        public Result<AedsDecodeResult> DecodeResult { get; init; } = Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "decode-not-configured");

        public byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
            => [1, 2, 3];

        public void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
            => WriteHeader(frameType, payload, destination, version, flags);

        public void WriteHeader(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
        {
            Span<byte> span = destination.GetSpan(3);
            span[0] = 1;
            span[1] = 2;
            span[2] = 3;
            destination.Advance(3);
        }

        public Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame)
            => DecodeResult;

        public static FakeEncoder Success(AedsDecodeResult value)
            => new() { DecodeResult = Result<AedsDecodeResult>.Success(value) };
    }
}
