using System.Data.Common;

using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class PostgresArticleTemplatePersistence
{
    private async Task EnsureScopeAsync(ArticleTemplateScope scope)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_template_scope(scope_kind, owner_admin_principal_id, revision)
            VALUES (@ScopeKind, @OwnerAdminPrincipalId, 0)
            ON CONFLICT (scope_kind, owner_admin_principal_id) DO NOTHING;
            """,
            new SugarParameter("@ScopeKind", (short)scope.Kind),
            new SugarParameter("@OwnerAdminPrincipalId", ScopeOwnerKey(scope))).ConfigureAwait(false);
    }

    private async Task<long> ReadUsageCountAsync(Guid templateId)
    {
        object? value = await db.Ado.GetScalarAsync(
            "SELECT COUNT(*) FROM article_template_version_usage WHERE template_id = @TemplateId;",
            new SugarParameter("@TemplateId", templateId)).ConfigureAwait(false);
        return value is null or DBNull
            ? 0
            : Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    private async Task<long> ReadScopeRevisionAsync(ArticleTemplateScope scope)
    {
        object? value = await db.Ado.GetScalarAsync(
            """
            SELECT revision
            FROM article_template_scope
            WHERE scope_kind = @ScopeKind
              AND owner_admin_principal_id = @OwnerAdminPrincipalId;
            """,
            new SugarParameter("@ScopeKind", (short)scope.Kind),
            new SugarParameter("@OwnerAdminPrincipalId", ScopeOwnerKey(scope))).ConfigureAwait(false);
        return value is null or DBNull ? 0 : Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    private async Task<ArticleTemplateDefinition?> ReadDefinitionAsync(
        Guid templateId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {DefinitionColumns}
            FROM article_template_definition
            WHERE template_id = @TemplateId;
            """,
            new SugarParameter("@TemplateId", templateId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadDefinition(reader)
            : null;
    }

    private async Task<IReadOnlyList<ArticleTemplateDefinition>> ReadScopeDefinitionsAsync(
        ArticleTemplateScope scope,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticleTemplateDefinition>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {DefinitionColumns}
            FROM article_template_definition
            WHERE scope_kind = @ScopeKind
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND status <> 2
            ORDER BY name_key, template_id
            LIMIT @Limit;
            """,
            new SugarParameter("@ScopeKind", (short)scope.Kind),
            new SugarParameter("@OwnerAdminPrincipalId", ScopeOwnerKey(scope)),
            new SugarParameter("@Limit", ArticleTemplateContract.MaxTemplatesPerScope + 1))
            .ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(ReadDefinition(reader));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticleTemplateVersion>> ReadVersionsAsync(
        Guid templateId,
        string additionalPredicate,
        IReadOnlyList<SugarParameter> additionalParameters,
        int limit,
        CancellationToken cancellationToken)
    {
        var rows = new List<VersionRow>();
        var parameters = new List<SugarParameter>
        {
            new("@TemplateId", templateId),
            new("@Limit", limit)
        };
        parameters.AddRange(additionalParameters);
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT schema_version, template_id, version_id, version_number,
                   created_by_admin_principal_id, created_at_utc, source_bytes,
                   variable_count, title_placeholder, summary_placeholder, category_id,
                   rights_profile_id, rights_profile_revision,
                   responsibility_profile_id, responsibility_profile_revision,
                   prepublish_profile_id, prepublish_profile_revision,
                   defaults_digest, content_digest
            FROM article_template_version
            WHERE template_id = @TemplateId
              {additionalPredicate}
            ORDER BY version_number DESC
            LIMIT @Limit;
            """,
            parameters.ToArray()).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(new(
                    reader.GetInt32(reader.GetOrdinal("schema_version")),
                    reader.GetGuid(reader.GetOrdinal("template_id")),
                    reader.GetGuid(reader.GetOrdinal("version_id")),
                    reader.GetInt32(reader.GetOrdinal("version_number")),
                    reader.GetInt64(reader.GetOrdinal("created_by_admin_principal_id")),
                    ReadUtc(reader, "created_at_utc"),
                    reader.GetFieldValue<byte[]>(reader.GetOrdinal("source_bytes")),
                    reader.GetInt32(reader.GetOrdinal("variable_count")),
                    ReadNullableString(reader, "title_placeholder"),
                    ReadNullableString(reader, "summary_placeholder"),
                    ReadNullableInt32(reader, "category_id"),
                    ReadProfile(reader, "rights_profile"),
                    ReadProfile(reader, "responsibility_profile"),
                    ReadProfile(reader, "prepublish_profile"),
                    reader.GetString(reader.GetOrdinal("defaults_digest")),
                    reader.GetString(reader.GetOrdinal("content_digest"))));
            }
        }
        if (rows.Count == 0)
        {
            return [];
        }

        string versionIds = FormatUuidArray(rows.Select(static row => row.VersionId));
        Dictionary<Guid, List<IndexedInt>> tags = await ReadIndexedIntsAsync(
            "article_template_version_tag",
            "tag_index",
            "tag_id",
            versionIds,
            cancellationToken).ConfigureAwait(false);
        Dictionary<Guid, List<IndexedGuid>> assets = await ReadIndexedGuidsAsync(
            "article_template_version_asset",
            "asset_index",
            "asset_id",
            versionIds,
            cancellationToken).ConfigureAwait(false);
        Dictionary<Guid, List<PropertyRow>> properties = await ReadPropertiesAsync(versionIds, cancellationToken)
            .ConfigureAwait(false);
        Dictionary<(Guid VersionId, int PropertyIndex), List<IndexedGuid>> options =
            await ReadPropertyOptionsAsync(versionIds, cancellationToken).ConfigureAwait(false);

        var versions = new List<ArticleTemplateVersion>(rows.Count);
        foreach (VersionRow row in rows)
        {
            ArticleTemplateSource source = ArticleTemplateSource.FromBytes(row.SourceBytes);
            if (source.VariableTokens.Count != row.VariableCount)
            {
                throw new ArticleTemplateIntegrityException("article_template_variable_count_tamper");
            }
            int[] tagIds = ValidateAndProjectIndexes(tags.GetValueOrDefault(row.VersionId), static item => item.Index, static item => item.Value);
            Guid[] assetValues = ValidateAndProjectIndexes(assets.GetValueOrDefault(row.VersionId), static item => item.Index, static item => item.Value);
            PropertyRow[] propertyRows = ValidateAndProjectIndexes(
                properties.GetValueOrDefault(row.VersionId),
                static item => item.Index,
                static item => item);
            var propertyDefaults = new List<ArticleTemplatePropertyDefault>(propertyRows.Length);
            foreach (PropertyRow property in propertyRows)
            {
                Guid[] optionIds = ValidateAndProjectIndexes(
                    options.GetValueOrDefault((row.VersionId, property.Index)),
                    static item => item.Index,
                    static item => item.Value);
                propertyDefaults.Add(new(
                    property.DefinitionId,
                    property.ValueKind,
                    property.CanonicalValue,
                    optionIds));
            }
            var defaults = new ArticleTemplateDefaults(
                row.TitlePlaceholder,
                row.SummaryPlaceholder,
                row.CategoryId,
                tagIds,
                propertyDefaults,
                assetValues.Select(AssetId.FromGuid),
                row.RightsProfile,
                row.ResponsibilityProfile,
                row.PrepublishProfile);
            var version = new ArticleTemplateVersion(
                row.SchemaVersion,
                row.TemplateId,
                row.VersionId,
                row.VersionNumber,
                row.CreatedByAdminPrincipalId,
                row.CreatedAtUtc,
                source,
                defaults,
                row.DefaultsDigest,
                row.ContentDigest);
            versions.Add(version);
        }
        return Array.AsReadOnly(versions.ToArray());
    }

    private async Task<Dictionary<Guid, List<IndexedInt>>> ReadIndexedIntsAsync(
        string table,
        string indexColumn,
        string valueColumn,
        string versionIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, List<IndexedInt>>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT version_id, {indexColumn}, {valueColumn}
            FROM {table}
            WHERE version_id = ANY(CAST(@VersionIds AS uuid[]))
            ORDER BY version_id, {indexColumn};
            """,
            new SugarParameter("@VersionIds", versionIds)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid versionId = reader.GetGuid(0);
            GetOrAdd(result, versionId).Add(new(reader.GetInt32(1), reader.GetInt32(2)));
        }
        return result;
    }

    private async Task<Dictionary<Guid, List<IndexedGuid>>> ReadIndexedGuidsAsync(
        string table,
        string indexColumn,
        string valueColumn,
        string versionIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, List<IndexedGuid>>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT version_id, {indexColumn}, {valueColumn}
            FROM {table}
            WHERE version_id = ANY(CAST(@VersionIds AS uuid[]))
            ORDER BY version_id, {indexColumn};
            """,
            new SugarParameter("@VersionIds", versionIds)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid versionId = reader.GetGuid(0);
            GetOrAdd(result, versionId).Add(new(reader.GetInt32(1), reader.GetGuid(2)));
        }
        return result;
    }

    private async Task<Dictionary<Guid, List<PropertyRow>>> ReadPropertiesAsync(
        string versionIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, List<PropertyRow>>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT version_id, property_index, definition_id, value_kind, canonical_value
            FROM article_template_version_property_default
            WHERE version_id = ANY(CAST(@VersionIds AS uuid[]))
            ORDER BY version_id, property_index;
            """,
            new SugarParameter("@VersionIds", versionIds)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid versionId = reader.GetGuid(0);
            GetOrAdd(result, versionId).Add(new(
                reader.GetInt32(1),
                reader.GetGuid(2),
                (ArticleTemplatePropertyValueKind)reader.GetInt16(3),
                reader.IsDBNull(4) ? null : reader.GetString(4)));
        }
        return result;
    }

    private async Task<Dictionary<(Guid VersionId, int PropertyIndex), List<IndexedGuid>>> ReadPropertyOptionsAsync(
        string versionIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<(Guid, int), List<IndexedGuid>>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT version_id, property_index, option_index, option_id
            FROM article_template_version_property_option
            WHERE version_id = ANY(CAST(@VersionIds AS uuid[]))
            ORDER BY version_id, property_index, option_index;
            """,
            new SugarParameter("@VersionIds", versionIds)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var key = (reader.GetGuid(0), reader.GetInt32(1));
            GetOrAdd(result, key).Add(new(reader.GetInt32(2), reader.GetGuid(3)));
        }
        return result;
    }

}
