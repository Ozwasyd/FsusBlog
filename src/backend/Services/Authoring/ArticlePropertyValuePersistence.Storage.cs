using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class ArticlePropertyValuePersistence
{
    internal static void ValidateStorageEntries(IReadOnlyList<ArticlePropertyValueEntry> values,
        IReadOnlyDictionary<Guid, ArticlePropertyValueType> types)
    {
        if (values.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || values.Select(static entry => entry.DefinitionId).Distinct().Count() != values.Count)
        {
            throw Integrity("article_property_value_storage_budget_or_identity_invalid");
        }
        long bytes = 0;
        foreach (ArticlePropertyValueEntry entry in values)
        {
            if (entry.DefinitionId == Guid.Empty || entry.DefinitionSchemaRevision <= 0
                || !ArticlePropertyValueMutationContract.IsDigest(entry.DefinitionDigest)
                || !Enum.IsDefined(entry.Presence)
                || (entry.Presence == ArticlePropertyValuePresence.Present) != (entry.Value is not null)
                || entry.ValueDigest != ArticlePropertyValueDigest.ComputeValue(new(entry.DefinitionId,
                    entry.DefinitionSchemaRevision, entry.DefinitionDigest, entry.Presence, entry.Value), entry.DefaultApplied)
                || !types.TryGetValue(entry.DefinitionId, out ArticlePropertyValueType type) || !Enum.IsDefined(type)
                || entry.Value is not null && PayloadType(entry.Value) != type)
            {
                throw Integrity("article_property_value_storage_type_invalid");
            }
            bytes += 256;
            switch (entry.Value)
            {
                case ArticlePropertyTextValue text:
                    bytes += Encoding.UTF8.GetByteCount(text.Text);
                    break;
                case ArticlePropertyUrlValue url:
                    bytes += Encoding.UTF8.GetByteCount(url.Url);
                    break;
                case ArticlePropertyMultiSelectValue options:
                    if (options.OptionIds.Count > ArticlePropertyDefinitionContract.MaxOptionsPerDefinition
                        || options.OptionIds.Any(static id => id == Guid.Empty)
                        || options.OptionIds.Distinct().Count() != options.OptionIds.Count)
                    {
                        throw Integrity("article_property_value_storage_options_invalid");
                    }
                    bytes += options.OptionIds.Count * 64L;
                    break;
                case ArticlePropertyArticleReferenceValue references:
                    if (references.ArticleIds.Count > ArticlePropertyDefinitionContract.MaxOptionsPerDefinition
                        || references.ArticleIds.Any(static id => id <= 0)
                        || references.ArticleIds.Distinct().Count() != references.ArticleIds.Count)
                    {
                        throw Integrity("article_property_value_storage_references_invalid");
                    }
                    bytes += references.ArticleIds.Count * 64L;
                    break;
            }
            if (bytes > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
            {
                throw Integrity("article_property_value_storage_budget_exceeded");
            }
        }
    }

    private static ArticlePropertyValueType PayloadType(ArticlePropertyTypedValue value)
        => value switch
        {
            ArticlePropertyTextValue => ArticlePropertyValueType.Text,
            ArticlePropertyNumberValue => ArticlePropertyValueType.Number,
            ArticlePropertyBooleanValue => ArticlePropertyValueType.Boolean,
            ArticlePropertyDateValue => ArticlePropertyValueType.Date,
            ArticlePropertySingleSelectValue => ArticlePropertyValueType.SingleSelect,
            ArticlePropertyMultiSelectValue => ArticlePropertyValueType.MultiSelect,
            ArticlePropertyArticleReferenceValue => ArticlePropertyValueType.ArticleReference,
            ArticlePropertyUrlValue => ArticlePropertyValueType.Url,
            _ => throw Integrity("article_property_value_storage_type_invalid")
        };

    internal static string ComputeFactsetDigest(IReadOnlyList<ArticlePropertyValueEntry> values,
        IReadOnlyDictionary<Guid, ArticlePropertyValueType> types)
    {
        ValidateStorageEntries(values, types);
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write("fsusblog.article-property-value-factset.v1");
        writer.Write(values.Count);
        foreach (ArticlePropertyValueEntry entry in values.OrderBy(static entry => entry.DefinitionId))
        {
            writer.Write(entry.DefinitionId.ToByteArray());
            writer.Write((short)types[entry.DefinitionId]);
            writer.Write(entry.ValueDigest);
        }
        writer.Flush();
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private async Task InsertFactsetAsync(ArticlePropertyDefinitionOwner owner, int articleId,
        long propertyRevision, Guid factsetId, string digest, IReadOnlyList<ArticlePropertyValueEntry> values,
        IReadOnlyDictionary<Guid, ArticlePropertyValueType> types, CancellationToken cancellationToken)
    {
        RequireTransaction();
        ValidateStorageEntries(values, types);
        if (digest != ComputeFactsetDigest(values, types))
        {
            throw Integrity("article_property_value_factset_digest_invalid");
        }
        await _db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_value_factset(factset_id, schema_version, owner_user_key, site_scope,
                article_id, property_revision, value_count, content_digest)
            VALUES (@Factset, 1, @Owner, @Site, @Article, @PropertyRevision, @Count, @Digest);
            """, (SugarParameter[])[.. Scope(owner, articleId), new("@Factset", factsetId), new("@PropertyRevision", propertyRevision),
                new("@Count", values.Count), new("@Digest", digest)]).ConfigureAwait(false);
        foreach (ArticlePropertyValueEntry[] batch in values.Chunk(300))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var parameters = new List<SugarParameter>();
            var rows = new List<string>();
            foreach ((ArticlePropertyValueEntry entry, int index) in batch.Select((value, index) => (value, index)))
            {
                object?[] fields = [factsetId, entry.DefinitionId, entry.DefinitionSchemaRevision,
                    entry.DefinitionDigest, (short)types[entry.DefinitionId], (short)entry.Presence,
                    entry.DefaultApplied, entry.ValueDigest,
                    entry.Value is ArticlePropertyTextValue text ? text.Text
                        : entry.Value is ArticlePropertyUrlValue url ? url.Url : null,
                    entry.Value is ArticlePropertyNumberValue number ? number.Number : null,
                    entry.Value is ArticlePropertyBooleanValue boolean ? boolean.Boolean : null,
                    entry.Value is ArticlePropertyDateValue date ? date.Utc.Ticks : null,
                    entry.Value is ArticlePropertySingleSelectValue single ? single.OptionId : null];
                var names = new string[fields.Length];
                for (int field = 0; field < fields.Length; field++)
                {
                    names[field] = $"@P{index}_{field}";
                    parameters.Add(new(names[field], fields[field] ?? DBNull.Value));
                }
                // SqlSugar may bind DBNull as text. Preserve each nullable scalar's closed SQL type.
                names[9] = $"CAST({names[9]} AS numeric)";
                names[10] = $"CAST({names[10]} AS boolean)";
                names[11] = $"CAST({names[11]} AS bigint)";
                names[12] = $"CAST({names[12]} AS uuid)";
                rows.Add("(" + string.Join(',', names) + ")");
            }
            await _db.Ado.ExecuteCommandAsync(
                "INSERT INTO article_property_value_entry(factset_id, definition_id, definition_schema_revision, "
                + "definition_digest, value_type, presence, default_applied, value_digest, text_value, number_value, "
                + "boolean_value, date_utc_ticks, single_option_id) VALUES " + string.Join(',', rows) + ";",
                parameters.ToArray()).ConfigureAwait(false);
        }
        var options = values.Where(static value => value.Value is ArticlePropertyMultiSelectValue)
            .SelectMany(value => ((ArticlePropertyMultiSelectValue)value.Value!).OptionIds
                .Select((id, position) => (value.DefinitionId, Position: position, Value: (object)id)));
        await InsertChildrenAsync("article_property_value_option", "option_id", factsetId, options,
            cancellationToken).ConfigureAwait(false);
        var references = values.Where(static value => value.Value is ArticlePropertyArticleReferenceValue)
            .SelectMany(value => ((ArticlePropertyArticleReferenceValue)value.Value!).ArticleIds
                .Select((id, position) => (value.DefinitionId, Position: position, Value: (object)id)));
        await InsertChildrenAsync("article_property_value_reference", "target_article_id", factsetId, references,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task InsertChildrenAsync(string table, string valueColumn, Guid factsetId,
        IEnumerable<(Guid DefinitionId, int Position, object Value)> children, CancellationToken cancellationToken)
    {
        foreach ((Guid DefinitionId, int Position, object Value)[] batch in children.Chunk(500))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var parameters = new List<SugarParameter> { new("@Factset", factsetId) };
            var rows = new List<string>();
            for (int index = 0; index < batch.Length; index++)
            {
                parameters.Add(new($"@D{index}", batch[index].DefinitionId));
                parameters.Add(new($"@I{index}", batch[index].Position));
                parameters.Add(new($"@V{index}", batch[index].Value));
                rows.Add($"(@Factset, @D{index}, @I{index}, @V{index})");
            }
            await _db.Ado.ExecuteCommandAsync($"INSERT INTO {table}(factset_id, definition_id, position, {valueColumn}) VALUES "
                + string.Join(',', rows) + ";", parameters.ToArray()).ConfigureAwait(false);
        }
    }

    private async Task<ArticlePropertyValuePersistedSnapshot> InsertSnapshotAsync(Guid factsetId,
        string factsetDigest, ArticlePropertyValueSnapshot candidate, long actorId, CancellationToken cancellationToken)
    {
        RequireTransaction();
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(candidate);
        Guid id = Guid.CreateVersion7();
        AuthoringSignedAuditWriter.ChainWrite audit = await SignAsync(id, "article-property-value-snapshot",
            SnapshotAuditAction, SnapshotAuditEvent(id, factsetId, factsetDigest, candidate.ContentDigest),
            actorId, Timestamp(), cancellationToken).ConfigureAwait(false);
        ArticlePropertySnapshotCoordinates c = candidate.Coordinates;
        await _db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_value_snapshot(snapshot_id, schema_version, factset_id, article_revision_id,
                draft_id, draft_server_revision, publication_id, content_digest, audit_reference, audit_chain_id, audit_record_hash)
            VALUES (@Snapshot, 1, @Factset, @Revision, NULL, NULL, CAST(@Publication AS bigint), @Digest,
                @Audit, @Chain, @Hash);
            """, new SugarParameter("@Snapshot", id), new("@Factset", factsetId), new("@Revision", c.ArticleRevisionId),
            new("@Publication", (object?)c.PublicationId ?? DBNull.Value), new("@Digest", candidate.ContentDigest),
            new("@Audit", id), new("@Chain", audit.ChainId), new("@Hash", audit.RecordHash)).ConfigureAwait(false);
        return new(id, factsetId, candidate, id, audit.ChainId, audit.RecordHash);
    }

    private async Task ReplaceHeadAsync(ArticlePropertyDefinitionOwner owner, int articleId, long expectedRevision,
        ArticlePropertyValuePersistedSnapshot after, CancellationToken cancellationToken)
    {
        RequireTransaction();
        cancellationToken.ThrowIfCancellationRequested();
        int rows = await _db.Ado.ExecuteCommandAsync(expectedRevision == 0
            ? """
                INSERT INTO article_property_value_head(owner_user_key, site_scope, article_id, property_revision, snapshot_id)
                VALUES (@Owner, @Site, @Article, @Revision, @Snapshot)
                ON CONFLICT (owner_user_key, site_scope, article_id) DO NOTHING;
                """
            : """
                UPDATE article_property_value_head SET property_revision = @Revision, snapshot_id = @Snapshot
                WHERE owner_user_key = @Owner AND site_scope = @Site AND article_id = @Article
                  AND property_revision = @Expected;
                """, (SugarParameter[])[.. Scope(owner, articleId), new("@Revision", after.Snapshot.Coordinates.PropertyRevision),
                new("@Snapshot", after.SnapshotId), new("@Expected", expectedRevision)]).ConfigureAwait(false);
        if (rows != 1)
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_value_revision_conflict");
        }
    }

    private async Task RequireActualCoordinatesAsync(int articleId, long revisionId, long? publicationId,
        CancellationToken cancellationToken, bool requireCurrent = false)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int count = await _db.Ado.GetIntAsync(
            """
            SELECT count(*) FROM article_revision r JOIN article a ON a.id = r.article_id
            WHERE r.id = @Revision AND r.article_id = @Article
              AND (NOT @RequireCurrent OR a.current_revision_id = r.id)
              AND (CAST(@Publication AS bigint) IS NULL OR EXISTS (SELECT 1 FROM article_publication p
                  WHERE p.id = CAST(@Publication AS bigint) AND p.article_id = @Article AND p.article_revision_id = r.id));
            """, new SugarParameter("@Revision", revisionId), new("@Article", articleId),
            new("@Publication", (object?)publicationId ?? DBNull.Value), new("@RequireCurrent", requireCurrent)).ConfigureAwait(false);
        if (count != 1)
        {
            throw Integrity("article_property_value_actual_coordinates_invalid");
        }
    }

    private async Task<string> ReadFactsetDigestAsync(Guid id, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await _db.Ado.GetStringAsync("SELECT content_digest FROM article_property_value_factset WHERE factset_id = @Id;",
            new SugarParameter("@Id", id)).ConfigureAwait(false);
    }

    private async Task<IReadOnlyDictionary<Guid, ArticlePropertyValueType>> ReadFactsetTypesAsync(Guid id,
        CancellationToken cancellationToken)
    {
        var types = new Dictionary<Guid, ArticlePropertyValueType>();
        using DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT definition_id, value_type FROM article_property_value_entry WHERE factset_id = @Id;",
            new SugarParameter("@Id", id)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            types.Add(reader.GetGuid(0), (ArticlePropertyValueType)reader.GetInt16(1));
        }
        return types;
    }

    private static string SnapshotAuditEvent(Guid id, Guid factsetId, string factsetDigest, string snapshotDigest)
        => $"article-property-value-snapshot-v1:{id:D}:{factsetId:D}:{factsetDigest}:{snapshotDigest}";

    private Task<AuthoringSignedAuditWriter.ChainWrite> SignAsync(Guid reference, string targetType,
        string action, string digest, long actorId, DateTime occurredAt, CancellationToken cancellationToken)
        => AuthoringSignedAuditWriter.InsertAsync(_db, _tamperKey, new AuditRecord(AuditSourceCatalog.Article,
            AuditTypeCatalog.Audit, occurredAt, digest, null, Action: action, Outcome: AuditOutcomeCatalog.Success,
            ActorType: AuditActorTypeCatalog.Admin, ActorId: actorId.ToString(CultureInfo.InvariantCulture),
            TargetType: targetType, TargetId: reference.ToString("N"), IsHighValue: true), cancellationToken);
}
