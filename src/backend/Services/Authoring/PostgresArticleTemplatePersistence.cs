using System.Data.Common;

using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL adapter for the exact-one article-template authority. All mutations take a
/// scope advisory lock and atomically persist CAS state, immutable versions, receipt, and
/// idempotency binding.
/// </summary>
public sealed class PostgresArticleTemplatePersistence(ISqlSugarClient db)
    : IArticleTemplatePersistence
{
    private const string DefinitionColumns =
        "schema_version, template_id, scope_kind, owner_admin_principal_id, name, name_key, "
        + "description, status, revision, current_version_id, current_version_number, "
        + "created_at_utc, updated_at_utc, content_digest";

    private const string ReceiptColumns =
        "receipt_id, request_id, actor_admin_principal_id, command_kind, command_digest, "
        + "template_id, version_id, version_number, scope_kind, owner_admin_principal_id, "
        + "previous_scope_revision, scope_revision, previous_template_revision, template_revision, "
        + "permission, permission_digest, defaults_digest, status, definition_digest, version_digest, "
        + "delete_disposition, occurred_at_utc, audit_reference, audit_digest, content_digest";

    public async Task<ArticleTemplateDefinition?> GetAsync(
        Guid templateId,
        CancellationToken cancellationToken = default)
    {
        if (templateId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_id_invalid");
        }
        return await ReadDefinitionAsync(templateId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticleTemplatePage> ListAsync(
        ArticleTemplateScope scope,
        ArticleTemplatePageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateScope(scope);
        long ownerKey = ScopeOwnerKey(scope);
        string cursorPredicate = cursor is null
            ? string.Empty
            : "AND (name_key, template_id) > (@CursorNameKey, @CursorTemplateId)";
        var parameters = new List<SugarParameter>
        {
            new("@ScopeKind", (short)scope.Kind),
            new("@OwnerAdminPrincipalId", ownerKey),
            new("@Limit", limit + 1)
        };
        if (cursor is not null)
        {
            parameters.Add(new("@CursorNameKey", cursor.NameKey));
            parameters.Add(new("@CursorTemplateId", cursor.TemplateId));
        }

        var definitions = new List<ArticleTemplateDefinition>(limit + 1);
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {DefinitionColumns}
            FROM article_template_definition
            WHERE scope_kind = @ScopeKind
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND status <> 2
              {cursorPredicate}
            ORDER BY name_key, template_id
            LIMIT @Limit;
            """,
            parameters.ToArray()).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                definitions.Add(ReadDefinition(reader));
            }
        }

        bool hasMore = definitions.Count > limit;
        if (hasMore)
        {
            definitions.RemoveAt(definitions.Count - 1);
        }
        ArticleTemplateDefinition? last = definitions.LastOrDefault();
        long scopeRevision = await ReadScopeRevisionAsync(scope).ConfigureAwait(false);
        return new(
            Array.AsReadOnly(definitions.ToArray()),
            hasMore && last is not null ? new(last.NameKey, last.TemplateId) : null,
            scopeRevision);
    }

    public async Task<ArticleTemplateVersion?> GetVersionAsync(
        Guid templateId,
        Guid versionId,
        CancellationToken cancellationToken = default)
    {
        if (templateId == Guid.Empty || versionId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_version_id_invalid");
        }
        IReadOnlyList<ArticleTemplateVersion> versions = await ReadVersionsAsync(
            templateId,
            "AND version_id = @VersionId",
            [new("@VersionId", versionId)],
            limit: 1,
            cancellationToken).ConfigureAwait(false);
        return versions.SingleOrDefault();
    }

    public async Task<ArticleTemplateVersionPage> ListVersionsAsync(
        Guid templateId,
        int? afterVersionNumber,
        int limit,
        CancellationToken cancellationToken = default)
    {
        string cursorPredicate = afterVersionNumber.HasValue
            ? "AND version_number < @AfterVersionNumber"
            : string.Empty;
        var parameters = new List<SugarParameter>();
        if (afterVersionNumber.HasValue)
        {
            parameters.Add(new("@AfterVersionNumber", afterVersionNumber.Value));
        }
        IReadOnlyList<ArticleTemplateVersion> read = await ReadVersionsAsync(
            templateId,
            cursorPredicate,
            parameters,
            limit + 1,
            cancellationToken).ConfigureAwait(false);
        var versions = read.ToList();
        bool hasMore = versions.Count > limit;
        if (hasMore)
        {
            versions.RemoveAt(versions.Count - 1);
        }
        return new(
            Array.AsReadOnly(versions.ToArray()),
            hasMore ? versions[^1].VersionNumber : null);
    }

    public async Task<ArticleTemplateWriteReceipt> ExecuteAsync(
        ArticleTemplateScope scope,
        long actorAdminPrincipalId,
        Guid requestId,
        string commandDigest,
        Guid templateId,
        Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateScope(scope);
        ArgumentNullException.ThrowIfNull(planner);
        ArticleTemplateWriteReceipt? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2360));",
                new SugarParameter("@Identity", $"article-template:{(short)scope.Kind}:{ScopeOwnerKey(scope)}"))
                .ConfigureAwait(false);

            IdempotencyLookup? replay = await ReadIdempotencyAsync(
                actorAdminPrincipalId,
                requestId,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                if (!string.Equals(replay.CommandDigest, commandDigest, StringComparison.Ordinal))
                {
                    throw new ArticleTemplateConflictException("article_template_idempotency_conflict");
                }
                ArticleTemplateWriteReceipt stored = await ReadReceiptAsync(
                    replay.ReceiptId,
                    cancellationToken).ConfigureAwait(false)
                    ?? throw new ArticleTemplateIntegrityException("article_template_idempotency_receipt_missing");
                result = stored with
                {
                    IsIdempotentReplay = true
                };
                return;
            }

            await EnsureScopeAsync(scope).ConfigureAwait(false);
            long scopeRevision = await ReadScopeRevisionAsync(scope).ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateDefinition> definitions = await ReadScopeDefinitionsAsync(
                scope,
                cancellationToken).ConfigureAwait(false);
            ArticleTemplateDefinition? target = await ReadDefinitionAsync(templateId, cancellationToken)
                .ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateVersion> versions = target is null
                ? []
                : await ReadVersionsAsync(
                    templateId,
                    string.Empty,
                    [],
                    ArticleTemplateContract.MaxVersionsPerTemplate + 1,
                    cancellationToken).ConfigureAwait(false);
            long usageCount = target is null
                ? 0
                : await ReadUsageCountAsync(templateId).ConfigureAwait(false);
            var snapshot = new ArticleTemplateMutationSnapshot(
                scope,
                scopeRevision,
                definitions,
                target,
                versions,
                usageCount);
            ArticleTemplateMutation mutation = await planner(snapshot, cancellationToken).ConfigureAwait(false);
            ValidateMutation(snapshot, mutation, templateId);

            int scopeRows = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE article_template_scope
                SET revision = @ScopeRevision
                WHERE scope_kind = @ScopeKind
                  AND owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND revision = @ExpectedScopeRevision;
                """,
                new SugarParameter("@ScopeRevision", mutation.Receipt.ScopeRevision),
                new SugarParameter("@ScopeKind", (short)scope.Kind),
                new SugarParameter("@OwnerAdminPrincipalId", ScopeOwnerKey(scope)),
                new SugarParameter("@ExpectedScopeRevision", mutation.ExpectedScopeRevision))
                .ConfigureAwait(false);
            if (scopeRows != 1)
            {
                throw new ArticleTemplateConflictException("article_template_scope_revision_cas_stale");
            }

            if (mutation.PreviousDefinition is null)
            {
                await InsertDefinitionAsync(mutation.Definition).ConfigureAwait(false);
            }
            else
            {
                await UpdateDefinitionAsync(mutation.PreviousDefinition, mutation.Definition)
                    .ConfigureAwait(false);
            }
            if (mutation.VersionToInsert is not null)
            {
                await InsertVersionAsync(mutation.VersionToInsert).ConfigureAwait(false);
            }
            await InsertReceiptAsync(mutation.Receipt).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_template_idempotency(
                    actor_admin_principal_id, request_id, command_digest, receipt_id, created_at_utc)
                VALUES (@ActorAdminPrincipalId, @RequestId, @CommandDigest, @ReceiptId, @CreatedAtUtc);
                """,
                new SugarParameter("@ActorAdminPrincipalId", actorAdminPrincipalId),
                new SugarParameter("@RequestId", requestId),
                new SugarParameter("@CommandDigest", commandDigest),
                new SugarParameter("@ReceiptId", mutation.Receipt.ReceiptId),
                new SugarParameter("@CreatedAtUtc", mutation.Receipt.OccurredAtUtc))
                .ConfigureAwait(false);
            result = mutation.Receipt;
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("article_template_transaction_failed");
        }
        return result ?? throw new ArticleTemplateIntegrityException("article_template_transaction_result_missing");
    }

    public async Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid templateId,
        int receiptLimit,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateVerificationSnapshot? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ArticleTemplateDefinition? definition = await ReadDefinitionAsync(templateId, cancellationToken)
                .ConfigureAwait(false);
            if (definition is null)
            {
                return;
            }
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2360));",
                new SugarParameter(
                    "@Identity",
                    $"article-template:{(short)definition.Scope.Kind}:{ScopeOwnerKey(definition.Scope)}"))
                .ConfigureAwait(false);
            definition = await ReadDefinitionAsync(templateId, cancellationToken).ConfigureAwait(false)
                ?? throw new ArticleTemplateIntegrityException("article_template_definition_missing_during_verify");
            IReadOnlyList<ArticleTemplateVersion> versions = await ReadVersionsAsync(
                templateId,
                string.Empty,
                [],
                ArticleTemplateContract.MaxVersionsPerTemplate + 1,
                cancellationToken).ConfigureAwait(false);
            List<ArticleTemplateWriteReceipt> receipts = await ReadReceiptsAsync(
                templateId,
                receiptLimit + 1,
                cancellationToken).ConfigureAwait(false);
            bool receiptLimitExceeded = receipts.Count > receiptLimit;
            if (receiptLimitExceeded)
            {
                receipts.RemoveAt(receipts.Count - 1);
            }
            IReadOnlyList<ArticleTemplateIdempotencyRecord> idempotency = await ReadIdempotencyForTemplateAsync(
                templateId,
                receiptLimit + 1,
                cancellationToken).ConfigureAwait(false);
            IReadOnlyList<ArticleTemplateAuditLink> auditLinks = await ReadAuditLinksAsync(
                receipts.Select(static receipt => receipt.AuditReference),
                cancellationToken).ConfigureAwait(false);
            result = new(
                definition,
                versions,
                Array.AsReadOnly(receipts.ToArray()),
                idempotency,
                auditLinks,
                receiptLimitExceeded || idempotency.Count > receiptLimit);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("article_template_verification_read_failed");
        }
        return result;
    }

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
            new SugarParameter("@CategoryId", DbValue(defaults.CategoryId)),
            new SugarParameter("@RightsProfileId", DbValue(defaults.RightsProfile?.ProfileId)),
            new SugarParameter("@RightsProfileRevision", DbValue(defaults.RightsProfile?.Revision)),
            new SugarParameter("@ResponsibilityProfileId", DbValue(defaults.ResponsibilityProfile?.ProfileId)),
            new SugarParameter("@ResponsibilityProfileRevision", DbValue(defaults.ResponsibilityProfile?.Revision)),
            new SugarParameter("@PrepublishProfileId", DbValue(defaults.PrepublishProfile?.ProfileId)),
            new SugarParameter("@PrepublishProfileRevision", DbValue(defaults.PrepublishProfile?.Revision)),
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
            new("@VersionId", DbValue(receipt.VersionId)),
            new("@VersionNumber", DbValue(receipt.VersionNumber)),
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
