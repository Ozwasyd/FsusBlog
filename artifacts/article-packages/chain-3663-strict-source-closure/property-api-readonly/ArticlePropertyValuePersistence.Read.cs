using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class ArticlePropertyValuePersistence
{
    public async Task<ArticlePropertyValuePersistedSnapshot?> ReadSnapshotAsync(
        ArticlePropertyDefinitionOwner owner, int articleId, Guid snapshotId,
        CancellationToken cancellationToken = default)
    {
        ValidateScope(owner, articleId);
        Guid factsetId;
        long propertyRevision;
        long revisionId;
        long? draftId;
        long? draftRevision;
        long? publicationId;
        string snapshotDigest;
        string factsetDigest;
        int count;
        Guid auditReference;
        string chain;
        string hash;
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT s.factset_id, f.property_revision, s.article_revision_id, s.draft_id, s.draft_server_revision,
                s.publication_id, s.content_digest, f.content_digest, f.value_count,
                s.audit_reference, s.audit_chain_id, s.audit_record_hash, s.schema_version, f.schema_version
            FROM article_property_value_snapshot s JOIN article_property_value_factset f ON f.factset_id = s.factset_id
            WHERE s.snapshot_id = @Snapshot AND f.owner_user_key = @Owner AND f.site_scope = @Site AND f.article_id = @Article;
            """, (SugarParameter[])[.. Scope(owner, articleId), new("@Snapshot", snapshotId)]).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            factsetId = reader.GetGuid(0);
            propertyRevision = reader.GetInt64(1);
            revisionId = reader.GetInt64(2);
            draftId = Nullable<long>(reader, 3);
            draftRevision = Nullable<long>(reader, 4);
            publicationId = Nullable<long>(reader, 5);
            snapshotDigest = reader.GetString(6);
            factsetDigest = reader.GetString(7);
            count = reader.GetInt32(8);
            auditReference = reader.GetGuid(9);
            chain = reader.GetString(10);
            hash = reader.GetString(11);
            if (reader.GetInt32(12) != 1 || reader.GetInt32(13) != 1 || draftId.HasValue || draftRevision.HasValue)
            {
                throw Integrity("article_property_value_snapshot_schema_or_draft_unavailable");
            }
        }
        await AdmitFactsetAsync(factsetId, count, cancellationToken).ConfigureAwait(false);
        (IReadOnlyList<ArticlePropertyValueEntry> values, IReadOnlyDictionary<Guid, ArticlePropertyValueType> types)
            = await ReadValuesAsync(factsetId, cancellationToken).ConfigureAwait(false);
        if (values.Count != count || ComputeFactsetDigest(values, types) != factsetDigest)
        {
            throw Integrity("article_property_value_factset_digest_invalid");
        }
        var snapshot = new ArticlePropertyValueSnapshot(1, new(owner.UserId, owner.SiteScope, articleId,
            propertyRevision, revisionId, PublicationId: publicationId), values, snapshotDigest);
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(snapshot);
        await RequireActualCoordinatesAsync(articleId, revisionId, publicationId, cancellationToken).ConfigureAwait(false);
        if (auditReference != snapshotId)
        {
            throw Integrity("article_property_value_snapshot_audit_identity_invalid");
        }
        await VerifyAuditAsync(auditReference, "article-property-value-snapshot", SnapshotAuditAction,
            SnapshotAuditEvent(snapshotId, factsetId, factsetDigest, snapshotDigest), chain, hash,
            null, null, cancellationToken).ConfigureAwait(false);
        return new(snapshotId, factsetId, snapshot, auditReference, chain, hash);
    }

    private async Task AdmitFactsetAsync(Guid id, int expectedCount, CancellationToken cancellationToken)
    {
        if (expectedCount is < 0 or > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw Integrity("article_property_value_storage_budget_exceeded");
        }
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT count(*), COALESCE(sum(256::bigint + COALESCE(octet_length(text_value), 0)), 0)
                + 64::bigint * (SELECT count(*) FROM article_property_value_option WHERE factset_id = @Id)
                + 64::bigint * (SELECT count(*) FROM article_property_value_reference WHERE factset_id = @Id)
            FROM article_property_value_entry WHERE factset_id = @Id;
            """, new SugarParameter("@Id", id)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.GetInt64(0) != expectedCount
            || reader.GetDecimal(1) > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
        {
            throw Integrity("article_property_value_storage_budget_exceeded");
        }
    }

    private sealed record StoredValue(Guid Id, long Revision, string DefinitionDigest, ArticlePropertyValueType Type,
        ArticlePropertyValuePresence Presence, bool DefaultApplied, string Digest, string? Text,
        decimal? Number, bool? Boolean, long? DateTicks, Guid? SingleOption);

    private async Task<(IReadOnlyList<ArticlePropertyValueEntry>, IReadOnlyDictionary<Guid, ArticlePropertyValueType>)>
        ReadValuesAsync(Guid id, CancellationToken cancellationToken)
    {
        var rows = new List<StoredValue>();
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT definition_id, definition_schema_revision, definition_digest, value_type, presence,
                default_applied, value_digest, text_value, number_value, boolean_value, date_utc_ticks, single_option_id
            FROM article_property_value_entry WHERE factset_id = @Id ORDER BY definition_id;
            """, new SugarParameter("@Id", id)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(new(reader.GetGuid(0), reader.GetInt64(1), reader.GetString(2),
                    (ArticlePropertyValueType)reader.GetInt16(3), (ArticlePropertyValuePresence)reader.GetInt16(4),
                    reader.GetBoolean(5), reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7),
                    Nullable<decimal>(reader, 8), Nullable<bool>(reader, 9), Nullable<long>(reader, 10),
                    Nullable<Guid>(reader, 11)));
                if (rows.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
                {
                    throw Integrity("article_property_value_storage_budget_exceeded");
                }
            }
        }
        Dictionary<Guid, IReadOnlyList<Guid>> options = await ReadChildrenAsync<Guid>(
            "article_property_value_option", "option_id", id, cancellationToken).ConfigureAwait(false);
        Dictionary<Guid, IReadOnlyList<long>> references = await ReadChildrenAsync<long>(
            "article_property_value_reference", "target_article_id", id, cancellationToken).ConfigureAwait(false);
        var values = new List<ArticlePropertyValueEntry>(rows.Count);
        var types = new Dictionary<Guid, ArticlePropertyValueType>();
        foreach (StoredValue row in rows)
        {
            int scalarCount = (row.Text is null ? 0 : 1) + (row.Number.HasValue ? 1 : 0)
                + (row.Boolean.HasValue ? 1 : 0) + (row.DateTicks.HasValue ? 1 : 0) + (row.SingleOption.HasValue ? 1 : 0);
            bool hasOptions = options.TryGetValue(row.Id, out IReadOnlyList<Guid>? optionIds);
            bool hasReferences = references.TryGetValue(row.Id, out IReadOnlyList<long>? targetIds);
            if (!Enum.IsDefined(row.Type) || !Enum.IsDefined(row.Presence)
                || row.Presence != ArticlePropertyValuePresence.Present && (scalarCount != 0 || hasOptions || hasReferences)
                || hasOptions && row.Type != ArticlePropertyValueType.MultiSelect
                || hasReferences && row.Type != ArticlePropertyValueType.ArticleReference)
            {
                throw Integrity("article_property_value_storage_shape_invalid");
            }
            ArticlePropertyTypedValue? payload = null;
            if (row.Presence == ArticlePropertyValuePresence.Present)
            {
                bool set = row.Type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
                if (scalarCount != (set ? 0 : 1))
                {
                    throw Integrity("article_property_value_storage_shape_invalid");
                }
                payload = row.Type switch
                {
                    ArticlePropertyValueType.Text when row.Text is not null => new ArticlePropertyTextValue(row.Text),
                    ArticlePropertyValueType.Url when row.Text is not null => new ArticlePropertyUrlValue(row.Text),
                    ArticlePropertyValueType.Number when row.Number.HasValue => new ArticlePropertyNumberValue(row.Number.Value),
                    ArticlePropertyValueType.Boolean when row.Boolean.HasValue => new ArticlePropertyBooleanValue(row.Boolean.Value),
                    ArticlePropertyValueType.Date when row.DateTicks.HasValue
                        && row.DateTicks.Value >= DateTime.MinValue.Ticks && row.DateTicks.Value <= DateTime.MaxValue.Ticks
                        => new ArticlePropertyDateValue(new DateTime(row.DateTicks.Value, DateTimeKind.Utc)),
                    ArticlePropertyValueType.SingleSelect when row.SingleOption.HasValue
                        => ReadStoredSingleSelectValue(row.SingleOption.Value),
                    ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue(optionIds ?? []),
                    ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue(targetIds ?? []),
                    _ => throw Integrity("article_property_value_storage_shape_invalid")
                };
            }
            var entry = new ArticlePropertyValueEntry(row.Id, row.Revision, row.DefinitionDigest,
                row.Presence, payload, row.Digest, row.DefaultApplied);
            if (entry.ValueDigest != ArticlePropertyValueDigest.ComputeValue(new(row.Id, row.Revision,
                row.DefinitionDigest, row.Presence, payload), row.DefaultApplied))
            {
                throw Integrity("article_property_value_digest_invalid");
            }
            values.Add(entry);
            types.Add(row.Id, row.Type);
        }
        if (options.Keys.Concat(references.Keys).Any(id => !types.ContainsKey(id)))
        {
            throw Integrity("article_property_value_storage_orphan_child");
        }
        ValidateStorageEntries(values, types);
        return (values.AsReadOnly(), types);
    }

    internal static ArticlePropertySingleSelectValue ReadStoredSingleSelectValue(Guid optionId)
        => optionId != Guid.Empty
            ? new ArticlePropertySingleSelectValue(optionId)
            : throw Integrity("article_property_value_storage_options_invalid");

    private async Task<Dictionary<Guid, IReadOnlyList<T>>> ReadChildrenAsync<T>(string table, string column,
        Guid id, CancellationToken cancellationToken) where T : struct
    {
        var held = new Dictionary<Guid, List<T>>();
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            $"SELECT definition_id, position, {column} FROM {table} WHERE factset_id = @Id ORDER BY definition_id, position;",
            new SugarParameter("@Id", id)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid definition = reader.GetGuid(0);
            if (!held.TryGetValue(definition, out List<T>? values))
            {
                values = [];
                held.Add(definition, values);
            }
            if (reader.GetInt32(1) != values.Count || values.Count >= ArticlePropertyDefinitionContract.MaxOptionsPerDefinition)
            {
                throw Integrity("article_property_value_storage_child_position_invalid");
            }
            values.Add(reader.GetFieldValue<T>(2));
        }
        return held.ToDictionary(static pair => pair.Key,
            static pair => (IReadOnlyList<T>)pair.Value.AsReadOnly());
    }

    private async Task<ArticlePropertyValueMutationReceipt?> ReadReceiptAsync(long actorId, Guid requestId,
        CancellationToken cancellationToken)
    {
        ArticlePropertyValueMutationReceipt receipt;
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, owner_user_key, site_scope, article_id, expected_article_revision_id,
                before_property_revision, after_property_revision, before_snapshot_id, after_snapshot_id,
                command_kind, command_digest, content_digest, audit_reference, audit_chain_id, audit_record_hash, occurred_at_utc
            FROM article_property_value_receipt WHERE actor_admin_principal_id = @Actor AND request_id = @Request;
            """, new SugarParameter("@Actor", actorId), new("@Request", requestId)).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            receipt = new(reader.GetGuid(0), actorId, requestId, reader.GetInt64(1) == 0 ? null : reader.GetInt64(1),
                reader.GetString(2), reader.GetInt32(3), reader.GetInt64(4), reader.GetInt64(5), reader.GetInt64(6),
                Nullable<Guid>(reader, 7), reader.GetGuid(8), (ArticlePropertyValueMutationMode)reader.GetInt16(9),
                reader.GetString(10), reader.GetString(11), reader.GetGuid(12), reader.GetString(13), reader.GetString(14),
                DateTime.SpecifyKind(reader.GetDateTime(15), DateTimeKind.Utc));
        }
        if (receipt.ContentDigest != ArticlePropertyValueMutationContract.ComputeReceiptDigest(receipt)
            || receipt.AuditReference != receipt.ReceiptId || !Enum.IsDefined(receipt.CommandKind)
            || receipt.BeforePropertyRevision < 0 || receipt.AfterPropertyRevision != receipt.BeforePropertyRevision + 1
            || (receipt.BeforePropertyRevision == 0) != (receipt.BeforeSnapshotId is null))
        {
            throw Integrity("article_property_value_receipt_integrity_invalid");
        }
        await VerifyAuditAsync(receipt.AuditReference, "article-property-value-receipt", WriteAuditAction,
            receipt.ContentDigest, receipt.AuditChainId, receipt.AuditRecordHash, actorId, receipt.OccurredAtUtc,
            cancellationToken).ConfigureAwait(false);
        var owner = new ArticlePropertyDefinitionOwner(receipt.DefinitionOwnerUserId, receipt.SiteScope);
        ArticlePropertyValuePersistedSnapshot after = await ReadSnapshotAsync(owner, receipt.ArticleId,
            receipt.AfterSnapshotId, cancellationToken).ConfigureAwait(false)
            ?? throw Integrity("article_property_value_receipt_snapshot_missing");
        if (after.Snapshot.Coordinates.PropertyRevision != receipt.AfterPropertyRevision)
        {
            throw Integrity("article_property_value_receipt_snapshot_binding_invalid");
        }
        if (receipt.BeforeSnapshotId.HasValue)
        {
            ArticlePropertyValuePersistedSnapshot before = await ReadSnapshotAsync(owner, receipt.ArticleId,
                receipt.BeforeSnapshotId.Value, cancellationToken).ConfigureAwait(false)
                ?? throw Integrity("article_property_value_receipt_snapshot_missing");
            if (before.Snapshot.Coordinates.PropertyRevision != receipt.BeforePropertyRevision
                || before.Snapshot.Coordinates.ArticleRevisionId != receipt.ExpectedArticleRevisionId)
            {
                throw Integrity("article_property_value_receipt_snapshot_binding_invalid");
            }
        }
        return receipt;
    }

    private async Task InsertReceiptAsync(ArticlePropertyValueMutationReceipt receipt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_value_receipt(receipt_id, actor_admin_principal_id, request_id, owner_user_key,
                site_scope, article_id, expected_article_revision_id, before_property_revision, after_property_revision,
                before_snapshot_id, after_snapshot_id, command_kind, command_digest, content_digest,
                audit_reference, audit_chain_id, audit_record_hash, occurred_at_utc)
            VALUES (@Receipt, @Actor, @Request, @Owner, @Site, @Article, @Expected, @Before, @After,
                CAST(@BeforeSnapshot AS uuid), @AfterSnapshot, @Kind, @CommandDigest, @ContentDigest, @Audit, @Chain, @Hash, @Time);
            """, new SugarParameter("@Receipt", receipt.ReceiptId), new("@Actor", receipt.ActorAdminPrincipalId),
            new("@Request", receipt.RequestId), new("@Owner", receipt.DefinitionOwnerUserId ?? 0), new("@Site", receipt.SiteScope),
            new("@Article", receipt.ArticleId), new("@Expected", receipt.ExpectedArticleRevisionId),
            new("@Before", receipt.BeforePropertyRevision), new("@After", receipt.AfterPropertyRevision),
            new("@BeforeSnapshot", (object?)receipt.BeforeSnapshotId ?? DBNull.Value), new("@AfterSnapshot", receipt.AfterSnapshotId),
            new("@Kind", (short)receipt.CommandKind), new("@CommandDigest", receipt.CommandDigest),
            new("@ContentDigest", receipt.ContentDigest), new("@Audit", receipt.AuditReference), new("@Chain", receipt.AuditChainId),
            new("@Hash", receipt.AuditRecordHash), new("@Time", receipt.OccurredAtUtc)).ConfigureAwait(false);
    }

    private async Task VerifyAuditAsync(Guid reference, string targetType, string action, string eventInfo,
        string chain, string recordHash, long? actorId, DateTime? occurredAt, CancellationToken cancellationToken)
    {
        if (_tamperKey is null)
        {
            throw Integrity("article_property_value_audit_key_missing");
        }
        string targetId = reference.ToString("N");
        using (DbDataReader admission = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT count(*), COALESCE(sum(8192::bigint + octet_length(event_info)
                + COALESCE(octet_length(context_json), 0) + COALESCE(octet_length(context_payload), 0)), 0)
            FROM sys_audit_log WHERE target_type = @Type AND target_id = @Target;
            """, new SugarParameter("@Type", targetType), new("@Target", targetId)).ConfigureAwait(false))
        {
            if (!await admission.ReadAsync(cancellationToken).ConfigureAwait(false) || admission.GetInt64(0) != 1
                || admission.GetDecimal(1) > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
            {
                throw Integrity("article_property_value_authenticated_audit_unavailable");
            }
        }
        List<AuditLog> logs = await _db.Queryable<AuditLog>()
            .Where(log => log.TargetType == targetType && log.TargetId == targetId)
            .Take(2).ToListAsync(cancellationToken).ConfigureAwait(false);
        if (logs.Count != 1)
        {
            throw Integrity("article_property_value_authenticated_audit_unavailable");
        }
        AuditLog actual = logs[0];
        string? previousHash;
        using (DbDataReader previous = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT record_hash FROM sys_audit_log WHERE chain_id = @Chain AND id < @Id ORDER BY id DESC LIMIT 1;",
            new SugarParameter("@Chain", actual.ChainId), new("@Id", actual.Id)).ConfigureAwait(false))
        {
            previousHash = await previous.ReadAsync(cancellationToken).ConfigureAwait(false) && !previous.IsDBNull(0)
                ? previous.GetString(0) : null;
        }
        if (!AuditTamperEvidence.VerifyDetailed(actual, _tamperKey, previousHash).IsValid
            || previousHash is null && !string.IsNullOrEmpty(actual.PrevHash)
            || actual.ChainId != chain || actual.RecordHash != recordHash || actual.EventInfo != eventInfo
            || actual.Action != action || actual.ActorType != AuditActorTypeCatalog.Admin
            || !long.TryParse(actual.ActorId, NumberStyles.None, CultureInfo.InvariantCulture, out long actualActor)
            || actualActor <= 0 || actorId.HasValue && actualActor != actorId.Value
            || actual.Outcome != AuditOutcomeCatalog.Success || !actual.IsHighValue
            || occurredAt.HasValue && actual.OccurredAtUtc != occurredAt.Value)
        {
            throw Integrity("article_property_value_authenticated_audit_invalid");
        }
    }

    private static T? Nullable<T>(DbDataReader reader, int ordinal) where T : struct
        => reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<T>(ordinal);
}
