using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Pagination;

namespace FsusBlog.Server.Tests;

public sealed class ArticleListCursorCodecTests
{
    private static readonly ArticleListCursorPosition s_position = new(
        new DateTime(2026, 7, 20, 8, 30, 0, DateTimeKind.Utc),
        42);

    [Fact]
    public void Cursor_RoundTripsVersionedCompositePosition()
    {
        string encoded = ArticleListCursorCodec.Encode(s_position, categoryId: 7, tagId: 9, normalizedKeyword: "fsus");

        Assert.DoesNotContain(':', encoded);
        Assert.True(ArticleListCursorCodec.TryDecode(encoded, 7, 9, "fsus", out ArticleListCursorPosition decoded));
        Assert.Equal(s_position, decoded);
    }

    [Fact]
    public void Cursor_RejectsTamperingAndFilterReuse()
    {
        string encoded = ArticleListCursorCodec.Encode(s_position, categoryId: 7, tagId: null, normalizedKeyword: string.Empty);
        char replacement = encoded[^1] == 'A' ? 'B' : 'A';
        string tampered = string.Concat(encoded[..^1], replacement);

        Assert.False(ArticleListCursorCodec.TryDecode(tampered, 7, null, string.Empty, out _));
        Assert.False(ArticleListCursorCodec.TryDecode(encoded, 8, null, string.Empty, out _));
        Assert.False(ArticleListCursorCodec.TryDecode(encoded, 7, 1, string.Empty, out _));
        Assert.False(ArticleListCursorCodec.TryDecode(encoded, 7, null, "other", out _));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-cursor")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void Cursor_RejectsMalformedValues(string encoded)
        => Assert.False(ArticleListCursorCodec.TryDecode(encoded, null, null, string.Empty, out _));
}
