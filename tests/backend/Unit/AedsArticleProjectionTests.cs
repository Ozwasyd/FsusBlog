using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AedsArticleProjectionTests
{
    [Fact]
    public void PublicCardProjection_CurrentLayout_MatchesCanonicalFields()
    {
        byte[] payload = BuildCurrentPayload();

        Assert.True(PodBinaryCodec.TryDecodeArticlePage(payload, out var canonical));
        Assert.True(PodBinaryCodec.TryDecodePublicArticleListCardProjection(payload, out var projected));

        Assert.Equal(AedsProjectionDecodePath.Projection, projected.DecodePath);
        Assert.Equal(canonical.Total, projected.Total);
        Assert.Equal(canonical.Items[0].Id, projected.Items[0].Id);
        Assert.Equal(canonical.Items[0].Title, projected.Items[0].Title);
        Assert.Equal(canonical.Items[0].Summary, projected.Items[0].Summary);
        Assert.Equal(canonical.Items[0].Category.Name, projected.Items[0].CategoryName);
        Assert.Equal(canonical.Items[0].Tags[0].Name, projected.Items[0].Tags[0].Name);
    }

    [Theory]
    [InlineData(44)]
    [InlineData(24)]
    public void PublicCardProjection_RetiredRecordLayouts_FailClosed(int bytesToRemove)
    {
        byte[] legacy = RemoveCurrentRecordTail(BuildCurrentPayload(), bytesToRemove);
        Assert.False(PodBinaryCodec.TryDecodePublicArticleListCardProjection(legacy, out _));
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(legacy, out _));
    }

    [Theory]
    [InlineData(76, 8)]
    [InlineData(84, 4)]
    [InlineData(96, 4)]
    public void PublicCardProjection_InvalidVersionCoordinates_FailClosed(int offset, int length)
    {
        byte[] payload = BuildCurrentPayload();
        payload.AsSpan(FindRecordOffset(payload) + offset, length).Clear();
        Assert.False(PodBinaryCodec.TryDecodePublicArticleListCardProjection(payload, out _));
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(payload, out _));
    }

    [Fact]
    public void PublicCardProjection_InvalidReservedByte_FailsClosed()
    {
        byte[] payload = BuildCurrentPayload();
        int recordOffset = FindRecordOffset(payload);
        payload[recordOffset + 54] = 1;

        Assert.False(PodBinaryCodec.TryDecodePublicArticleListCardProjection(payload, out _));
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(payload, out _));
    }

    [Fact]
    public void PublicCardProjection_InvalidSlice_FailsClosed()
    {
        byte[] payload = BuildCurrentPayload();
        int recordOffset = FindRecordOffset(payload);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(
            payload.AsSpan(recordOffset + 28, sizeof(int)),
            payload.Length);

        Assert.False(PodBinaryCodec.TryDecodePublicArticleListCardProjection(payload, out _));
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(payload, out _));
    }

    private static byte[] BuildCurrentPayload()
    {
        DateTime created = new(2024, 5, 10, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectArticleList(
            42, 900, created, 7, "Tech", "Projection title", "Projection summary", false, out _);
        var item = new ArticleListCoreModel(
            pod,
            42,
            "Projection title",
            "Projection summary",
            null,
            null,
            900,
            created,
            new ArticleCategoryCoreModel(7, "Tech"),
            [new TagCoreModel(10, "aeds")],
            false,
            2,
            null,
            created,
            99,
            3,
            88,
            2);
        return PodBinaryCodec.EncodeArticlePage(new CorePageResult<ArticleListCoreModel>([item], 1));
    }

    private static int FindRecordOffset(byte[] payload)
    {
        int cursorLength = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(13, 4));
        int countOffset = 17 + cursorLength;
        int blobLength = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(countOffset + 8, 4));
        return countOffset + 12 + blobLength;
    }

    private static byte[] RemoveCurrentRecordTail(byte[] current, int bytesToRemove)
    {
        int recordOffset = FindRecordOffset(current);
        int tailOffset = recordOffset + 100;
        var legacy = new byte[current.Length - bytesToRemove];
        current.AsSpan(0, recordOffset + 100 - bytesToRemove).CopyTo(legacy);
        current.AsSpan(tailOffset).CopyTo(legacy.AsSpan(recordOffset + 100 - bytesToRemove));
        return legacy;
    }
}
