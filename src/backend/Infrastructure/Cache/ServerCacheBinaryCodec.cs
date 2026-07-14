using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Infrastructure.Cache;

internal static class ServerCacheBinaryCodec
{
    private const uint ArticleListPageMagic = 0x4C434146; // FACL
    private const uint ArticleDetailMagic = 0x44434146; // FACD
    private const uint ArticleDetailV4Magic = 0x34444146; // FAD4
    private const uint ArticleSearchMagic = 0x53434146; // FACS
    private const uint SeoMagic = 0x4F455346; // FSEO
    private const uint ComplianceMagic = 0x504D4F43; // COMP
    private const uint AdminStatsMagic = 0x42545346; // FSTB
    private const uint RecentCommentStatsMagic = 0x43545346; // FSTC
    private const uint RegionStatsMagic = 0x52545346; // FSTR
    private const uint Version = 3;
    private const uint ArticleDetailV4Version = 4;
    private const int ArticleListPageMetadataMarker = -1;
    private const int MaxStringBytes = 2 * 1024 * 1024;
    private const int MaxCollectionCount = 10_000;

    internal static byte[] EncodeArticleListPage(ArticleListPageReadModel value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, ArticleListPageMagic);
        writer.Write(value.Total);
        writer.Write(ArticleListPageMetadataMarker);
        writer.Write(value.HasMore);
        WriteString(writer, value.NextCursor ?? string.Empty);
        WriteArticleListItems(writer, value.Items);
        return stream.ToArray();
    }

    internal static (bool Success, ArticleListPageReadModel? Value) DecodeArticleListPage(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, ArticleListPageMagic))
            {
                return (false, null);
            }

            int total = reader.ReadInt32();
            bool hasMore = false;
            string? nextCursor = null;
            int countOrMarker = reader.ReadInt32();
            List<ArticleListItemReadModel> items;
            if (countOrMarker == ArticleListPageMetadataMarker)
            {
                hasMore = reader.ReadBoolean();
                string decodedCursor = ReadString(reader);
                nextCursor = string.IsNullOrEmpty(decodedCursor) ? null : decodedCursor;
                items = ReadArticleListItems(reader);
            }
            else
            {
                items = ReadArticleListItems(reader, countOrMarker);
            }

            return EnsureFullyRead(reader)
                ? (true, new ArticleListPageReadModel { Total = total, Items = items, NextCursor = nextCursor, HasMore = hasMore })
                : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeArticleDetail(ArticleDetailReadModel value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, ArticleDetailV4Magic, ArticleDetailV4Version);
        WriteArticleDetail(writer, value);
        return stream.ToArray();
    }

    internal static (bool Success, ArticleDetailReadModel? Value) DecodeArticleDetail(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            uint magic = reader.ReadUInt32();
            uint version = reader.ReadUInt32();
            bool isV4 = magic == ArticleDetailV4Magic && version == ArticleDetailV4Version;
            bool isV3 = magic == ArticleDetailMagic && version == Version;
            if (!isV3 && !isV4)
            {
                return (false, null);
            }

            ArticleDetailReadModel item = ReadArticleDetail(reader, isV4);
            return EnsureFullyRead(reader) ? (true, item) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeArticleSearch(List<ArticleListItemReadModel> value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, ArticleSearchMagic);
        WriteArticleListItems(writer, value);
        return stream.ToArray();
    }

    internal static (bool Success, List<ArticleListItemReadModel>? Value) DecodeArticleSearch(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, ArticleSearchMagic))
            {
                return (false, null);
            }

            List<ArticleListItemReadModel> items = ReadArticleListItems(reader);
            return EnsureFullyRead(reader) ? (true, items) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeSeo(SeoConfigReadModel value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, SeoMagic);
        WriteString(writer, value.Title);
        WriteString(writer, value.Description);
        WriteString(writer, value.Keywords);
        WriteString(writer, value.Author);
        WriteString(writer, value.OgImage);
        WriteString(writer, value.BaseUrl);
        WriteString(writer, value.FaviconSvgUrl);
        WriteString(writer, value.FaviconIcoUrl);
        WriteString(writer, value.FaviconPngUrl);
        WriteString(writer, value.AppleTouchIconUrl);
        WriteString(writer, value.ManifestName);
        WriteString(writer, value.ManifestShortName);
        WriteString(writer, value.PwaIcon192Url);
        WriteString(writer, value.PwaIcon512Url);
        WriteString(writer, value.PwaMaskableIconUrl);
        WriteString(writer, value.ThemeColor);
        WriteString(writer, value.BackgroundColor);
        WriteString(writer, value.SiteLogoUrl);
        WriteString(writer, value.SiteLogoDarkUrl);
        WriteString(writer, value.SiteWordmarkUrl);
        WriteString(writer, value.AdminLogoUrl);
        WriteString(writer, value.AdminCollapsedIconUrl);
        WriteString(writer, value.LoginLogoUrl);
        WriteString(writer, value.LoginIconUrl);
        return stream.ToArray();
    }

    internal static (bool Success, SeoConfigReadModel? Value) DecodeSeo(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, SeoMagic))
            {
                return (false, null);
            }

            var value = new SeoConfigReadModel
            {
                Title = ReadString(reader),
                Description = ReadString(reader),
                Keywords = ReadString(reader),
                Author = ReadString(reader),
                OgImage = ReadString(reader),
                BaseUrl = ReadString(reader),
                FaviconSvgUrl = ReadString(reader),
                FaviconIcoUrl = ReadString(reader),
                FaviconPngUrl = ReadString(reader),
                AppleTouchIconUrl = ReadString(reader),
                ManifestName = ReadString(reader),
                ManifestShortName = ReadString(reader),
                PwaIcon192Url = ReadString(reader),
                PwaIcon512Url = ReadString(reader),
                PwaMaskableIconUrl = ReadString(reader),
                ThemeColor = ReadString(reader),
                BackgroundColor = ReadString(reader),
                SiteLogoUrl = ReadString(reader),
                SiteLogoDarkUrl = ReadString(reader),
                SiteWordmarkUrl = ReadString(reader),
                AdminLogoUrl = ReadString(reader),
                AdminCollapsedIconUrl = ReadString(reader),
                LoginLogoUrl = ReadString(reader),
                LoginIconUrl = ReadString(reader)
            };
            return EnsureFullyRead(reader) ? (true, value) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeCompliance(SiteComplianceConfigReadModel value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, ComplianceMagic);
        writer.Write(value.Enabled);
        WriteString(writer, value.RegionMode);
        WriteString(writer, value.CopyrightOwner);
        writer.Write(value.CopyrightStartYear ?? 0);
        WriteString(writer, value.CopyrightText);
        WriteString(writer, value.ContentLicenseName);
        WriteString(writer, value.ContentLicenseUrl);
        WriteString(writer, value.IcpRecordNumber);
        WriteString(writer, value.IcpRecordUrl);
        WriteString(writer, value.PoliceRecordNumber);
        WriteString(writer, value.PoliceRecordUrl);
        WriteString(writer, value.PoliceBadgeIconUrl);
        WriteString(writer, value.OperatorName);
        WriteString(writer, value.ContactEmail);
        return stream.ToArray();
    }

    internal static (bool Success, SiteComplianceConfigReadModel? Value) DecodeCompliance(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, ComplianceMagic))
            {
                return (false, null);
            }

            var value = new SiteComplianceConfigReadModel
            {
                Enabled = reader.ReadBoolean(),
                RegionMode = ReadString(reader),
                CopyrightOwner = ReadString(reader),
                CopyrightStartYear = NormalizeYearOrNull(reader.ReadInt32()),
                CopyrightText = ReadString(reader),
                ContentLicenseName = ReadString(reader),
                ContentLicenseUrl = ReadString(reader),
                IcpRecordNumber = ReadString(reader),
                IcpRecordUrl = ReadString(reader),
                PoliceRecordNumber = ReadString(reader),
                PoliceRecordUrl = ReadString(reader),
                PoliceBadgeIconUrl = ReadString(reader),
                OperatorName = ReadString(reader),
                ContactEmail = ReadString(reader)
            };
            return EnsureFullyRead(reader) ? (true, value) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeAdminStats(AdminStatsOverviewDto value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, AdminStatsMagic);
        writer.Write(value.Summary.TotalArticles);
        writer.Write(value.Summary.TotalComments);
        writer.Write(value.Summary.TrashCount);
        writer.Write(value.Summary.TotalReads);
        writer.Write(value.Summary.HumanVerifiedReads);
        writer.Write(value.Summary.UniqueViewerKeyEstimate);
        writer.Write(value.Summary.ArticleReads);
        writer.Write(value.Summary.SiteReads);
        writer.Write(value.PopularArticles.Count);
        foreach (PopularArticleStatItemDto item in value.PopularArticles)
        {
            writer.Write(item.Id);
            WriteString(writer, item.Title);
            writer.Write(item.Views);
        }

        return stream.ToArray();
    }

    internal static (bool Success, AdminStatsOverviewDto? Value) DecodeAdminStats(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, AdminStatsMagic))
            {
                return (false, null);
            }

            var summary = new StatsSummaryDto
            {
                TotalArticles = reader.ReadInt32(),
                TotalComments = reader.ReadInt32(),
                TrashCount = reader.ReadInt32(),
                TotalReads = reader.ReadInt32(),
                HumanVerifiedReads = reader.ReadInt32(),
                UniqueViewerKeyEstimate = reader.ReadInt32(),
                ArticleReads = reader.ReadInt32(),
                SiteReads = reader.ReadInt32()
            };
            int count = ReadCount(reader);
            var popular = new List<PopularArticleStatItemDto>(count);
            for (int i = 0; i < count; i++)
            {
                popular.Add(new PopularArticleStatItemDto(reader.ReadInt32(), ReadString(reader), reader.ReadInt32()));
            }

            return EnsureFullyRead(reader)
                ? (true, new AdminStatsOverviewDto { Summary = summary, PopularArticles = popular })
                : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeRecentCommentStats(IReadOnlyList<RecentCommentStatItemDto> value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, RecentCommentStatsMagic);
        writer.Write(value.Count);
        foreach (RecentCommentStatItemDto item in value)
        {
            WriteString(writer, item.AuthorDisplayName);
            WriteString(writer, item.AuthorMode);
            WriteNullableString(writer, item.AuthorBadge);
            WriteNullableString(writer, item.AuthorScopeLabel);
            WriteNullableString(writer, item.CredentialLevel);
            WriteString(writer, item.Content);
            writer.Write(item.CreateTime.ToBinary());
        }

        return stream.ToArray();
    }

    internal static (bool Success, List<RecentCommentStatItemDto>? Value) DecodeRecentCommentStats(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, RecentCommentStatsMagic))
            {
                return (false, null);
            }

            int count = ReadCount(reader);
            var items = new List<RecentCommentStatItemDto>(count);
            for (int i = 0; i < count; i++)
            {
                items.Add(new RecentCommentStatItemDto(
                    ReadString(reader),
                    ReadString(reader),
                    ReadNullableString(reader),
                    ReadNullableString(reader),
                    ReadNullableString(reader),
                    ReadString(reader),
                    DateTime.FromBinary(reader.ReadInt64())));
            }

            return EnsureFullyRead(reader) ? (true, items) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    internal static byte[] EncodeRegionStats(IReadOnlyList<RegionStatItemDto> value)
    {
        using var stream = new MemoryStream();
        using var writer = CreateWriter(stream);
        WriteHeader(writer, RegionStatsMagic);
        writer.Write(value.Count);
        foreach (RegionStatItemDto item in value)
        {
            WriteString(writer, item.Region);
            writer.Write(item.Count);
        }

        return stream.ToArray();
    }

    internal static (bool Success, List<RegionStatItemDto>? Value) DecodeRegionStats(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            using var reader = CreateReader(bytes);
            if (!ReadHeader(reader, RegionStatsMagic))
            {
                return (false, null);
            }

            int count = ReadCount(reader);
            var items = new List<RegionStatItemDto>(count);
            for (int i = 0; i < count; i++)
            {
                items.Add(new RegionStatItemDto(ReadString(reader), reader.ReadInt32()));
            }

            return EnsureFullyRead(reader) ? (true, items) : (false, null);
        }
        catch
        {
            return (false, null);
        }
    }

    private static BinaryWriter CreateWriter(Stream stream) => new(stream, Encoding.UTF8, leaveOpen: true);

    private static BinaryReader CreateReader(ReadOnlyMemory<byte> bytes)
        => new(new ReadOnlyMemoryStream(bytes), Encoding.UTF8, leaveOpen: false);

    private static void WriteHeader(BinaryWriter writer, uint magic)
        => WriteHeader(writer, magic, Version);

    private static void WriteHeader(BinaryWriter writer, uint magic, uint version)
    {
        writer.Write(magic);
        writer.Write(version);
    }

    private static bool ReadHeader(BinaryReader reader, uint magic)
        => reader.ReadUInt32() == magic && reader.ReadUInt32() == Version;

    private static bool EnsureFullyRead(BinaryReader reader)
        => reader.BaseStream.Position == reader.BaseStream.Length;

    private static void WriteArticleListItems(BinaryWriter writer, IReadOnlyList<ArticleListItemReadModel> items)
    {
        writer.Write(items.Count);
        foreach (ArticleListItemReadModel item in items)
        {
            writer.Write(item.Id);
            WriteString(writer, item.Title);
            WriteNullableString(writer, item.Summary);
            WriteNullableString(writer, item.CoverImageUrl);
            WriteNullableString(writer, item.Snippet);
            writer.Write(item.Views);
            WriteDateTime(writer, item.CreateTime);
            writer.Write(item.CategoryId);
            WriteString(writer, item.CategoryName);
            WriteTags(writer, item.Tags);
            WriteNullableBool(writer, item.IsDeleted);
            writer.Write((int)item.Status);
            WriteNullableDateTime(writer, item.ScheduledPublishAt);
            WriteNullableDateTime(writer, item.PublishedAt);
        }
    }

    private static List<ArticleListItemReadModel> ReadArticleListItems(BinaryReader reader)
    {
        int count = ReadCount(reader);
        return ReadArticleListItems(reader, count);
    }

    private static List<ArticleListItemReadModel> ReadArticleListItems(BinaryReader reader, int count)
    {
        if (count < 0 || count > MaxCollectionCount)
        {
            throw new InvalidDataException("Invalid cached article list item count.");
        }

        var items = new List<ArticleListItemReadModel>(count);
        for (int i = 0; i < count; i++)
        {
            items.Add(new ArticleListItemReadModel
            {
                Id = reader.ReadInt32(),
                Title = ReadString(reader),
                Summary = ReadNullableString(reader),
                CoverImageUrl = ReadNullableString(reader),
                Snippet = ReadNullableString(reader),
                Views = reader.ReadInt32(),
                CreateTime = ReadDateTime(reader),
                CategoryId = reader.ReadInt32(),
                CategoryName = ReadString(reader),
                Tags = ReadTags(reader),
                IsDeleted = ReadNullableBool(reader),
                Status = (FsusBlog.Server.Entities.ArticleStatus)reader.ReadInt32(),
                ScheduledPublishAt = ReadNullableDateTime(reader),
                PublishedAt = ReadNullableDateTime(reader)
            });
        }

        return items;
    }

    private static void WriteArticleDetail(BinaryWriter writer, ArticleDetailReadModel item)
    {
        writer.Write(item.Id);
        WriteString(writer, item.Title);
        WriteString(writer, item.Content);
        WriteNullableString(writer, item.Summary);
        WriteNullableString(writer, item.CoverImageUrl);
        writer.Write(item.Views);
        writer.Write(item.WordCount);
        writer.Write(item.EstimatedReadingMinutes);
        writer.Write(item.ShowReadingNotice);
        WriteDateTime(writer, item.CreateTime);
        writer.Write(item.CategoryId);
        WriteString(writer, item.CategoryName);
        WriteTags(writer, item.Tags);
        writer.Write(item.IsDeleted);
        writer.Write((int)item.Status);
        WriteNullableDateTime(writer, item.ScheduledPublishAt);
        WriteNullableDateTime(writer, item.PublishedAt);
        WriteNullableDateTime(writer, item.UpdatedAt);
        WriteArticleRights(writer, item.Rights);
    }

    private static ArticleDetailReadModel ReadArticleDetail(BinaryReader reader, bool hasUpdatedAt)
        => new()
        {
            Id = reader.ReadInt32(),
            Title = ReadString(reader),
            Content = ReadString(reader),
            Summary = ReadNullableString(reader),
            CoverImageUrl = ReadNullableString(reader),
            Views = reader.ReadInt32(),
            WordCount = reader.ReadInt32(),
            EstimatedReadingMinutes = reader.ReadInt32(),
            ShowReadingNotice = reader.ReadBoolean(),
            CreateTime = ReadDateTime(reader),
            CategoryId = reader.ReadInt32(),
            CategoryName = ReadString(reader),
            Tags = ReadTags(reader),
            IsDeleted = reader.ReadBoolean(),
            Status = (FsusBlog.Server.Entities.ArticleStatus)reader.ReadInt32(),
            ScheduledPublishAt = ReadNullableDateTime(reader),
            PublishedAt = ReadNullableDateTime(reader),
            UpdatedAt = hasUpdatedAt ? ReadNullableDateTime(reader) : null,
            Rights = ReadArticleRights(reader)
        };

    private static void WriteArticleRights(BinaryWriter writer, ArticleRightsReadModel rights)
    {
        writer.Write(rights.SnapshotId);
        writer.Write(rights.ArticleRevisionId);
        writer.Write(rights.RevisionNo);
        writer.Write(rights.Enabled);
        WriteString(writer, rights.LicenseType);
        WriteNullableString(writer, rights.CopyrightHolder);
        writer.Write(rights.CopyrightYear.GetValueOrDefault());
        writer.Write(rights.CopyrightYear.HasValue);
        WriteNullableString(writer, rights.RightsStatement);
        WriteNullableString(writer, rights.AttributionTemplate);
        WriteString(writer, rights.CopyPolicy);
        writer.Write(rights.MaxExcerptChars);
        writer.Write(rights.AllowCodeCopy);
        writer.Write(rights.ShowPublicBadge);
        writer.Write(rights.ProofBindingEnabled);
        WriteNullableString(writer, rights.CanonicalUrl);
        WriteString(writer, rights.PolicyHash);
        WriteString(writer, rights.ContentCanonicalHash);
        WriteNullableString(writer, rights.ProofUrl);
        WriteNullableString(writer, rights.ProofStatus);
    }

    private static ArticleRightsReadModel ReadArticleRights(BinaryReader reader)
    {
        long snapshotId = reader.ReadInt64();
        long articleRevisionId = reader.ReadInt64();
        int revisionNo = reader.ReadInt32();
        bool enabled = reader.ReadBoolean();
        string licenseType = ReadString(reader);
        string? copyrightHolder = ReadNullableString(reader);
        int copyrightYear = reader.ReadInt32();
        bool hasCopyrightYear = reader.ReadBoolean();
        string? rightsStatement = ReadNullableString(reader);
        string? attributionTemplate = ReadNullableString(reader);
        string copyPolicy = ReadString(reader);
        int maxExcerptChars = reader.ReadInt32();
        bool allowCodeCopy = reader.ReadBoolean();
        bool showPublicBadge = reader.ReadBoolean();
        bool proofBindingEnabled = reader.ReadBoolean();
        string? canonicalUrl = ReadNullableString(reader);
        string policyHash = ReadString(reader);
        string contentCanonicalHash = ReadString(reader);
        string? proofUrl = ReadNullableString(reader);
        string? proofStatus = ReadNullableString(reader);

        return new ArticleRightsReadModel
        {
            SnapshotId = snapshotId,
            ArticleRevisionId = articleRevisionId,
            RevisionNo = revisionNo,
            Enabled = enabled,
            LicenseType = licenseType,
            CopyrightHolder = copyrightHolder,
            CopyrightYear = hasCopyrightYear ? copyrightYear : null,
            RightsStatement = rightsStatement,
            AttributionTemplate = attributionTemplate,
            CopyPolicy = copyPolicy,
            MaxExcerptChars = maxExcerptChars,
            AllowCodeCopy = allowCodeCopy,
            ShowPublicBadge = showPublicBadge,
            ProofBindingEnabled = proofBindingEnabled,
            CanonicalUrl = canonicalUrl,
            PolicyHash = policyHash,
            ContentCanonicalHash = contentCanonicalHash,
            ProofUrl = proofUrl,
            ProofStatus = proofStatus
        };
    }

    private static void WriteTags(BinaryWriter writer, IReadOnlyList<TagReadModel> tags)
    {
        writer.Write(tags.Count);
        foreach (TagReadModel tag in tags)
        {
            writer.Write(tag.Id);
            WriteString(writer, tag.Name);
        }
    }

    private static List<TagReadModel> ReadTags(BinaryReader reader)
    {
        int count = ReadCount(reader);
        var tags = new List<TagReadModel>(count);
        for (int i = 0; i < count; i++)
        {
            tags.Add(new TagReadModel { Id = reader.ReadInt32(), Name = ReadString(reader) });
        }

        return tags;
    }

    private static void WriteDateTime(BinaryWriter writer, DateTime value)
    {
        if (value.Kind != DateTimeKind.Utc)
        {
            throw new InvalidOperationException("Server cache binary timestamps must be UTC DateTime values.");
        }

        writer.Write(value.Ticks);
    }

    private static DateTime ReadDateTime(BinaryReader reader)
        => new(reader.ReadInt64(), DateTimeKind.Utc);

    private static void WriteNullableDateTime(BinaryWriter writer, DateTime? value)
    {
        writer.Write(value.HasValue);
        if (value.HasValue)
        {
            WriteDateTime(writer, value.Value);
        }
    }

    private static DateTime? ReadNullableDateTime(BinaryReader reader)
        => reader.ReadBoolean() ? ReadDateTime(reader) : null;

    private static void WriteNullableBool(BinaryWriter writer, bool? value)
        => writer.Write(value.HasValue ? value.Value ? (byte)2 : (byte)1 : (byte)0);

    private static bool? ReadNullableBool(BinaryReader reader)
        => reader.ReadByte() switch
        {
            0 => null,
            1 => false,
            2 => true,
            _ => throw new InvalidDataException("Invalid nullable bool value.")
        };

    private static void WriteNullableString(BinaryWriter writer, string? value)
    {
        writer.Write(value is not null);
        if (value is not null)
        {
            WriteString(writer, value);
        }
    }

    private static string? ReadNullableString(BinaryReader reader)
        => reader.ReadBoolean() ? ReadString(reader) : null;

    private static void WriteString(BinaryWriter writer, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static string ReadString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > MaxStringBytes)
        {
            throw new InvalidDataException("Invalid cache string length.");
        }

        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw new EndOfStreamException();
        }

        return Encoding.UTF8.GetString(bytes);
    }

    private static int ReadCount(BinaryReader reader)
    {
        int count = reader.ReadInt32();
        if (count < 0 || count > MaxCollectionCount)
        {
            throw new InvalidDataException("Invalid cache collection count.");
        }

        return count;
    }

    private static int? NormalizeYearOrNull(int value)
        => value > 0 ? value : null;
}
