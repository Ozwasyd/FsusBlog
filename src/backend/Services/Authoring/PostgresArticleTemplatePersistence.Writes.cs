using System.Data.Common;

using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class PostgresArticleTemplatePersistence
{
    private async Task InsertDefinitionAsync(ArticleTemplateDefinition definition)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_template_definition(
                schema_version, template_id, scope_kind, owner_admin_principal_id, name, name_key,
                description, status, revision, current_version_id, current_version_number,
                created_at_utc, updated_at_utc, content_digest)
            VALUES (
                @SchemaVersion, @TemplateId, @ScopeKind, @OwnerAdminPrincipalId, @Name, @NameKey,
                @Description, @Status, @Revision, @CurrentVersionId, @CurrentVersionNumber,
                @CreatedAtUtc, @UpdatedAtUtc, @ContentDigest);
            """,
            DefinitionParameters(definition)).ConfigureAwait(false);
    }

    private async Task UpdateDefinitionAsync(
        ArticleTemplateDefinition previous,
        ArticleTemplateDefinition definition)
    {
        var parameters = DefinitionParameters(definition).ToList();
        parameters.Add(new("@PreviousRevision", previous.Revision));
        int rows = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article_template_definition
            SET name = @Name,
                name_key = @NameKey,
                description = @Description,
                status = @Status,
                revision = @Revision,
                current_version_id = @CurrentVersionId,
                current_version_number = @CurrentVersionNumber,
                updated_at_utc = @UpdatedAtUtc,
                content_digest = @ContentDigest
            WHERE template_id = @TemplateId
              AND scope_kind = @ScopeKind
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND revision = @PreviousRevision;
            """,
            parameters.ToArray()).ConfigureAwait(false);
        if (rows != 1)
        {
            throw new ArticleTemplateConflictException("article_template_revision_cas_stale");
        }
    }

    private async Task InsertVersionAsync(ArticleTemplateVersion version)
    {
        ArticleTemplateDefaults defaults = version.Defaults;
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_template_version(
                schema_version, template_id, version_id, version_number,
                created_by_admin_principal_id, created_at_utc, source_bytes, variable_count,
                title_placeholder, summary_placeholder, category_id,
                rights_profile_id, rights_profile_revision,
                responsibility_profile_id, responsibility_profile_revision,
                prepublish_profile_id, prepublish_profile_revision,
                defaults_digest, content_digest)
            VALUES (
                @SchemaVersion, @TemplateId, @VersionId, @VersionNumber,
                @CreatedByAdminPrincipalId, @CreatedAtUtc, @SourceBytes, @VariableCount,
                @TitlePlaceholder, @SummaryPlaceholder, @CategoryId,
                @RightsProfileId, @RightsProfileRevision,
                @ResponsibilityProfileId, @ResponsibilityProfileRevision,
                @PrepublishProfileId, @PrepublishProfileRevision,
                @DefaultsDigest, @ContentDigest);
            """,
            new SugarParameter("@SchemaVersion", version.SchemaVersion),
            new SugarParameter("@TemplateId", version.TemplateId),
            new SugarParameter("@VersionId", version.VersionId),
            new SugarParameter("@VersionNumber", version.VersionNumber),
            new SugarParameter("@CreatedByAdminPrincipalId", version.CreatedByAdminPrincipalId),
            new SugarParameter("@CreatedAtUtc", version.CreatedAtUtc),
            new SugarParameter("@SourceBytes", version.Source.ToArray()),
            new SugarParameter("@VariableCount", version.Source.VariableTokens.Count),
            new SugarParameter("@TitlePlaceholder", DbValue(defaults.TitlePlaceholder)),
            new SugarParameter("@SummaryPlaceholder", DbValue(defaults.SummaryPlaceholder)),
            new SugarParameter(
                "@CategoryId",
                defaults.CategoryId.HasValue ? defaults.CategoryId.Value : DBNull.Value,
                System.Data.DbType.Int32),
            new SugarParameter(
                "@RightsProfileId",
                defaults.RightsProfile?.ProfileId is Guid rightsId ? rightsId : DBNull.Value,
                System.Data.DbType.Guid),
            new SugarParameter(
                "@RightsProfileRevision",
                defaults.RightsProfile?.Revision is long rightsRevision ? rightsRevision : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter(
                "@ResponsibilityProfileId",
                defaults.ResponsibilityProfile?.ProfileId is Guid responsibilityId ? responsibilityId : DBNull.Value,
                System.Data.DbType.Guid),
            new SugarParameter(
                "@ResponsibilityProfileRevision",
                defaults.ResponsibilityProfile?.Revision is long responsibilityRevision ? responsibilityRevision : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter(
                "@PrepublishProfileId",
                defaults.PrepublishProfile?.ProfileId is Guid prepublishId ? prepublishId : DBNull.Value,
                System.Data.DbType.Guid),
            new SugarParameter(
                "@PrepublishProfileRevision",
                defaults.PrepublishProfile?.Revision is long prepublishRevision ? prepublishRevision : DBNull.Value,
                System.Data.DbType.Int64),
            new SugarParameter("@DefaultsDigest", version.DefaultsDigest),
            new SugarParameter("@ContentDigest", version.ContentDigest)).ConfigureAwait(false);

        for (int index = 0; index < defaults.TagIds.Count; index++)
        {
            await db.Ado.ExecuteCommandAsync(
                "INSERT INTO article_template_version_tag(version_id, tag_index, tag_id) VALUES (@VersionId, @Index, @TagId);",
                new SugarParameter("@VersionId", version.VersionId),
                new SugarParameter("@Index", index),
                new SugarParameter("@TagId", defaults.TagIds[index])).ConfigureAwait(false);
        }
        for (int propertyIndex = 0; propertyIndex < defaults.PropertyDefaults.Count; propertyIndex++)
        {
            ArticleTemplatePropertyDefault property = defaults.PropertyDefaults[propertyIndex];
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_template_version_property_default(
                    version_id, property_index, definition_id, value_kind, canonical_value)
                VALUES (@VersionId, @PropertyIndex, @DefinitionId, @ValueKind, @CanonicalValue);
                """,
                new SugarParameter("@VersionId", version.VersionId),
                new SugarParameter("@PropertyIndex", propertyIndex),
                new SugarParameter("@DefinitionId", property.DefinitionId),
                new SugarParameter("@ValueKind", (short)property.ValueKind),
                new SugarParameter("@CanonicalValue", DbValue(property.CanonicalValue))).ConfigureAwait(false);
            for (int optionIndex = 0; optionIndex < property.OptionIds.Count; optionIndex++)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO article_template_version_property_option(
                        version_id, property_index, option_index, option_id)
                    VALUES (@VersionId, @PropertyIndex, @OptionIndex, @OptionId);
                    """,
                    new SugarParameter("@VersionId", version.VersionId),
                    new SugarParameter("@PropertyIndex", propertyIndex),
                    new SugarParameter("@OptionIndex", optionIndex),
                    new SugarParameter("@OptionId", property.OptionIds[optionIndex])).ConfigureAwait(false);
            }
        }
        for (int index = 0; index < defaults.AssetIds.Count; index++)
        {
            await db.Ado.ExecuteCommandAsync(
                "INSERT INTO article_template_version_asset(version_id, asset_index, asset_id) VALUES (@VersionId, @Index, @AssetId);",
                new SugarParameter("@VersionId", version.VersionId),
                new SugarParameter("@Index", index),
                new SugarParameter("@AssetId", defaults.AssetIds[index].Value)).ConfigureAwait(false);
        }
    }

    private async Task InsertReceiptAsync(ArticleTemplateWriteReceipt receipt)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_template_receipt(
                receipt_id, request_id, actor_admin_principal_id, command_kind, command_digest,
                template_id, version_id, version_number, scope_kind, owner_admin_principal_id,
                previous_scope_revision, scope_revision, previous_template_revision, template_revision,
                permission, permission_digest, defaults_digest, status, definition_digest, version_digest,
                delete_disposition, occurred_at_utc, audit_reference, audit_digest, content_digest)
            VALUES (
                @ReceiptId, @RequestId, @ActorAdminPrincipalId, @CommandKind, @CommandDigest,
                @TemplateId, @VersionId, @VersionNumber, @ScopeKind, @OwnerAdminPrincipalId,
                @PreviousScopeRevision, @ScopeRevision, @PreviousTemplateRevision, @TemplateRevision,
                @Permission, @PermissionDigest, @DefaultsDigest, @Status, @DefinitionDigest, @VersionDigest,
                @DeleteDisposition, @OccurredAtUtc, @AuditReference, @AuditDigest, @ContentDigest);
            """,
            ReceiptParameters(receipt)).ConfigureAwait(false);
    }

    private async Task<IdempotencyLookup?> ReadIdempotencyAsync(
        long actorAdminPrincipalId,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT command_digest, receipt_id
            FROM article_template_idempotency
            WHERE actor_admin_principal_id = @ActorAdminPrincipalId
              AND request_id = @RequestId;
            """,
            new SugarParameter("@ActorAdminPrincipalId", actorAdminPrincipalId),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new(reader.GetString(0), reader.GetGuid(1))
            : null;
    }

    private async Task<ArticleTemplateWriteReceipt?> ReadReceiptAsync(
        Guid receiptId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"SELECT {ReceiptColumns} FROM article_template_receipt WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@ReceiptId", receiptId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadReceipt(reader)
            : null;
    }

    private async Task<List<ArticleTemplateWriteReceipt>> ReadReceiptsAsync(
        Guid templateId,
        int limit,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticleTemplateWriteReceipt>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {ReceiptColumns}
            FROM article_template_receipt
            WHERE template_id = @TemplateId
            ORDER BY template_revision, receipt_id
            LIMIT @Limit;
            """,
            new SugarParameter("@TemplateId", templateId),
            new SugarParameter("@Limit", limit)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(ReadReceipt(reader));
        }
        return result;
    }

    private async Task<IReadOnlyList<ArticleTemplateIdempotencyRecord>> ReadIdempotencyForTemplateAsync(
        Guid templateId,
        int limit,
        CancellationToken cancellationToken)
    {
        var result = new List<ArticleTemplateIdempotencyRecord>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT i.actor_admin_principal_id, i.request_id, i.command_digest, i.receipt_id
            FROM article_template_idempotency i
            INNER JOIN article_template_receipt r ON r.receipt_id = i.receipt_id
            WHERE r.template_id = @TemplateId
            ORDER BY r.template_revision, i.receipt_id
            LIMIT @Limit;
            """,
            new SugarParameter("@TemplateId", templateId),
            new SugarParameter("@Limit", limit)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(reader.GetInt64(0), reader.GetGuid(1), reader.GetString(2), reader.GetGuid(3)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<ArticleTemplateAuditLink>> ReadAuditLinksAsync(
        IEnumerable<Guid> auditReferences,
        CancellationToken cancellationToken)
    {
        Guid[] references = [.. auditReferences.Distinct()];
        if (references.Length == 0)
        {
            return [];
        }

        var result = new List<ArticleTemplateAuditLink>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT replace(target_id, '-', '') AS audit_reference,
                   source, type, action, target_type, target_id, event_info,
                   reason_code, outcome, is_high_value
            FROM sys_audit_log
            WHERE target_type = 'article-template-receipt'
              AND replace(target_id, '-', '') = ANY(CAST(@AuditReferences AS text[]))
            ORDER BY id;
            """,
            new SugarParameter(
                "@AuditReferences",
                $"{{{string.Join(',', references.Select(static value => value.ToString("N")))}}}"))
            .ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!Guid.TryParseExact(reader.GetString(0), "N", out Guid auditReference))
            {
                throw new ArticleTemplateIntegrityException("article_template_audit_reference_invalid");
            }
            result.Add(new(
                auditReference,
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.GetString(8),
                reader.GetBoolean(9)));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private static void ValidateMutation(
        ArticleTemplateMutationSnapshot snapshot,
        ArticleTemplateMutation mutation,
        Guid templateId)
    {
        if (mutation.ExpectedScopeRevision != snapshot.ScopeRevision
            || mutation.Definition.TemplateId != templateId
            || mutation.Definition.Scope != snapshot.Scope
            || mutation.Receipt.TemplateId != templateId
            || mutation.Receipt.Scope != snapshot.Scope
            || mutation.Receipt.PreviousScopeRevision != snapshot.ScopeRevision)
        {
            throw new ArticleTemplateIntegrityException("article_template_mutation_plan_invalid");
        }
        if (mutation.PreviousDefinition != snapshot.TargetDefinition)
        {
            throw new ArticleTemplateIntegrityException("article_template_mutation_previous_state_invalid");
        }
        ArticleTemplateContract.ValidateDefinition(mutation.Definition);
        ArticleTemplateContract.ValidateReceipt(mutation.Receipt);
        if (mutation.VersionToInsert is not null)
        {
            ArticleTemplateContract.ValidateVersion(mutation.VersionToInsert);
            if (mutation.VersionToInsert.TemplateId != templateId
                || mutation.VersionToInsert.VersionId != mutation.Definition.CurrentVersionId
                || mutation.VersionToInsert.VersionNumber != mutation.Definition.CurrentVersionNumber)
            {
                throw new ArticleTemplateIntegrityException("article_template_mutation_version_binding_invalid");
            }
        }
    }

}
