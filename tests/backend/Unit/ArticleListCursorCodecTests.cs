using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ArticleListCursorCodecTests
{
    private static readonly ArticleListCursorPosition s_position = new(
        new DateTime(2026, 7, 20, 8, 30, 0, DateTimeKind.Utc),
        42);

    [Fact]
    public void Cursor_RoundTripsVersionedCompositePosition()
    {
        (ArticleListCursorCodec codec, _) = CreateCodec();
        string encoded = codec.Encode(
            s_position,
            categoryId: 7,
            tagId: 9,
            normalizedKeyword: "fsus",
            pageSize: 20,
            queryVersion: 77,
            ArticleListSortMode.Latest);

        Assert.DoesNotContain(':', encoded);
        Assert.True(codec.TryDecode(encoded, 7, 9, "fsus", 20, 77, ArticleListSortMode.Latest, out ArticleListCursorPosition decoded));
        Assert.Equal(s_position, decoded);
    }

    [Fact]
    public void Cursor_RejectsTamperingAndFilterReuse()
    {
        (ArticleListCursorCodec codec, _) = CreateCodec();
        string encoded = codec.Encode(
            s_position,
            categoryId: 7,
            tagId: null,
            normalizedKeyword: string.Empty,
            pageSize: 20,
            queryVersion: 77,
            ArticleListSortMode.Latest);
        char replacement = encoded[^1] == 'A' ? 'B' : 'A';
        string tampered = string.Concat(encoded[..^1], replacement);

        Assert.False(codec.TryDecode(tampered, 7, null, string.Empty, 20, 77, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 8, null, string.Empty, 20, 77, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 7, 1, string.Empty, 20, 77, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 7, null, "other", 20, 77, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 7, null, string.Empty, 10, 77, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 7, null, string.Empty, 20, 78, ArticleListSortMode.Latest, out _));
        Assert.False(codec.TryDecode(encoded, 7, null, string.Empty, 20, 77, ArticleListSortMode.Hot, out _));
    }

    [Fact]
    public void Cursor_RejectsExpiredProtectedPayload()
    {
        (ArticleListCursorCodec codec, TestBusinessTimeProvider time) = CreateCodec();
        string encoded = codec.Encode(s_position, null, null, string.Empty, 20, 77, ArticleListSortMode.Latest);

        time.Advance(TimeSpan.FromMinutes(15));

        Assert.False(codec.TryDecode(encoded, null, null, string.Empty, 20, 77, ArticleListSortMode.Latest, out _));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-cursor")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void Cursor_RejectsMalformedValues(string encoded)
    {
        (ArticleListCursorCodec codec, _) = CreateCodec();
        Assert.False(codec.TryDecode(encoded, null, null, string.Empty, 10, 0, ArticleListSortMode.Latest, out _));
    }

    [Theory]
    [InlineData("A")]
    [InlineData("AAAAA")]
    [InlineData("AB")]
    [InlineData("AAB")]
    public void Cursor_RejectsNonCanonicalEncodingBeforeUnprotect(string encoded)
    {
        var provider = Substitute.For<IDataProtectionProvider>();
        var protector = Substitute.For<IDataProtector>();
        provider.CreateProtector(Arg.Any<string>()).Returns(protector);
        var time = new TestBusinessTimeProvider(new DateTimeOffset(2026, 7, 20, 8, 30, 0, TimeSpan.Zero));
        var codec = new ArticleListCursorCodec(provider, time);

        Assert.False(codec.TryDecode(encoded, null, null, string.Empty, 10, 0, ArticleListSortMode.Latest, out _));
        protector.DidNotReceive().Unprotect(Arg.Any<byte[]>());
    }

    [Theory]
    [InlineData("AA", 1)]
    [InlineData("AAA", 2)]
    [InlineData("AAAA", 3)]
    public void Cursor_DelegatesCanonicalBytesToAuthenticatedPayloadValidation(string encoded, int byteCount)
    {
        var provider = Substitute.For<IDataProtectionProvider>();
        var protector = Substitute.For<IDataProtector>();
        provider.CreateProtector(Arg.Any<string>()).Returns(protector);
        protector.Unprotect(Arg.Any<byte[]>()).Returns(Array.Empty<byte>());
        var time = new TestBusinessTimeProvider(new DateTimeOffset(2026, 7, 20, 8, 30, 0, TimeSpan.Zero));
        var codec = new ArticleListCursorCodec(provider, time);

        Assert.False(codec.TryDecode(encoded, null, null, string.Empty, 10, 0, ArticleListSortMode.Latest, out _));
        protector.Received(1).Unprotect(Arg.Is<byte[]>(bytes => bytes.Length == byteCount && bytes.All(value => value == 0)));
    }

    private static (ArticleListCursorCodec Codec, TestBusinessTimeProvider Time) CreateCodec()
    {
        var time = new TestBusinessTimeProvider(new DateTimeOffset(2026, 7, 20, 8, 30, 0, TimeSpan.Zero));
        return (new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), time), time);
    }
}
