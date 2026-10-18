using System.Globalization;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>Numeric observation coordinates, transaction-local until commit; not Search coverage or authorization.</summary>
public sealed record ArticleSourceObservationCursor(long SourceGeneration, int? ArticleId, long? SourceSequence);

public static partial class ArticleSourceGenerationAuthority
{
    /// <summary>Enrolls the actual original definition receipt and authenticated command journal.</summary>
    public static Task<ArticleSourceObservationCursor> RecordPropertyDefinitionAsync(
        ISqlSugarClient db, Guid receiptId, CancellationToken cancellationToken = default)
    {
        if (receiptId == Guid.Empty)
            throw new ArgumentException("A real definition receipt is required.", nameof(receiptId));
        return RecordObservationAsync(db, "property-definition", receiptId.ToString("D"), """
            SELECT jsonb_build_object('command', to_jsonb(command), 'receipt', to_jsonb(receipt))::text,
                   NULL::integer
            FROM article_property_definition_command command
            JOIN article_property_definition_receipt receipt ON receipt.receipt_id = command.receipt_id
                AND receipt.owner_user_id = command.owner_user_id AND receipt.site_scope = command.site_scope
                AND receipt.owner_revision = command.sequence AND receipt.definition_id = command.definition_id
                AND receipt.actor_admin_principal_id = command.actor_admin_principal_id
                AND receipt.request_id = command.request_id
            WHERE command.receipt_id = @Id AND command.history_version = 1 AND command.sequence > 0;
            """, command => command.Parameters.AddWithValue("Id", receiptId), cancellationToken);
    }

    /// <summary>Enrolls the original activated/rollback policy snapshot, never a hash-derived number.</summary>
    public static Task<ArticleSourceObservationCursor> RecordPolicySnapshotAsync(
        ISqlSugarClient db, string policyId, long version, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(policyId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(version);
        return RecordObservationAsync(db, "security-policy", policyId + ":" + version.ToString(CultureInfo.InvariantCulture), """
            SELECT (to_jsonb(snapshot) - 'revoked_at_utc' - 'is_last_known_good')::text, NULL::integer
            FROM security_policy_snapshot snapshot
            WHERE snapshot.policy_id = @Policy AND snapshot.version = @Version
                AND snapshot.id > 0 AND snapshot.activated_at_utc IS NOT NULL;
            """, command =>
            {
                command.Parameters.AddWithValue("Policy", policyId);
                command.Parameters.AddWithValue("Version", version);
            }, cancellationToken);
    }

    /// <summary>
    /// Enrolls an actual original canonical property snapshot/factset. The original value
    /// owner must first persist and authenticate it on this same native transaction.
    /// This method is not a value writer and cannot make an absent value producer available.
    /// </summary>
    public static Task<ArticleSourceObservationCursor> RecordPropertySnapshotAsync(
        ISqlSugarClient db, Guid snapshotId, CancellationToken cancellationToken = default)
    {
        if (snapshotId == Guid.Empty)
            throw new ArgumentException("A real value snapshot is required.", nameof(snapshotId));
        return RecordObservationAsync(db, "property-value", snapshotId.ToString("D"), """
            SELECT jsonb_build_object('snapshot', to_jsonb(snapshot), 'factset', to_jsonb(factset))::text,
                   factset.article_id
            FROM article_property_value_snapshot snapshot
            JOIN article_property_value_factset factset ON factset.factset_id = snapshot.factset_id
            JOIN article_revision revision ON revision.id = snapshot.article_revision_id
                AND revision.article_id = factset.article_id
            LEFT JOIN article_publication publication ON publication.id = snapshot.publication_id
                AND publication.article_id = factset.article_id
                AND publication.article_revision_id = snapshot.article_revision_id
            WHERE snapshot.snapshot_id = @Id AND snapshot.schema_version = 1 AND factset.schema_version = 1
                AND factset.article_id > 0 AND factset.property_revision > 0
                AND snapshot.audit_reference = snapshot.snapshot_id
                AND snapshot.audit_chain_id <> '' AND snapshot.audit_record_hash <> ''
                AND (snapshot.publication_id IS NULL OR publication.id IS NOT NULL);
            """, command => command.Parameters.AddWithValue("Id", snapshotId), cancellationToken);
    }

    private static async Task<ArticleSourceObservationCursor> RecordObservationAsync(ISqlSugarClient db,
        string kind, string key, string sourceSql, Action<NpgsqlCommand> parameters, CancellationToken cancellationToken)
    {
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = RequireTransaction(db);
        cancellationToken.ThrowIfCancellationRequested();
        if (!s_locks.TryGetValue(transaction, out LockOwner? owner) || !ReferenceEquals(owner.Db, db))
            throw new InvalidOperationException("article_source_mutation_lock_required");
        await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        string facts;
        int? articleId;
        await using (NpgsqlCommand source = new(sourceSql, connection, transaction))
        {
            parameters(source);
            await using NpgsqlDataReader reader = await source.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new InvalidOperationException("article_source_original_observation_missing");
            facts = reader.GetString(0);
            articleId = reader.IsDBNull(1) ? null : reader.GetInt32(1);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new InvalidOperationException("article_source_original_observation_ambiguous");
        }
        ArticleSourceObservationCursor? replay = await ArticleSourceGenerationPersistence.ReadObservationAsync(
            connection, transaction, kind, key, articleId, facts, cancellationToken).ConfigureAwait(false);
        if (replay is not null)
            return replay;
        RequireTransaction(db);
        return await ArticleSourceGenerationPersistence.AllocateObservationAsync(connection, transaction,
            kind, key, articleId, facts, cancellationToken).ConfigureAwait(false);
    }
}
