using System.Data.Common;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class PostgresArticleTemplatePersistence
{
    private static ArticleTemplateDefinition ReadDefinition(DbDataReader reader)
        => new(
            reader.GetInt32(reader.GetOrdinal("schema_version")),
            reader.GetGuid(reader.GetOrdinal("template_id")),
            ReadScope(reader),
            reader.GetString(reader.GetOrdinal("name")),
            reader.GetString(reader.GetOrdinal("name_key")),
            ReadNullableString(reader, "description"),
            (ArticleTemplateStatus)reader.GetInt16(reader.GetOrdinal("status")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetGuid(reader.GetOrdinal("current_version_id")),
            reader.GetInt32(reader.GetOrdinal("current_version_number")),
            ReadUtc(reader, "created_at_utc"),
            ReadUtc(reader, "updated_at_utc"),
            reader.GetString(reader.GetOrdinal("content_digest")));

    private static ArticleTemplateWriteReceipt ReadReceipt(DbDataReader reader)
        => new(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            reader.GetGuid(reader.GetOrdinal("request_id")),
            reader.GetInt64(reader.GetOrdinal("actor_admin_principal_id")),
            reader.GetString(reader.GetOrdinal("command_kind")),
            reader.GetString(reader.GetOrdinal("command_digest")),
            reader.GetGuid(reader.GetOrdinal("template_id")),
            ReadNullableGuid(reader, "version_id"),
            ReadNullableInt32(reader, "version_number"),
            ReadScope(reader),
            reader.GetInt64(reader.GetOrdinal("previous_scope_revision")),
            reader.GetInt64(reader.GetOrdinal("scope_revision")),
            reader.GetInt64(reader.GetOrdinal("previous_template_revision")),
            reader.GetInt64(reader.GetOrdinal("template_revision")),
            (ArticleTemplatePermission)reader.GetInt16(reader.GetOrdinal("permission")),
            reader.GetString(reader.GetOrdinal("permission_digest")),
            reader.GetString(reader.GetOrdinal("defaults_digest")),
            (ArticleTemplateStatus)reader.GetInt16(reader.GetOrdinal("status")),
            reader.GetString(reader.GetOrdinal("definition_digest")),
            reader.GetString(reader.GetOrdinal("version_digest")),
            (ArticleTemplateDeleteDisposition)reader.GetInt16(reader.GetOrdinal("delete_disposition")),
            ReadUtc(reader, "occurred_at_utc"),
            reader.GetGuid(reader.GetOrdinal("audit_reference")),
            reader.GetString(reader.GetOrdinal("audit_digest")),
            reader.GetString(reader.GetOrdinal("content_digest")));

    private static ArticleTemplateScope ReadScope(DbDataReader reader)
    {
        var kind = (ArticleTemplateScopeKind)reader.GetInt16(reader.GetOrdinal("scope_kind"));
        long ownerKey = reader.GetInt64(reader.GetOrdinal("owner_admin_principal_id"));
        return new(kind, kind == ArticleTemplateScopeKind.Personal ? ownerKey : null);
    }

    private static SugarParameter[] DefinitionParameters(ArticleTemplateDefinition definition)
        =>
        [
            new("@SchemaVersion", definition.SchemaVersion),
            new("@TemplateId", definition.TemplateId),
            new("@ScopeKind", (short)definition.Scope.Kind),
            new("@OwnerAdminPrincipalId", ScopeOwnerKey(definition.Scope)),
            new("@Name", definition.Name),
            new("@NameKey", definition.NameKey),
            new("@Description", DbValue(definition.Description)),
            new("@Status", (short)definition.Status),
            new("@Revision", definition.Revision),
            new("@CurrentVersionId", definition.CurrentVersionId),
            new("@CurrentVersionNumber", definition.CurrentVersionNumber),
            new("@CreatedAtUtc", definition.CreatedAtUtc),
            new("@UpdatedAtUtc", definition.UpdatedAtUtc),
            new("@ContentDigest", definition.ContentDigest)
        ];

    private static SugarParameter[] ReceiptParameters(ArticleTemplateWriteReceipt receipt)
        =>
        [
            new("@ReceiptId", receipt.ReceiptId),
            new("@RequestId", receipt.RequestId),
            new("@ActorAdminPrincipalId", receipt.ActorAdminPrincipalId),
            new("@CommandKind", receipt.CommandKind),
            new("@CommandDigest", receipt.CommandDigest),
            new("@TemplateId", receipt.TemplateId),
            new(
                "@VersionId",
                receipt.VersionId.HasValue ? receipt.VersionId.Value : DBNull.Value,
                System.Data.DbType.Guid),
            new(
                "@VersionNumber",
                receipt.VersionNumber.HasValue ? receipt.VersionNumber.Value : DBNull.Value,
                System.Data.DbType.Int32),
            new("@ScopeKind", (short)receipt.Scope.Kind),
            new("@OwnerAdminPrincipalId", ScopeOwnerKey(receipt.Scope)),
            new("@PreviousScopeRevision", receipt.PreviousScopeRevision),
            new("@ScopeRevision", receipt.ScopeRevision),
            new("@PreviousTemplateRevision", receipt.PreviousTemplateRevision),
            new("@TemplateRevision", receipt.TemplateRevision),
            new("@Permission", (short)receipt.Permission),
            new("@PermissionDigest", receipt.PermissionDigest),
            new("@DefaultsDigest", receipt.DefaultsDigest),
            new("@Status", (short)receipt.Status),
            new("@DefinitionDigest", receipt.DefinitionDigest),
            new("@VersionDigest", receipt.VersionDigest),
            new("@DeleteDisposition", (short)receipt.DeleteDisposition),
            new("@OccurredAtUtc", receipt.OccurredAtUtc),
            new("@AuditReference", receipt.AuditReference),
            new("@AuditDigest", receipt.AuditDigest),
            new("@ContentDigest", receipt.ContentDigest)
        ];

    private static long ScopeOwnerKey(ArticleTemplateScope scope)
        => scope.Kind == ArticleTemplateScopeKind.Site
            ? 0
            : scope.OwnerAdminPrincipalId!.Value;

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static Guid? ReadNullableGuid(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    }

    private static ArticleTemplateProfileReference? ReadProfile(DbDataReader reader, string prefix)
    {
        Guid? id = ReadNullableGuid(reader, $"{prefix}_id");
        if (!id.HasValue)
        {
            return null;
        }
        int revisionOrdinal = reader.GetOrdinal($"{prefix}_revision");
        if (reader.IsDBNull(revisionOrdinal))
        {
            throw new ArticleTemplateIntegrityException("article_template_profile_revision_missing");
        }
        return new(id.Value, reader.GetInt64(revisionOrdinal));
    }

    private static DateTime ReadUtc(DbDataReader reader, string name)
        => DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal(name)), DateTimeKind.Utc);

    private static object DbValue(object? value) => value ?? DBNull.Value;

    private static string FormatUuidArray(IEnumerable<Guid> values)
        => $"{{{string.Join(',', values.Select(static value => value.ToString("D")))}}}";

    private static List<TValue> GetOrAdd<TKey, TValue>(Dictionary<TKey, List<TValue>> dictionary, TKey key)
        where TKey : notnull
    {
        if (!dictionary.TryGetValue(key, out List<TValue>? value))
        {
            value = [];
            dictionary.Add(key, value);
        }
        return value;
    }

    private static TValue[] ValidateAndProjectIndexes<TItem, TValue>(
        IReadOnlyList<TItem>? items,
        Func<TItem, int> index,
        Func<TItem, TValue> value)
    {
        if (items is null)
        {
            return [];
        }
        for (int current = 0; current < items.Count; current++)
        {
            if (index(items[current]) != current)
            {
                throw new ArticleTemplateIntegrityException("article_template_child_index_tamper");
            }
        }
        return [.. items.Select(value)];
    }

    private sealed record VersionRow(
        int SchemaVersion,
        Guid TemplateId,
        Guid VersionId,
        int VersionNumber,
        long CreatedByAdminPrincipalId,
        DateTime CreatedAtUtc,
        byte[] SourceBytes,
        int VariableCount,
        string? TitlePlaceholder,
        string? SummaryPlaceholder,
        int? CategoryId,
        ArticleTemplateProfileReference? RightsProfile,
        ArticleTemplateProfileReference? ResponsibilityProfile,
        ArticleTemplateProfileReference? PrepublishProfile,
        string DefaultsDigest,
        string ContentDigest);

    private sealed record IndexedInt(int Index, int Value);
    private sealed record IndexedGuid(int Index, Guid Value);
    private sealed record PropertyRow(
        int Index,
        Guid DefinitionId,
        ArticleTemplatePropertyValueKind ValueKind,
        string? CanonicalValue);
    private sealed record IdempotencyLookup(string CommandDigest, Guid ReceiptId);
}
