using System.Buffers.Binary;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Tests;

public sealed class ServerCacheBinaryCodecTests
{
    [Fact]
    public void ArticleListPage_UtcDateTimes_RoundTripWithoutTickDrift()
    {
        DateTime created = new(2026, 6, 25, 9, 30, 0, DateTimeKind.Utc);
        DateTime scheduled = new(2026, 6, 26, 9, 30, 0, DateTimeKind.Utc);
        DateTime published = new(2026, 6, 27, 9, 30, 0, DateTimeKind.Utc);
        var page = new ArticleListPageReadModel
        {
            Total = 1,
            Items =
            [
                CreateItem(created) with
                {
                    ScheduledPublishAt = scheduled,
                    PublishedAt = published,
                    CurrentRevisionId = 801,
                    RevisionNo = 7,
                    CurrentPublicationId = 1201,
                    PublicationNo = 4
                }
            ]
        };

        byte[] payload = ServerCacheBinaryCodec.EncodeArticleListPage(page);
        (bool success, ArticleListPageReadModel? decoded) = ServerCacheBinaryCodec.DecodeArticleListPage(payload);

        Assert.True(success);
        ArticleListItemReadModel item = Assert.Single(decoded!.Items);
        Assert.Equal(created, item.CreateTime);
        Assert.Equal(DateTimeKind.Utc, item.CreateTime.Kind);
        Assert.Equal(scheduled, item.ScheduledPublishAt);
        Assert.Equal(DateTimeKind.Utc, item.ScheduledPublishAt!.Value.Kind);
        Assert.Equal(published, item.PublishedAt);
        Assert.Equal(DateTimeKind.Utc, item.PublishedAt!.Value.Kind);
        Assert.Equal(801, item.CurrentRevisionId);
        Assert.Equal(7, item.RevisionNo);
        Assert.Equal(1201, item.CurrentPublicationId);
        Assert.Equal(4, item.PublicationNo);
    }

    [Theory]
    [InlineData(DateTimeKind.Unspecified)]
    [InlineData(DateTimeKind.Local)]
    public void ArticleListPage_NonUtcDateTimes_AreRejected(DateTimeKind kind)
    {
        var page = new ArticleListPageReadModel
        {
            Total = 1,
            Items = [CreateItem(new DateTime(2026, 6, 25, 9, 30, 0, kind))]
        };

        var ex = Assert.Throws<InvalidOperationException>(() => ServerCacheBinaryCodec.EncodeArticleListPage(page));

        Assert.Contains("UTC", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetail_V6RoundTrip_PreservesCompleteProjectionCoordinatesAndRightsSnapshot()
    {
        DateTime updatedAt = new(2026, 6, 27, 9, 30, 0, DateTimeKind.Utc);
        ArticleDetailReadModel detail = CreateDetail() with
        {
            UpdatedAt = updatedAt,
            CurrentRevisionId = 801,
            RevisionNo = 7,
            CurrentPublicationId = 1201,
            PublicationNo = 4
        };

        byte[] payload = ServerCacheBinaryCodec.EncodeArticleDetail(detail);
        (bool success, ArticleDetailReadModel? decoded) = ServerCacheBinaryCodec.DecodeArticleDetail(payload);

        Assert.True(success);
        Assert.NotNull(decoded);
        Assert.Equal(0x36444146u, BinaryPrimitives.ReadUInt32LittleEndian(payload));
        Assert.Equal(6u, BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(sizeof(uint))));
        Assert.Equal(updatedAt, decoded.UpdatedAt);
        Assert.Equal(801, decoded.CurrentRevisionId);
        Assert.Equal(7, decoded.RevisionNo);
        Assert.Equal(1201, decoded.CurrentPublicationId);
        Assert.Equal(4, decoded.PublicationNo);
        Assert.Equal(701, decoded.ContentBlockId);
        Assert.Equal(901, decoded.Rights.SnapshotId);
        Assert.Equal(801, decoded.Rights.ArticleRevisionId);
        Assert.Equal(7, decoded.Rights.RevisionNo);
        Assert.Equal("CC-BY-4.0", decoded.Rights.LicenseType);
        Assert.Equal("Fésus", decoded.Rights.CopyrightHolder);
        Assert.Equal(2026, decoded.Rights.CopyrightYear);
        Assert.Equal("Line one\nLine two", decoded.Rights.RightsStatement);
        Assert.Equal("{title} — {holder}", decoded.Rights.AttributionTemplate);
        Assert.Equal("append-attribution", decoded.Rights.CopyPolicy);
        Assert.Equal(300, decoded.Rights.MaxExcerptChars);
        Assert.True(decoded.Rights.Enabled);
        Assert.True(decoded.Rights.AllowCodeCopy);
        Assert.False(decoded.Rights.ShowPublicBadge);
        Assert.True(decoded.Rights.ProofBindingEnabled);
        Assert.Equal("https://example.test/article/10", decoded.Rights.CanonicalUrl);
        Assert.Equal("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decoded.Rights.PolicyHash);
        Assert.Equal("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decoded.Rights.ContentCanonicalHash);
        Assert.Equal("https://example.test/proofs/rights/901", decoded.Rights.ProofUrl);
        Assert.Equal("ready", decoded.Rights.ProofStatus);
    }

    [Theory]
    [InlineData(0x44434146u, 3u)]
    [InlineData(0x34444146u, 4u)]
    [InlineData(0x34444146u, 5u)]
    public void ArticleDetail_LegacyCachePayload_IsRejected(uint magic, uint version)
    {
        byte[] legacy = ServerCacheBinaryCodec.EncodeArticleDetail(CreateDetail());
        BinaryPrimitives.WriteUInt32LittleEndian(legacy, magic);
        BinaryPrimitives.WriteUInt32LittleEndian(legacy.AsSpan(sizeof(uint)), version);

        (bool success, ArticleDetailReadModel? decoded) = ServerCacheBinaryCodec.DecodeArticleDetail(legacy);

        Assert.False(success);
        Assert.Null(decoded);
    }

    [Fact]
    public void ArticleDetail_CompleteProjectionRejectsBlankContentAndMissingContentBlockCoordinate()
    {
        ArticleDetailReadModel blank = CreateDetail() with
        {
            Content = string.Empty
        };

        Assert.Throws<InvalidOperationException>(
            () => ServerCacheBinaryCodec.EncodeArticleDetail(blank));
        Assert.Throws<InvalidOperationException>(
            () => ServerCacheBinaryCodec.EncodeArticleDetail(CreateDetail() with { ContentBlockId = 0 }));
    }

    private static ArticleListItemReadModel CreateItem(DateTime createTime)
        => new()
        {
            Id = 1,
            Title = "Article",
            Summary = "Summary",
            CoverImageUrl = "/cover.webp",
            Snippet = "Snippet",
            Views = 1,
            CreateTime = createTime,
            CategoryId = 2,
            CategoryName = "Category",
            Tags = [new TagReadModel { Id = 3, Name = "Tag" }],
            IsDeleted = false,
            Status = ArticleStatus.Published
        };

    private static ArticleDetailReadModel CreateDetail()
        => new()
        {
            Id = 10,
            Title = "Article",
            Content = "Content",
            Summary = "Summary",
            CoverImageUrl = "/cover.webp",
            Views = 3,
            WordCount = 7,
            EstimatedReadingMinutes = 1,
            ShowReadingNotice = false,
            CreateTime = new DateTime(2026, 6, 25, 9, 30, 0, DateTimeKind.Utc),
            CategoryId = 2,
            CategoryName = "Category",
            Tags = [new TagReadModel { Id = 3, Name = "Tag" }],
            IsDeleted = false,
            Status = ArticleStatus.Published,
            CurrentRevisionId = 801,
            RevisionNo = 7,
            CurrentPublicationId = 1201,
            PublicationNo = 4,
            ContentBlockId = 701,
            PublishedAt = new DateTime(2026, 6, 26, 9, 30, 0, DateTimeKind.Utc),
            Rights = new ArticleRightsReadModel
            {
                SnapshotId = 901,
                ArticleRevisionId = 801,
                RevisionNo = 7,
                Enabled = true,
                LicenseType = "CC-BY-4.0",
                CopyrightHolder = "Fésus",
                CopyrightYear = 2026,
                RightsStatement = "Line one\nLine two",
                AttributionTemplate = "{title} — {holder}",
                CopyPolicy = "append-attribution",
                MaxExcerptChars = 300,
                AllowCodeCopy = true,
                ShowPublicBadge = false,
                ProofBindingEnabled = true,
                CanonicalUrl = "https://example.test/article/10",
                PolicyHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ContentCanonicalHash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ProofUrl = "https://example.test/proofs/rights/901",
                ProofStatus = "ready"
            }
        };
}
