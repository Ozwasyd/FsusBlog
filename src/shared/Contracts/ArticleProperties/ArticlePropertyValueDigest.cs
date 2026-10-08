using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleProperties;

/// <summary>Length-prefixed canonical digests; callers must independently validate authority coordinates.</summary>
public static class ArticlePropertyValueDigest
{
    public static string ComputeValue(ArticlePropertyValueInput value, bool defaultApplied = false)
    {
        ArgumentNullException.ThrowIfNull(value);
        return Compute(writer => AddValue(writer, value, defaultApplied));
    }

    public static string ComputeSnapshot(
        ArticlePropertySnapshotCoordinates coordinates,
        IReadOnlyList<ArticlePropertyValueEntry> values)
    {
        ArgumentNullException.ThrowIfNull(coordinates);
        ArgumentNullException.ThrowIfNull(values);
        return Compute(writer =>
        {
            writer.Add("fsusblog.article-property-value-snapshot.v1");
            writer.Add(ArticlePropertyValueSnapshot.CurrentSchemaVersion);
            writer.Add(coordinates.DefinitionOwnerUserId);
            writer.Add(coordinates.SiteScope);
            writer.Add(coordinates.ArticleId);
            writer.Add(coordinates.PropertyRevision);
            writer.Add(coordinates.ArticleRevisionId);
            writer.Add(coordinates.DraftId);
            writer.Add(coordinates.DraftServerRevision);
            writer.Add(coordinates.PublicationId);
            writer.Add(values.Count);
            foreach (ArticlePropertyValueEntry value in values)
            {
                AddValue(writer, new ArticlePropertyValueInput(value.DefinitionId,
                    value.DefinitionSchemaRevision, value.DefinitionDigest, value.Presence, value.Value), value.DefaultApplied);
                writer.Add(value.ValueDigest);
            }
        });
    }

    private static void AddValue(DigestWriter writer, ArticlePropertyValueInput value, bool defaultApplied)
    {
        writer.Add("fsusblog.article-property-value.v1");
        writer.Add(value.DefinitionId.ToString("D"));
        writer.Add(value.DefinitionSchemaRevision);
        writer.Add(value.DefinitionDigest);
        writer.Add((int)value.Presence);
        writer.Add(defaultApplied ? 1 : 0);
        if (defaultApplied && value.Presence == ArticlePropertyValuePresence.Missing)
        {
            throw new ArgumentException("article_property_default_origin_invalid");
        }
        switch (value.Value)
        {
            case null when value.Presence is ArticlePropertyValuePresence.Missing or ArticlePropertyValuePresence.Null:
                writer.Add("absent-payload");
                break;
            case ArticlePropertyTextValue text when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("text");
                writer.Add(text.Text);
                break;
            case ArticlePropertyNumberValue number when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("number");
                writer.Add(number.Number.ToString("0.############################", CultureInfo.InvariantCulture));
                break;
            case ArticlePropertyBooleanValue boolean when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("boolean");
                writer.Add(boolean.Boolean ? 1 : 0);
                break;
            case ArticlePropertyDateValue date when value.Presence == ArticlePropertyValuePresence.Present:
                if (date.Utc.Kind != DateTimeKind.Utc)
                {
                    throw new ArgumentException("article_property_date_not_utc");
                }
                writer.Add("date");
                writer.Add(date.Utc.Ticks);
                break;
            case ArticlePropertySingleSelectValue single when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("single-select");
                writer.Add(single.OptionId.ToString("D"));
                break;
            case ArticlePropertyMultiSelectValue multiple when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("multi-select");
                writer.Add(multiple.OptionIds.Count);
                foreach (Guid id in multiple.OptionIds)
                {
                    writer.Add(id.ToString("D"));
                }
                break;
            case ArticlePropertyArticleReferenceValue references when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("article-reference");
                writer.Add(references.ArticleIds.Count);
                foreach (long id in references.ArticleIds)
                {
                    writer.Add(id);
                }
                break;
            case ArticlePropertyUrlValue url when value.Presence == ArticlePropertyValuePresence.Present:
                writer.Add("url");
                writer.Add(url.Url);
                break;
            default:
                throw new ArgumentException("article_property_value_shape_invalid");
        }
    }

    private static string Compute(Action<DigestWriter> write)
    {
        using var stream = new MemoryStream();
        write(new DigestWriter(stream));
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private sealed class DigestWriter(Stream stream)
    {
        public void Add(string value)
        {
            ArgumentNullException.ThrowIfNull(value);
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            Add(bytes.Length);
            stream.Write(bytes);
        }

        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
            stream.Write(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
            stream.Write(bytes);
        }

        public void Add(long? value)
        {
            Add(value.HasValue ? 1 : 0);
            if (value.HasValue)
            {
                Add(value.Value);
            }
        }
    }
}
