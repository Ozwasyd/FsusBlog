using System.Reflection;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Contracts.Assets;

/// <summary>
/// Fail-closed validator for the unactivated content-asset domain contract and
/// its three schema models. It intentionally rejects URL/path identity, unknown
/// source kinds/states, malformed media metadata, duplicate reference keys and
/// schema drift before any production read/write path consumes the contract.
/// </summary>
public static class ContentAssetSchemaValidator
{
    public static void Validate(AssetRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        ValidateStorageClass(record.StorageClass);
        ValidateMimeType(record.MimeType);
        ValidateExtension(record.Extension);
        if (record.SizeBytes < 0)
        {
            throw new ArgumentException("Content asset size cannot be negative.", nameof(record));
        }

        ValidateSha256(record.Sha256);
        ValidateDimensions(record.MimeType, record.WidthPixels, record.HeightPixels);
        if (record.OwnerAdminPrincipalId <= 0)
        {
            throw new ArgumentException("Content asset owner principal must be positive when present.", nameof(record));
        }
        if (!Enum.IsDefined(record.State))
        {
            throw new ArgumentException("Content asset state is not a defined contract state.", nameof(record));
        }

        ValidateUtc(record.CreatedAtUtc, nameof(record));
        ValidateUtc(record.UpdatedAtUtc, nameof(record));
        if (record.UpdatedAtUtc < record.CreatedAtUtc)
        {
            throw new ArgumentException("Content asset updated timestamp precedes created timestamp.", nameof(record));
        }
    }

    public static void Validate(AssetReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);

        if (!ContentAssetSourceKinds.IsValid(reference.SourceKind))
        {
            throw new ArgumentException(
                "Content asset source kind must be one of article, draft or revision.",
                nameof(reference));
        }

        if (string.IsNullOrWhiteSpace(reference.SourceKey) || reference.SourceKey.Length > 160)
        {
            throw new ArgumentException(
                "Content asset source key must be a non-empty value of at most 160 characters.",
                nameof(reference));
        }

        if (reference.ReferenceCount <= 0)
        {
            throw new ArgumentException(
                "Content asset reference count must be positive.",
                nameof(reference));
        }


        if (reference.ArticleId <= 0)
        {
            throw new ArgumentException("Content asset article id must be positive when present.", nameof(reference));
        }

        if (reference.AltText?.Length > 256)
        {
            throw new ArgumentException("Content asset alt text cannot exceed 256 characters.", nameof(reference));
        }

        ValidateUtc(reference.UpdatedAtUtc, nameof(reference));
    }

    public static void ValidateReferences(IEnumerable<AssetReference> references)
    {
        ArgumentNullException.ThrowIfNull(references);

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (AssetReference reference in references)
        {
            Validate(reference);
            if (!seen.Add(reference.CompositeKey))
            {
                throw new InvalidOperationException(
                    $"Duplicate content asset reference key '{reference.CompositeKey}'.");
            }
        }
    }

    public static void Validate(ContentAsset entity)
    {
        ArgumentNullException.ThrowIfNull(entity);

        RequireAssetId(entity.AssetId);
        RequireStorageKey(entity.StorageKey);
        ValidateStorageClass(entity.StorageClass);
        ValidateMimeType(entity.MimeType);
        ValidateExtension(entity.Extension);
        if (entity.SizeBytes < 0)
        {
            throw new ArgumentException("Content asset size cannot be negative.", nameof(entity));
        }

        ValidateSha256(entity.Sha256);
        ValidateDimensions(entity.MimeType, entity.WidthPixels, entity.HeightPixels);
        if (entity.OwnerAdminPrincipalId <= 0)
        {
            throw new ArgumentException("Content asset owner principal must be positive when present.", nameof(entity));
        }
        if (!ContentAssetStates.IsValid(entity.State))
        {
            throw new ArgumentException(
                "Content asset state must be one of active or pending_delete.",
                nameof(entity));
        }

        ValidateUtc(entity.CreatedAtUtc, nameof(entity));
        ValidateUtc(entity.UpdatedAtUtc, nameof(entity));
        if (entity.UpdatedAtUtc < entity.CreatedAtUtc)
        {
            throw new ArgumentException(
                "Content asset updated timestamp precedes created timestamp.",
                nameof(entity));
        }
    }

    public static void Validate(ContentAssetReference entity)
    {
        ArgumentNullException.ThrowIfNull(entity);

        RequireAssetId(entity.AssetId);
        if (!ContentAssetSourceKinds.IsValid(entity.SourceKind))
        {
            throw new ArgumentException(
                "Content asset source kind must be one of article, draft or revision.",
                nameof(entity));
        }

        if (string.IsNullOrWhiteSpace(entity.SourceKey) || entity.SourceKey.Length > 160)
        {
            throw new ArgumentException(
                "Content asset source key must be a non-empty value of at most 160 characters.",
                nameof(entity));
        }

        if (entity.ReferenceCount <= 0)
        {
            throw new ArgumentException(
                "Content asset reference count must be positive.",
                nameof(entity));
        }


        if (entity.ArticleId <= 0)
        {
            throw new ArgumentException("Content asset article id must be positive when present.", nameof(entity));
        }

        if (entity.AltText?.Length > 256)
        {
            throw new ArgumentException("Content asset alt text cannot exceed 256 characters.", nameof(entity));
        }

        ValidateUtc(entity.UpdatedAtUtc, nameof(entity));
    }

    public static void Validate(ContentAssetCleanupQueueItem entity)
    {
        ArgumentNullException.ThrowIfNull(entity);

        RequireAssetId(entity.AssetId);
        if (entity.AttemptCount < 0)
        {
            throw new ArgumentException(
                "Content asset cleanup attempt count cannot be negative.",
                nameof(entity));
        }

        ValidateUtc(entity.NotBeforeUtc, nameof(entity));
        ValidateUtc(entity.UpdatedAtUtc, nameof(entity));
    }

    public static void ValidateSchema()
    {
        ValidateEntitySchema(
            typeof(ContentAsset),
            "content_asset",
            ["id"],
            ["id", "storage_class", "storage_key", "media_type", "extension", "byte_length", "width", "height", "state", "created_at_utc", "updated_at_utc"],
            rejectUrlIdentity: true,
            uniqueProperties: ["StorageKey"]);

        ValidateEntitySchema(
            typeof(ContentAssetReference),
            "content_asset_reference",
            ["asset_id", "source_kind", "source_key"],
            ["asset_id", "source_kind", "source_key", "article_id", "reference_count", "alt_text", "updated_at_utc"],
            rejectUrlIdentity: true,
            uniqueProperties: []);

        ValidateEntitySchema(
            typeof(ContentAssetCleanupQueueItem),
            "content_asset_cleanup_queue",
            ["asset_id"],
            ["asset_id", "not_before_utc", "attempt_count", "updated_at_utc"],
            rejectUrlIdentity: true,
            uniqueProperties: []);
    }

    public static void ValidateEntitySchema(
        Type entityType,
        string expectedTableName,
        string[] expectedPrimaryKeyColumns,
        string[] requiredColumns,
        bool rejectUrlIdentity,
        string[] uniqueProperties)
    {
        ArgumentNullException.ThrowIfNull(entityType);
        ArgumentNullException.ThrowIfNull(expectedPrimaryKeyColumns);
        ArgumentNullException.ThrowIfNull(requiredColumns);
        ArgumentNullException.ThrowIfNull(uniqueProperties);

        SugarTable? table = entityType.GetCustomAttribute<SugarTable>(inherit: false);
        if (table is null || !string.Equals(table.TableName, expectedTableName, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Entity {entityType.Name} must map to table '{expectedTableName}'.");
        }

        SugarColumnData[] columns = entityType
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(static property => new SugarColumnData(
                property,
                property.GetCustomAttribute<SugarColumn>(inherit: false)))
            .Where(static column => column.Attribute is not null)
            .ToArray();

        string[] primaryKeyColumns = columns
            .Where(static column => column.Attribute!.IsPrimaryKey)
            .Select(static column => column.Attribute!.ColumnName)
            .OrderBy(static column => column, StringComparer.Ordinal)
            .ToArray();
        string[] expectedPrimaryKeys = expectedPrimaryKeyColumns
            .OrderBy(static column => column, StringComparer.Ordinal)
            .ToArray();
        if (!primaryKeyColumns.SequenceEqual(expectedPrimaryKeys, StringComparer.Ordinal))
        {
            throw new InvalidOperationException(
                $"Entity {entityType.Name} primary key must be exactly "
                + $"[{string.Join(", ", expectedPrimaryKeyColumns)}], found [{string.Join(", ", primaryKeyColumns)}].");
        }

        string[] columnNames = columns
            .Select(static column => column.Attribute!.ColumnName)
            .ToArray();
        foreach (string requiredColumn in requiredColumns)
        {
            if (!columnNames.Contains(requiredColumn, StringComparer.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Entity {entityType.Name} is missing required column '{requiredColumn}'.");
            }
        }

        if (rejectUrlIdentity)
        {
            foreach (SugarColumnData column in columns)
            {
                if (column.Attribute!.ColumnName.Contains("url", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(column.Property.Name, "Url", StringComparison.Ordinal)
                    || string.Equals(column.Property.Name, "Path", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Entity {entityType.Name} must not expose URL or path identity.");
                }
            }
        }

        foreach (string uniqueProperty in uniqueProperties)
        {
            bool hasUniqueIndex = entityType
                .GetCustomAttributes<SugarIndexAttribute>(inherit: false)
                .Any(index => index.IsUnique
                    && index.IndexFields.Keys.Contains(uniqueProperty, StringComparer.Ordinal));
            if (!hasUniqueIndex)
            {
                throw new InvalidOperationException(
                    $"Entity {entityType.Name} must declare a unique index on '{uniqueProperty}'.");
            }
        }
    }

    private static void RequireAssetId(Guid value)
    {
        if (value == Guid.Empty)
        {
            throw new ArgumentException("Content asset id must be a non-empty UUID.", nameof(value));
        }
    }

    private static void RequireStorageKey(string value)
    {
        if (!AssetStorageKey.TryParse(value, out _))
        {
            throw new ArgumentException(
                "Content asset storage key must be a normalized relative key.",
                nameof(value));
        }
    }

    private static void ValidateMimeType(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 127
            || value.IndexOf('/') < 0)
        {
            throw new ArgumentException(
                "Content asset mime type must be a non-empty value of at most 127 characters containing '/'.",
                nameof(value));
        }
    }

    private static void ValidateStorageClass(string value)
    {
        if (value is not "public" and not "private")
        {
            throw new ArgumentException("Content asset storage class must be public or private.", nameof(value));
        }
    }

    private static void ValidateExtension(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 16
            || value[0] != '.'
            || value.Skip(1).Any(static character => !char.IsAsciiLetterOrDigit(character)))
        {
            throw new ArgumentException("Content asset extension must be a normalized dotted extension.", nameof(value));
        }
    }

    private static void ValidateSha256(string? value)
    {
        if (value is null)
        {
            return;
        }

        if (value.Length != 64
            || value.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException(
                "Content asset SHA-256 must be exactly 64 hexadecimal characters.",
                nameof(value));
        }
    }

    private static void ValidateDimensions(string mimeType, int? width, int? height)
    {
        if (width is null && height is null)
        {
            if (mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException(
                    "Image content assets must have positive width and height metadata.",
                    nameof(width));
            }
            return;
        }

        if (width is null || height is null || width <= 0 || height <= 0)
        {
            throw new ArgumentException(
                "Content asset dimensions must be both present and positive, or both absent.",
                nameof(width));
        }
    }

    private static void ValidateUtc(DateTimeOffset value, string parameterName)
    {
        if (value.Offset != TimeSpan.Zero)
        {
            throw new ArgumentException(
                "Content asset timestamps must be UTC.",
                parameterName);
        }
    }

    private sealed record SugarColumnData(
        PropertyInfo Property,
        SugarColumn? Attribute);
}
