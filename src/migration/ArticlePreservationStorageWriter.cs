using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;

using MySqlConnector;

using Npgsql;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Migration;

internal sealed record ArticlePreservationWriteLimits(
    int MaximumRows, int MaximumBatchRows, int MaximumBatchParameters, long MaximumArtifactBytes, TimeSpan OperationBudget);
internal sealed record ArticlePreservationStorageStage(string PlanDigest, long VerifiedRows, bool AlreadyPresent)
{
    // Transaction-local readback only. The original journal must seal these actual
    // IDs with the graph before commit; they never imply a successful commit.
    internal ImmutableArray<ArticlePreservationOutboxReceipt> Outbox { get; init; } = [];
}

// Stage only: the original apply owner owns lock/admission, media CAS, commit/rollback
// and its one journal. No connection, transaction, grant or durable receipt is created here.
internal static class ArticlePreservationStorageWriter
{
    internal const string CleanupFailuresKey = "FsusBlog.ArticlePreservation.StorageCleanupFailures";
    private const string ArticleOwner = "FsusBlog.Server.Entities.Article";
    private const string ConfigurationOwner = "FsusBlog.Server.Entities.SystemConfig";
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    // Data stage only. This capability comes from the original locked RW Begin,
    // not the read-only source session, an expected database DTO or a raw tuple.
    // In particular this does not register the PG whole-legacy transaction step
    // or execute MySQL DDL/allocator repair (which would implicitly commit).
    internal static async Task<ArticlePreservationStorageStage> StageMySqlAsync(
        ArticlePreservationWritePlan plan, ArticlePreservationSourceExport source, ArticlePreservationCurrentExport current,
        OwnedCurrentSchemaTarget ownedTarget, OfflineMigrationApplyNativeSession.OwnedReadContext originalWrite,
        ArticlePreservationLimits projectionLimits, ArticleMediaLimits mediaLimits,
        ArticlePreservationWriteLimits writeLimits, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(originalWrite);
        RequireLimits(writeLimits);
        using CancellationTokenSource scope = originalWrite.CreateReadScope(cancellationToken);
        scope.CancelAfter(writeLimits.OperationBudget);
        CancellationToken token = scope.Token;
        if (originalWrite.Provider != CurrentSchemaProviderKind.MySql
            || originalWrite.OriginalConnection.GetType() != typeof(MySqlConnection)
            || originalWrite.OriginalTransaction.GetType() != typeof(MySqlTransaction))
            throw new InvalidOperationException("article_preservation_native_provider_unavailable");
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        DbConnection connection = originalWrite.OriginalConnection;
        DbTransaction transaction = originalWrite.OriginalTransaction;
        RequireSession(connection, transaction);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        await ownedTarget.RevalidateRetainedArtifactAsync(token).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        ArticlePreservationWritePlan expected = ArticlePreservationProjection.Project(
            source, current, plan.Media, projectionLimits, mediaLimits, token);
        if (expected.ContentDigest != plan.ContentDigest)
            throw new InvalidOperationException("article_preservation_native_plan_changed");
        ArticlePreservationStorageProgram program = ArticlePreservationStorageProgram.Compile(expected, ownedTarget, token);
        RequireRows(program.Rows, writeLimits);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        await RequirePublishedAsync(source.Artifact, source.Bytes, writeLimits, token).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        await RequirePublishedAsync(current.Artifact, current.Bytes, writeLimits, token).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        if (current.DefaultPolicy is not null)
        {
            await RequirePublishedAsync(current.DefaultPolicy.Artifact, current.DefaultPolicy.Bytes, writeLimits, token).ConfigureAwait(false);
            await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        }
        foreach (ArticlePreservationCurrentPackage article in current.Articles)
        {
            token.ThrowIfCancellationRequested();
            await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
            await RequirePublishedAsync(article.Artifact, article.Bytes, writeLimits, token).ConfigureAwait(false);
            await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        }
        await RequireMySqlDataTablesAsync(program.Rows, originalWrite, token).ConfigureAwait(false);
        await RequireSiteAuthorAsync(source, ownedTarget.ReadBoundInput().EntityProjection.Schema,
            connection, transaction, writeLimits, token, SchemaProviderKind.MySql, originalWrite).ConfigureAwait(false);
        bool alreadyPresent = await StageRowsAsync(program.Rows, connection, transaction,
            writeLimits, token, SchemaProviderKind.MySql, originalWrite).ConfigureAwait(false);
        await RequireMySqlDataTablesAsync(program.Rows, originalWrite, token).ConfigureAwait(false);
        await RequireSiteAuthorAsync(source, ownedTarget.ReadBoundInput().EntityProjection.Schema,
            connection, transaction, writeLimits, token, SchemaProviderKind.MySql, originalWrite).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        await ownedTarget.RevalidateRetainedArtifactAsync(token).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return new(plan.ContentDigest, program.Rows.Length, alreadyPresent);
    }

    private static async Task RequireMySqlDataTablesAsync(ImmutableArray<ArticlePreservationStorageRow> rows,
        OfflineMigrationApplyNativeSession.OwnedReadContext originalWrite, CancellationToken token)
    {
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        MySqlCurrentSchemaCatalog actual = await MySqlCurrentSchemaCatalogObserver.ReadAsync(
            originalWrite.OriginalConnection, originalWrite.OriginalTransaction, token).ConfigureAwait(false);
        if (actual.Database != originalWrite.Database)
            throw new InvalidOperationException("article_preservation_native_database_changed");
        foreach (string table in rows.Select(static row => row.Table).Distinct(StringComparer.Ordinal))
        {
            token.ThrowIfCancellationRequested();
            MySqlCatalogRow[] facts = actual.Rows.Where(row => row.Part == MySqlCatalogPart.Tables
                && row.Cells.Single(cell => cell.Name == "TABLE_NAME").Value == table).ToArray();
            if (facts.Length != 1 || facts[0].Cells.Single(cell => cell.Name == "TABLE_TYPE").Value != "BASE TABLE"
                || facts[0].Cells.Single(cell => cell.Name == "ENGINE").Value != "InnoDB"
                || actual.Rows.Any(row => row.Part == MySqlCatalogPart.Triggers
                    && row.Cells.Single(cell => cell.Name == "EVENT_OBJECT_TABLE").Value == table))
                throw new InvalidOperationException("article_preservation_mysql_rollbackable_data_table_required");
        }
        // Native measured effects only: not a complete expected current target.
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
    }

    internal static async Task<ArticlePreservationStorageStage> StagePostgreSqlAsync(
        ArticlePreservationWritePlan plan, ArticlePreservationSourceExport source, ArticlePreservationCurrentExport current,
        OwnedCurrentSchemaTarget ownedTarget, DbConnection connection, DbTransaction transaction,
        CurrentSchemaDatabaseIdentity observedDatabase, ArticlePreservationLimits projectionLimits,
        ArticleMediaLimits mediaLimits, ArticlePreservationWriteLimits writeLimits, CancellationToken cancellationToken,
        ArticlePreservationOutboxBatch? outbox = null,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        RequireSession(connection, transaction);
        RequireLimits(writeLimits);
        cancellationToken.ThrowIfCancellationRequested();
        if (connection is not NpgsqlConnection || observedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("article_preservation_native_provider_unavailable");
        // Reuse the original complete projection predicate; a re-sealed caller plan
        // cannot bypass raw source/current policy/media binding at the write boundary.
        ArticlePreservationWritePlan expected = ArticlePreservationProjection.Project(
            source, current, plan.Media, projectionLimits, mediaLimits, cancellationToken);
        if (expected.ContentDigest != plan.ContentDigest)
            throw new InvalidOperationException("article_preservation_native_plan_changed");
        ArticlePreservationStorageProgram program = ArticlePreservationStorageProgram.Compile(expected, ownedTarget, cancellationToken);
        ImmutableArray<ArticlePreservationStorageRow> outboxRows = outbox is null ? []
            : ArticlePreservationStorageProgram.CompileOutbox(expected, outbox, ownedTarget, cancellationToken);
        if (outbox is not null)
        {
            if (originalWrite is null || !ReferenceEquals(originalWrite.OriginalConnection, connection)
                || !ReferenceEquals(originalWrite.OriginalTransaction, transaction))
                throw new InvalidOperationException("article_preservation_outbox_original_write_required");
            _ = originalWrite.RequirePostgreSqlWriteLock();
            await originalWrite.RequireBoundaryAsync(cancellationToken).ConfigureAwait(false);
        }
        RequireRows(program.Rows, writeLimits);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(writeLimits.OperationBudget);
        CancellationToken token = deadline.Token;
        await RequirePublishedAsync(source.Artifact, source.Bytes, writeLimits, token).ConfigureAwait(false);
        await RequirePublishedAsync(current.Artifact, current.Bytes, writeLimits, token).ConfigureAwait(false);
        if (current.DefaultPolicy is not null)
            await RequirePublishedAsync(current.DefaultPolicy.Artifact, current.DefaultPolicy.Bytes, writeLimits, token).ConfigureAwait(false);
        foreach (ArticlePreservationCurrentPackage article in current.Articles)
            await RequirePublishedAsync(article.Artifact, article.Bytes, writeLimits, token).ConfigureAwait(false);
        var observer = new PgCurrentSchemaOwnedTargetObserver(ownedTarget);
        _ = await observer.ObserveAsync(connection, transaction, observedDatabase, token).ConfigureAwait(false);
        await RequireSiteAuthorAsync(source, ownedTarget.ReadBoundInput().EntityProjection.Schema, connection, transaction, writeLimits, token).ConfigureAwait(false);
        ImmutableArray<SequenceRestart> sequences = BindSequences(program, ownedTarget);
        bool alreadyPresent = await StageRowsAsync(program.Rows, connection, transaction, writeLimits, token,
            originalWrite: originalWrite).ConfigureAwait(false);
        ImmutableArray<ArticlePreservationOutboxReceipt> receipts = outbox is null ? []
            : await StageOutboxRowsAsync(outboxRows, alreadyPresent, originalWrite!, writeLimits, token).ConfigureAwait(false);
        foreach (SequenceRestart sequence in sequences)
        {
            token.ThrowIfCancellationRequested();
            // RESTART is transactional and uses only the original owned sequence,
            // unlike setval which would survive the caller's rollback.
            await CommandAsync(connection, transaction, writeLimits, async command =>
            {
                command.CommandText = $"ALTER SEQUENCE {Quote(sequence.Schema)}.{Quote(sequence.Name)} RESTART WITH {sequence.Next.ToString(CultureInfo.InvariantCulture)};";
                await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                return true;
            }).ConfigureAwait(false);
            await CommandAsync(connection, transaction, writeLimits, async command =>
            {
                command.CommandText = $"SELECT last_value,is_called FROM {Quote(sequence.Schema)}.{Quote(sequence.Name)};";
                return await ReaderAsync(command, token, async reader =>
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetInt64(0) != sequence.Next || reader.GetBoolean(1)
                        || await reader.ReadAsync(token).ConfigureAwait(false))
                        throw new InvalidOperationException("article_preservation_native_sequence_restart_unverified");
                    return true;
                }).ConfigureAwait(false);
            }).ConfigureAwait(false);
        }
        _ = await observer.ObserveAsync(connection, transaction, observedDatabase, token).ConfigureAwait(false);
        await RequireSiteAuthorAsync(source, ownedTarget.ReadBoundInput().EntityProjection.Schema, connection, transaction, writeLimits, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (originalWrite is not null)
            await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        return new(plan.ContentDigest, program.Rows.Length, alreadyPresent)
        {
            Outbox = receipts
        };
    }

    // The same native data/receipt body used after the production owner binding.
    // Test rows do not qualify owned target, media, generation or whole migration.
    internal static async Task<ArticlePreservationStorageStage> StageRowsWithOutboxAsync(
        string planDigest, ImmutableArray<ArticlePreservationStorageRow> rows,
        ImmutableArray<ArticlePreservationStorageRow> outboxRows,
        OfflineMigrationApplyNativeSession.OwnedReadContext originalWrite,
        ArticlePreservationWriteLimits limits, CancellationToken token)
    {
        OfflineMigrationPlanValidation.RequireDigest(planDigest, "article_preservation_outbox_plan_digest_required");
        _ = originalWrite.RequirePostgreSqlWriteLock();
        await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        bool alreadyPresent = await StageRowsAsync(rows, originalWrite.OriginalConnection,
            originalWrite.OriginalTransaction, limits, token, originalWrite: originalWrite).ConfigureAwait(false);
        var receipts = await StageOutboxRowsAsync(outboxRows, alreadyPresent, originalWrite, limits, token).ConfigureAwait(false);
        return new(planDigest, rows.Length, alreadyPresent)
        {
            Outbox = receipts
        };
    }

    private static async Task<ImmutableArray<ArticlePreservationOutboxReceipt>> StageOutboxRowsAsync(
        ImmutableArray<ArticlePreservationStorageRow> rows, bool alreadyPresent,
        OfflineMigrationApplyNativeSession.OwnedReadContext originalWrite,
        ArticlePreservationWriteLimits limits, CancellationToken token)
    {
        RequireLimits(limits);
        if (rows.IsDefault || rows.Length > limits.MaximumRows)
            throw new InvalidOperationException("article_preservation_outbox_complete_batch_required");
        long metadataBytes = 0;
        foreach (var row in rows)
            foreach (string text in row.Columns.Select(static column => column.Value).OfType<string>())
            {
                metadataBytes = checked(metadataBytes + s_utf8.GetByteCount(text));
                if (metadataBytes > limits.MaximumArtifactBytes)
                    throw new InvalidOperationException("article_preservation_outbox_payload_budget_exceeded");
            }
        _ = originalWrite.RequirePostgreSqlWriteLock();
        return await OfflineMigrationPostgreSqlNativeSession.WithOriginalWriteAsync(originalWrite, async (connection, transaction, scope) =>
        {
            var receipts = ImmutableArray.CreateBuilder<ArticlePreservationOutboxReceipt>();
            foreach (ArticlePreservationStorageRow row in rows)
            {
                scope.ThrowIfCancellationRequested();
                ArticlePreservationOutboxReceipt? receipt = await ReadOutboxRowAsync(row, connection, transaction, limits, scope, originalWrite).ConfigureAwait(false);
                if (alreadyPresent && receipt is null)
                    throw new InvalidOperationException("article_preservation_outbox_committed_binding_missing");
                if (!alreadyPresent && receipt is not null)
                    throw new InvalidOperationException("article_preservation_outbox_preexisting_event_refused");
                if (receipt is null)
                {
                    await CommandAsync(connection, transaction, limits, async command =>
                    {
                        var columns = row.Columns.Where(static column => !column.IsIdentity).ToArray();
                        if (columns.Length > limits.MaximumBatchParameters)
                            throw new InvalidOperationException("article_preservation_outbox_parameter_budget_exceeded");
                        string values = string.Join(',', columns.Select(column => Parameter(command, column, column.Value)));
                        command.CommandText = $"INSERT INTO public.{Quote(row.Table)} ({string.Join(',', columns.Select(column => Quote(column.Name)))}) VALUES ({values});";
                        if (await command.ExecuteNonQueryAsync(scope).ConfigureAwait(false) != 1)
                            throw new InvalidOperationException("article_preservation_outbox_insert_unobserved");
                        return true;
                    }, originalWrite, scope).ConfigureAwait(false);
                    receipt = await ReadOutboxRowAsync(row, connection, transaction, limits, scope, originalWrite).ConfigureAwait(false)
                        ?? throw new InvalidOperationException("article_preservation_outbox_insert_unobserved");
                }
                receipts.Add(receipt);
            }
            return receipts.ToImmutable();
        }, token).ConfigureAwait(false);
    }

    // Read-only recovery: never fill missing events after a graph commit.
    internal static async Task<ImmutableArray<ArticlePreservationOutboxReceipt>> VerifyOutboxAsync(
        ImmutableArray<ArticlePreservationStorageRow> rows, DbConnection connection, DbTransaction transaction,
        ArticlePreservationWriteLimits limits, CancellationToken token)
    {
        RequireSession(connection, transaction);
        RequireLimits(limits);
        if (connection is not NpgsqlConnection || rows.IsDefault || rows.Length > limits.MaximumRows)
            throw new InvalidOperationException("article_preservation_outbox_complete_batch_required");
        var receipts = ImmutableArray.CreateBuilder<ArticlePreservationOutboxReceipt>();
        foreach (var row in rows)
            receipts.Add(await ReadOutboxRowAsync(row, connection, transaction, limits, token).ConfigureAwait(false)
                ?? throw new InvalidOperationException("article_preservation_outbox_committed_binding_missing"));
        return receipts.ToImmutable();
    }

    private static async Task<ArticlePreservationOutboxReceipt?> ReadOutboxRowAsync(
        ArticlePreservationStorageRow row, DbConnection connection, DbTransaction transaction,
        ArticlePreservationWriteLimits limits, CancellationToken token,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        const string OutboxOwner = "FsusBlog.Server.Entities.ArticleMutationOutboxEvent";
        if (row.EntityOwner != OutboxOwner || row.Columns.IsDefaultOrEmpty
            || row.Columns.Count(static column => column.IsIdentity && column.IsPrimaryKey) != 1)
            throw new InvalidOperationException("article_preservation_outbox_owner_binding_required");
        ArticlePreservationStorageColumn Field(string name) => row.Columns.Single(column => column.PropertyOwner == OutboxOwner + "." + name);
        string[] immutable = ["EventId", "AggregateType", "AggregateId", "SchemaVersion", "ArticleRevisionId", "RevisionNo",
            "RightsSnapshotId", "ResponsibilitySnapshotId", "ResponsibilityVersion", "ArticlePublicationId", "PublicationNo",
            "EventType", "PayloadJson", "CreatedAt"];
        var columns = immutable.Select(Field).ToArray();
        if (columns.Any(column => column.Value is string text && s_utf8.GetByteCount(text) > limits.MaximumArtifactBytes))
            throw new InvalidOperationException("article_preservation_outbox_payload_budget_exceeded");
        return await CommandAsync(connection, transaction, limits, async command =>
        {
            string parameter = Parameter(command, Field("EventId"), Field("EventId").Value);
            // Bound returned payload bytes before materialization, then compare all immutable
            // original fields. Dispatcher status/leases are not immutable event facts.
            string select = string.Join(',', columns.Select(column => column.PropertyOwner == OutboxOwner + ".PayloadJson"
                ? $"CASE WHEN octet_length({Quote(column.Name)})<={limits.MaximumArtifactBytes.ToString(CultureInfo.InvariantCulture)} THEN {Quote(column.Name)} ELSE NULL END"
                : Quote(column.Name)));
            command.CommandText = $"SELECT {Quote(Field("Id").Name)},{select} FROM public.{Quote(row.Table)} WHERE {Quote(Field("EventId").Name)}={parameter};";
            return await ReaderAsync<ArticlePreservationOutboxReceipt?>(command, token, async reader =>
            {
                if (!await ReadOwnedRowAsync(reader, command, token, originalWrite).ConfigureAwait(false))
                    return null;
                long actualId = reader.GetInt64(0);
                if (actualId <= 0)
                    throw new InvalidOperationException("article_preservation_outbox_id_unobserved");
                for (int index = 0; index < columns.Length; index++)
                {
                    if (reader.IsDBNull(index + 1) || !Equals(reader.GetValue(index + 1), columns[index].Value))
                        throw new InvalidOperationException("article_preservation_outbox_immutable_facts_changed");
                }
                if (await ReadOwnedRowAsync(reader, command, token, originalWrite).ConfigureAwait(false))
                    throw new InvalidOperationException("article_preservation_outbox_event_ambiguous");
                return new((int)Field("AggregateId").Value!, actualId, (string)Field("EventId").Value!);
            }, originalWrite).ConfigureAwait(false);
        }, originalWrite, token).ConfigureAwait(false);
    }

    internal static ImmutableArray<OfflineMigrationFact> OutboxJournalFacts(ArticlePreservationStorageStage stage)
        => stage.Outbox.OrderBy(static receipt => receipt.ArticleId).SelectMany(static receipt => new OfflineMigrationFact[]
        {
            new($"outbox.article/{receipt.ArticleId}/event_id", receipt.EventId),
            new($"outbox.article/{receipt.ArticleId}/row_id", receipt.OutboxId.ToString(CultureInfo.InvariantCulture))
        }).ToImmutableArray();

    internal static void RequireLimits(ArticlePreservationWriteLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.MaximumRows <= 0 || limits.MaximumBatchRows <= 0 || limits.MaximumBatchParameters is <= 0 or > ushort.MaxValue
            || limits.MaximumArtifactBytes <= 0 || limits.OperationBudget <= TimeSpan.Zero
            || limits.OperationBudget.TotalMilliseconds > uint.MaxValue - 1)
            throw new InvalidOperationException("article_preservation_native_write_limits_required");
    }

    internal static void RequireSession(DbConnection connection, DbTransaction transaction)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel is not (IsolationLevel.RepeatableRead or IsolationLevel.Serializable))
            throw new InvalidOperationException("article_preservation_native_caller_transaction_required");
    }

    internal static void RequireRows(ImmutableArray<ArticlePreservationStorageRow> rows, ArticlePreservationWriteLimits limits)
    {
        RequireLimits(limits);
        if (rows.IsDefaultOrEmpty || rows.Length > limits.MaximumRows)
            throw new InvalidOperationException("article_preservation_native_complete_rows_required");
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in rows.GroupBy(static row => row.Table, StringComparer.Ordinal))
        {
            ArticlePreservationStorageRow first = group.First();
            if (first.Columns.IsDefaultOrEmpty || first.Columns.Length > limits.MaximumBatchParameters
                || !first.Columns.Any(static column => column.IsPrimaryKey)
                || string.IsNullOrWhiteSpace(first.Table) || first.Table.Any(char.IsControl)
                || first.Columns.Select(static column => column.Name).Distinct(StringComparer.Ordinal).Count() != first.Columns.Length
                || first.Columns.Select(static column => column.PropertyOwner).Distinct(StringComparer.Ordinal).Count() != first.Columns.Length)
                throw new InvalidOperationException("article_preservation_native_row_shape_invalid");
            var primaryKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (ArticlePreservationStorageRow row in group)
            {
                if (row.EntityOwner != first.EntityOwner || row.Columns.IsDefault || row.Columns.Length != first.Columns.Length)
                    throw new InvalidOperationException("article_preservation_native_row_shape_changed");
                for (int index = 0; index < row.Columns.Length; index++)
                {
                    ArticlePreservationStorageColumn column = row.Columns[index];
                    if ((column with
                    {
                        Value = null
                    }) != (first.Columns[index] with
                    {
                        Value = null
                    })
                        || string.IsNullOrWhiteSpace(column.Name) || column.Name.Any(char.IsControl)
                        || !column.PropertyOwner.StartsWith(row.EntityOwner + ".", StringComparison.Ordinal)
                        || !ArticlePreservationStorageProgram.ValueMatches(column.DataType, column.Value)
                        || column.Value is null && (!column.IsNullable || column.IsPrimaryKey)
                        || column.Value is DateTime date && (date.Kind != DateTimeKind.Unspecified || date.Ticks % 10 != 0
                            || date == DateTime.MinValue || date == DateTime.MaxValue))
                        throw new InvalidOperationException("article_preservation_native_value_shape_changed");
                }
                if (!primaryKeys.Add(Key(row.Columns.Where(static column => column.IsPrimaryKey)
                    .OrderBy(static column => column.Name, StringComparer.Ordinal).Select(static column => column.Value).ToArray())))
                    throw new InvalidOperationException("article_preservation_native_primary_key_duplicate");
                if (row.EntityOwner == ArticleOwner && (row.Columns.Count(static column => IsPointer(column)) != 2
                    || row.Columns.Count(static column => column.IsPrimaryKey) != 1
                    || row.Columns.Any(static column => IsPointer(column) && (!column.IsNullable || column.Value is null))))
                    throw new InvalidOperationException("article_preservation_native_initial_pointer_shape_invalid");
            }
        }
    }

    // This same body is exercised by caller-transaction command tests. Metadata-only
    // tests do not construct the original-owner capability or qualify a native provider.
    internal static async Task<bool> StageRowsAsync(ImmutableArray<ArticlePreservationStorageRow> rows,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token,
        SchemaProviderKind provider = SchemaProviderKind.PostgreSql,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        RequireDataDialect(provider);
        RequireSession(connection, transaction);
        RequireRows(rows, limits);
        token.ThrowIfCancellationRequested();
        IGrouping<string, ArticlePreservationStorageRow>[] groups = rows.GroupBy(static row => row.Table, StringComparer.Ordinal).ToArray();
        bool anyExisting = false;
        bool allComplete = true;
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in groups)
        {
            long count = await CommandAsync(connection, transaction, limits, async command =>
            {
                command.CommandText = $"SELECT count(*) FROM {DataTable(group.Key, provider)};";
                return Convert.ToInt64(await command.ExecuteScalarAsync(token).ConfigureAwait(false), CultureInfo.InvariantCulture);
            }, originalWrite, token).ConfigureAwait(false);
            anyExisting |= count != 0;
            allComplete &= count == group.Count();
        }
        if (anyExisting)
        {
            if (!allComplete)
                throw new InvalidOperationException("article_preservation_native_partial_target_refused");
            await VerifyRowsAsync(groups, connection, transaction, limits, token, provider, originalWrite).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            return true;
        }
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in groups)
        {
            ArticlePreservationStorageRow[] batchSource = group.ToArray();
            int batchSize = Math.Min(limits.MaximumBatchRows, limits.MaximumBatchParameters / batchSource[0].Columns.Length);
            for (int offset = 0; offset < batchSource.Length; offset += batchSize)
            {
                token.ThrowIfCancellationRequested();
                ArticlePreservationStorageRow[] batch = batchSource.Skip(offset).Take(batchSize).ToArray();
                await CommandAsync(connection, transaction, limits, async command =>
                {
                    ConfigureInsert(command, batch, provider);
                    if (await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) != batch.Length)
                        throw new InvalidOperationException("article_preservation_native_batch_count_changed");
                    return true;
                }, originalWrite, token).ConfigureAwait(false);
            }
        }
        if (provider == SchemaProviderKind.MySql)
        {
            await StageMySqlPointerBatchesAsync(rows, connection, transaction, limits, token, originalWrite).ConfigureAwait(false);
        }
        else
        {
            foreach (ArticlePreservationStorageRow article in rows.Where(static row => row.EntityOwner == ArticleOwner))
            {
                token.ThrowIfCancellationRequested();
                await CommandAsync(connection, transaction, limits, async command =>
                {
                    ConfigurePointerCas(command, article);
                    if (await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) != 1)
                        throw new InvalidOperationException("article_preservation_native_pointer_cas_failed");
                    return true;
                }, originalWrite, token).ConfigureAwait(false);
            }
        }
        await VerifyRowsAsync(groups, connection, transaction, limits, token, provider, originalWrite).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return false;
    }

    internal static void ConfigureInsert(DbCommand command, IReadOnlyList<ArticlePreservationStorageRow> rows)
        => ConfigureInsert(command, rows, SchemaProviderKind.PostgreSql);

    internal static void ConfigureMySqlInsert(DbCommand command, IReadOnlyList<ArticlePreservationStorageRow> rows)
        => ConfigureInsert(command, rows, SchemaProviderKind.MySql);

    private static void ConfigureInsert(DbCommand command, IReadOnlyList<ArticlePreservationStorageRow> rows, SchemaProviderKind provider)
    {
        ArticlePreservationStorageRow first = rows[0];
        var values = new List<string>(rows.Count);
        foreach (ArticlePreservationStorageRow row in rows)
        {
            var parameters = new List<string>(row.Columns.Length);
            foreach (ArticlePreservationStorageColumn column in row.Columns)
            {
                object? value = row.EntityOwner == ArticleOwner && IsPointer(column) ? null : column.Value;
                parameters.Add(Parameter(command, column, value));
            }
            values.Add("(" + string.Join(',', parameters) + ")");
        }
        string identity = provider == SchemaProviderKind.PostgreSql && first.Columns.Any(static column => column.IsIdentity)
            ? " OVERRIDING SYSTEM VALUE" : string.Empty;
        command.CommandText = $"INSERT INTO {DataTable(first.Table, provider)} ({string.Join(',', first.Columns.Select(column => DataQuote(column.Name, provider)))}){identity} VALUES {string.Join(',', values)};";
    }

    internal static void ConfigurePointerCas(DbCommand command, ArticlePreservationStorageRow row)
    {
        ArticlePreservationStorageColumn[] pointers = row.Columns.Where(static column => IsPointer(column)).ToArray();
        ArticlePreservationStorageColumn[] keys = row.Columns.Where(static column => column.IsPrimaryKey).ToArray();
        if (row.EntityOwner != ArticleOwner || pointers.Length != 2 || keys.Length != 1 || pointers.Any(static column => column.Value is null))
            throw new InvalidOperationException("article_preservation_native_pointer_shape_changed");
        string assignments = string.Join(',', pointers.Select(column => Quote(column.Name) + "=" + Parameter(command, column, column.Value)));
        string predicate = string.Join(" AND ", keys.Select(column => Quote(column.Name) + "=" + Parameter(command, column, column.Value)));
        command.CommandText = $"UPDATE public.{Quote(row.Table)} SET {assignments} WHERE {predicate} AND {string.Join(" AND ", pointers.Select(static column => Quote(column.Name) + " IS NULL"))};";
    }

    internal static async Task VerifyRowsAsync(IEnumerable<IGrouping<string, ArticlePreservationStorageRow>> groups,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token,
        SchemaProviderKind provider = SchemaProviderKind.PostgreSql,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        RequireDataDialect(provider);
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in groups)
        {
            ArticlePreservationStorageColumn[] columns = group.First().Columns.OrderByDescending(static column => column.IsPrimaryKey)
                .ThenBy(static column => column.Name, StringComparer.Ordinal).ToArray();
            int keys = columns.Count(static column => column.IsPrimaryKey);
            ArticlePreservationStorageColumn[] textColumns = provider == SchemaProviderKind.MySql
                ? columns.Where(static column => column.DataType == "string").ToArray() : [];
            long[] textBounds = new long[textColumns.Length];
            for (int textIndex = 0; textIndex < textColumns.Length; textIndex++)
                foreach (ArticlePreservationStorageRow row in group)
                {
                    token.ThrowIfCancellationRequested();
                    object? value = row.Columns.Single(column => column.Name == textColumns[textIndex].Name).Value;
                    long bytes = value is string text ? s_utf8.GetByteCount(text) : 0;
                    if (bytes > limits.MaximumArtifactBytes)
                        throw new InvalidOperationException("article_preservation_mysql_row_text_budget_exceeded");
                    textBounds[textIndex] = Math.Max(textBounds[textIndex], bytes);
                }
            var expected = group.ToDictionary(row => Key(row.Columns.Where(static column => column.IsPrimaryKey)
                .OrderBy(static column => column.Name, StringComparer.Ordinal).Select(static column => column.Value).ToArray()), StringComparer.Ordinal);
            await CommandAsync(connection, transaction, limits, async command =>
            {
                var select = new List<string>(columns.Length + textColumns.Length);
                select.AddRange(textColumns.Select(column => "OCTET_LENGTH(" + DataQuote(column.Name, provider) + ")"));
                foreach (ArticlePreservationStorageColumn column in columns)
                {
                    string name = DataQuote(column.Name, provider);
                    int textIndex = Array.FindIndex(textColumns, value => value.Name == column.Name);
                    if (textIndex < 0)
                        select.Add(provider == SchemaProviderKind.MySql && column.DataType == "boolean"
                            ? "CAST(" + name + " AS SIGNED) AS " + name : name);
                    else
                    {
                        DbParameter bound = command.CreateParameter();
                        bound.ParameterName = "@length" + textIndex.ToString(CultureInfo.InvariantCulture);
                        bound.DbType = DbType.Int64;
                        bound.Value = textBounds[textIndex];
                        command.Parameters.Add(bound);
                        // MySqlConnector GetTextReader constructs a complete string.
                        // Bound the actual result in SQL before that allocation, then
                        // independently reject the measured length, even for NULL
                        // expected values. SequentialAccess alone is not a byte cap.
                        select.Add($"CASE WHEN OCTET_LENGTH({name})<={bound.ParameterName} THEN {name} ELSE NULL END AS {name}");
                    }
                }
                command.CommandText = $"SELECT {string.Join(',', select)} FROM {DataTable(group.Key, provider)};";
                await ReaderAsync(command, token, async reader =>
                {
                    while (await ReadOwnedRowAsync(reader, command, token, originalWrite).ConfigureAwait(false))
                    {
                        // These added scalar length fields cannot allocate the raw
                        // oversized text suppressed by the CASE projection above.
                        for (int textIndex = 0; textIndex < textColumns.Length; textIndex++)
                        {
                            int ordinal = textIndex;
                            if (!await ReadOwnedNullAsync(reader, ordinal, command, token, originalWrite).ConfigureAwait(false))
                            {
                                long length = Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
                                if (length < 0 || length > textBounds[textIndex])
                                    throw new InvalidOperationException("article_preservation_mysql_row_text_budget_exceeded");
                            }
                        }
                        object?[] key = new object?[keys];
                        for (int index = 0; index < keys; index++)
                        {
                            int ordinal = textColumns.Length + index;
                            key[index] = reader.IsDBNull(ordinal) ? null : reader.GetValue(ordinal);
                        }
                        if (!expected.Remove(Key(key), out ArticlePreservationStorageRow? row))
                            throw new InvalidOperationException("article_preservation_native_row_identity_changed");
                        var values = row.Columns.ToDictionary(static column => column.Name, static column => column.Value, StringComparer.Ordinal);
                        for (int index = keys; index < columns.Length; index++)
                        {
                            int ordinal = textColumns.Length + index;
                            object? wanted = values[columns[index].Name];
                            if (await ReadOwnedNullAsync(reader, ordinal, command, token, originalWrite).ConfigureAwait(false))
                            {
                                if (wanted is not null)
                                    throw new InvalidOperationException("article_preservation_native_row_value_changed");
                            }
                            else if (wanted is string text)
                            {
                                await CompareTextAsync(reader.GetTextReader(ordinal), text, token, () => RequireOwnedIoActive(originalWrite, connection, transaction, token)).ConfigureAwait(false);
                            }
                            else if (!Equals(wanted, DataValue(reader.GetValue(ordinal), columns[index], provider)))
                                throw new InvalidOperationException("article_preservation_native_row_value_changed");
                        }
                    }
                    if (expected.Count != 0)
                        throw new InvalidOperationException("article_preservation_native_row_missing");
                    return true;
                }, originalWrite).ConfigureAwait(false);
                return true;
            }, originalWrite, token).ConfigureAwait(false);
        }
    }

    private static async Task RequirePublishedAsync(CurrentSchemaArtifactReference artifact, ImmutableArray<byte> expected,
        ArticlePreservationWriteLimits limits, CancellationToken token)
    {
        if (expected.IsDefaultOrEmpty || expected.Length > limits.MaximumArtifactBytes
            || ArticlePreservationSemanticReceipt.HashBytes(expected.AsSpan()) != artifact.Sha256)
            throw new InvalidOperationException("article_preservation_native_artifact_binding_invalid");
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(artifact.Reference, token);
        var input = new FileStream(handle, FileAccess.Read, 4096);
        Exception? first = null;
        try
        {
            if (input.Length != expected.Length)
                throw new InvalidOperationException("article_preservation_native_original_artifact_changed");
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            byte[] buffer = new byte[4096];
            long total = 0;
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false)) != 0)
            {
                total = checked(total + read);
                if (total > expected.Length)
                    throw new InvalidOperationException("article_preservation_native_original_artifact_changed");
                hash.AppendData(buffer.AsSpan(0, read));
            }
            if (total != expected.Length || Convert.ToHexStringLower(hash.GetHashAndReset()) != artifact.Sha256)
                throw new InvalidOperationException("article_preservation_native_original_artifact_changed");
        }
        catch (Exception failure)
        {
            first = failure;
        }
        try
        {
            await input.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            RememberCleanup(ref first, cleanup, "article_preservation_native_artifact_disposal_failed");
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
    }

    private static async Task RequireSiteAuthorAsync(ArticlePreservationSourceExport source, SchemaModelSnapshot schema,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token,
        SchemaProviderKind provider = SchemaProviderKind.PostgreSql,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        SchemaTableModel table = schema.Tables.Values.Single(static table => table.Owner?.Owner == ConfigurationOwner);
        SchemaColumnModel key = table.Columns.Values.Single(static column => column.Owner?.Owner == ConfigurationOwner + ".Key");
        SchemaColumnModel value = table.Columns.Values.Single(static column => column.Owner?.Owner == ConfigurationOwner + ".Value");
        if (key.DataType != "string" || value.DataType != "string" || !key.IsPrimaryKey)
            throw new InvalidOperationException("article_preservation_native_configuration_owner_changed");
        string? author = await CommandAsync(connection, transaction, limits, async command =>
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = "@key";
            parameter.DbType = DbType.String;
            parameter.Value = PublicSiteAuthorPolicy.ConfigurationKey;
            command.Parameters.Add(parameter);
            int valueOrdinal = 0;
            long maximumBytes = 0;
            string projection = DataQuote(value.Name, provider);
            if (provider == SchemaProviderKind.MySql)
            {
                if (value.MaxLength is not > 0)
                    throw new InvalidOperationException("article_preservation_mysql_site_author_bound_required");
                maximumBytes = Math.Min(limits.MaximumArtifactBytes, checked((long)value.MaxLength.Value * 4));
                DbParameter bound = command.CreateParameter();
                bound.ParameterName = "@length";
                bound.DbType = DbType.Int64;
                bound.Value = maximumBytes;
                command.Parameters.Add(bound);
                projection = $"OCTET_LENGTH({projection}),CASE WHEN OCTET_LENGTH({projection})<=@length THEN {projection} ELSE NULL END";
                valueOrdinal = 1;
            }
            command.CommandText = $"SELECT {projection} FROM {DataTable(table.Name, provider)} WHERE {DataQuote(key.Name, provider)}=@key;";
            return await ReaderAsync(command, token, async reader =>
            {
                string? result = null;
                if (await ReadOwnedRowAsync(reader, command, token, originalWrite).ConfigureAwait(false))
                {
                    if (provider == SchemaProviderKind.MySql && !reader.IsDBNull(0))
                    {
                        long length = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
                        if (length < 0 || length > maximumBytes)
                            throw new InvalidOperationException("article_preservation_mysql_site_author_budget_exceeded");
                    }
                    result = reader.IsDBNull(valueOrdinal) ? null : reader.GetString(valueOrdinal);
                    if (await ReadOwnedRowAsync(reader, command, token, originalWrite).ConfigureAwait(false))
                        throw new InvalidOperationException("article_preservation_native_site_author_ambiguous");
                }
                return result;
            }, originalWrite).ConfigureAwait(false);
        }, originalWrite, token).ConfigureAwait(false);
        if (PublicSiteAuthorPolicy.Resolve(author) != PublicSiteAuthorPolicy.Resolve(source.Data.ConfiguredSiteAuthor))
            throw new InvalidOperationException("article_preservation_native_site_author_changed");
    }

    private sealed record SequenceRestart(string Schema, string Name, long Next);
    private static ImmutableArray<SequenceRestart> BindSequences(ArticlePreservationStorageProgram program, OwnedCurrentSchemaTarget owned)
    {
        SchemaModelSnapshot physical = owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql).Tables;
        var result = ImmutableArray.CreateBuilder<SequenceRestart>();
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in program.Rows.GroupBy(static row => row.Table, StringComparer.Ordinal))
            foreach (ArticlePreservationStorageColumn column in group.First().Columns.Where(static column => column.IsIdentity))
            {
                SchemaOwnedSequenceModel sequence = physical.Tables[group.Key].Columns[column.Name].OwnedSequence
                    ?? throw new InvalidOperationException("article_preservation_native_owned_sequence_missing");
                long maximum = group.Max(row => Convert.ToInt64(row.Columns.Single(value => value.Name == column.Name).Value, CultureInfo.InvariantCulture));
                if (sequence.Schema != "public" || sequence.OwnedTable != group.Key || sequence.OwnedColumn != column.Name
                    || sequence.IncrementBy != 1 || sequence.IsCyclic || maximum >= sequence.MaxValue)
                    throw new InvalidOperationException("article_preservation_native_owned_sequence_changed");
                result.Add(new(sequence.Schema, sequence.Name, Math.Max(sequence.MinValue, checked(maximum + 1))));
            }
        return result.ToImmutable();
    }

    private static string Parameter(DbCommand command, ArticlePreservationStorageColumn column, object? value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = "@p" + command.Parameters.Count.ToString(CultureInfo.InvariantCulture);
        parameter.DbType = column.DataType switch
        {
            "string" => DbType.String,
            "int32" => DbType.Int32,
            "int64" => DbType.Int64,
            "boolean" => DbType.Boolean,
            "timestamp" => DbType.DateTime2,
            _ => throw new InvalidOperationException("article_preservation_native_parameter_type_unavailable")
        };
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
        return parameter.ParameterName;
    }

    internal static async Task<T> CommandAsync<T>(DbConnection connection, DbTransaction transaction,
        ArticlePreservationWriteLimits limits, Func<DbCommand, Task<T>> body,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null, CancellationToken token = default)
    {
        RequireOwnedIoActive(originalWrite, connection, transaction, token);
        if (originalWrite is not null)
            await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
        RequireOwnedIoActive(originalWrite, connection, transaction, token);
        DbCommand command = connection.CreateCommand();
        Exception? first = null;
        T result = default!;
        try
        {
            command.Transaction = transaction;
            command.CommandTimeout = checked((int)Math.Max(1, Math.Ceiling(limits.OperationBudget.TotalSeconds)));
            RequireOwnedIoActive(originalWrite, connection, transaction, token);
            result = await body(command).ConfigureAwait(false);
            RequireOwnedIoActive(originalWrite, connection, transaction, token);
        }
        catch (Exception failure)
        {
            first = failure;
        }
        try
        {
            RequireOwnedIoActive(originalWrite, connection, transaction, token);
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_scope_revalidation_failed");
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            RememberCleanup(ref first, cleanup, "article_preservation_native_command_disposal_failed");
        }
        try
        {
            RequireOwnedIoActive(originalWrite, connection, transaction, token);
            // The reader and command have returned from their actual disposers.
            // Only now may this original session run another native proof query.
            if (originalWrite is not null)
            {
                if (first?.Data[CleanupFailuresKey] is ImmutableArray<string> failures
                    && failures.Any(static code => code is "article_preservation_native_command_disposal_failed"
                        or "article_preservation_native_reader_disposal_failed" or "article_preservation_native_text_disposal_failed"))
                    throw new InvalidOperationException("article_preservation_native_disposal_unverified");
                await originalWrite.RequireBoundaryAsync(token).ConfigureAwait(false);
            }
            RequireOwnedIoActive(originalWrite, connection, transaction, token);
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_boundary_revalidation_failed");
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private static async Task<T> ReaderAsync<T>(DbCommand command, CancellationToken token, Func<DbDataReader, Task<T>> body,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite = null)
    {
        void RequireActive() => RequireOwnedIoActive(originalWrite, command.Connection!, command.Transaction!, token);
        RequireActive();
        DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false);
        Exception? first = null;
        T result = default!;
        try
        {
            RequireActive();
            result = await body(reader).ConfigureAwait(false);
            RequireActive();
        }
        catch (Exception failure)
        {
            first = failure;
        }
        try
        {
            RequireActive();
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_scope_revalidation_failed");
        }
        try
        {
            await reader.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            RememberCleanup(ref first, cleanup, "article_preservation_native_reader_disposal_failed");
        }
        try
        {
            RequireActive();
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_scope_revalidation_failed");
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private static void RememberCleanup(ref Exception? first, Exception cleanup, string code)
    {
        first ??= cleanup;
        ImmutableArray<string> codes = first.Data[CleanupFailuresKey] is ImmutableArray<string> recorded
            ? recorded : ImmutableArray<string>.Empty;
        first.Data[CleanupFailuresKey] = codes.Add(code);
    }
    private static async Task CompareTextAsync(TextReader actual, string text, CancellationToken token, Action? requireActive = null)
    {
        Exception? first = null;
        try
        {
            char[] chunk = new char[4096];
            int offset = 0;
            int read;
            while (true)
            {
                requireActive?.Invoke();
                read = await actual.ReadAsync(chunk.AsMemory(), token).ConfigureAwait(false);
                requireActive?.Invoke();
                if (read == 0)
                    break;
                if (read > text.Length - offset || !chunk.AsSpan(0, read).SequenceEqual(text.AsSpan(offset, read)))
                    throw new InvalidOperationException("article_preservation_native_row_value_changed");
                offset += read;
            }
            if (offset != text.Length)
                throw new InvalidOperationException("article_preservation_native_row_value_changed");
        }
        catch (Exception failure)
        {
            first = failure;
        }
        try
        {
            requireActive?.Invoke();
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_scope_revalidation_failed");
        }
        try
        {
            actual.Dispose();
        }
        catch (Exception cleanup)
        {
            RememberCleanup(ref first, cleanup, "article_preservation_native_text_disposal_failed");
        }
        try
        {
            requireActive?.Invoke();
        }
        catch (Exception failure)
        {
            RememberCleanup(ref first, failure, "article_preservation_native_owned_scope_revalidation_failed");
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
    }
    private static bool IsPointer(ArticlePreservationStorageColumn column)
        => column.PropertyOwner == ArticleOwner + ".CurrentRevisionId" || column.PropertyOwner == ArticleOwner + ".CurrentPublicationId";
    private static string Key(object?[] values) => ArticlePreservationSemanticReceipt.Digest("article-storage-native-key-v1", values);
    private static string Quote(string identifier) => SchemaMigrationSql.QuoteIdentifier(identifier);

    // Local scope liveness is not a native transaction epoch observation. Native
    // proofs remain at command boundaries after all live readers are disposed.
    private static void RequireOwnedIoActive(OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite,
        DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        if (originalWrite is null)
            return; // Low-level command fixtures grant no native capability.
        token.ThrowIfCancellationRequested();
        if (originalWrite.Provider is not (CurrentSchemaProviderKind.MySql or CurrentSchemaProviderKind.PostgreSql)
            || !ReferenceEquals(originalWrite.OriginalConnection, connection)
            || !ReferenceEquals(originalWrite.OriginalTransaction, transaction)
            || connection.State != ConnectionState.Open || !ReferenceEquals(transaction.Connection, connection))
            throw new InvalidOperationException("article_preservation_native_original_write_context_changed");
    }

    private static async Task<bool> ReadOwnedRowAsync(DbDataReader reader, DbCommand command, CancellationToken token,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite)
    {
        RequireOwnedIoActive(originalWrite, command.Connection!, command.Transaction!, token);
        bool result = await reader.ReadAsync(token).ConfigureAwait(false);
        RequireOwnedIoActive(originalWrite, command.Connection!, command.Transaction!, token);
        return result;
    }

    private static async Task<bool> ReadOwnedNullAsync(DbDataReader reader, int ordinal, DbCommand command, CancellationToken token,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite)
    {
        RequireOwnedIoActive(originalWrite, command.Connection!, command.Transaction!, token);
        bool result = await reader.IsDBNullAsync(ordinal, token).ConfigureAwait(false);
        RequireOwnedIoActive(originalWrite, command.Connection!, command.Transaction!, token);
        return result;
    }

    private static void RequireDataDialect(SchemaProviderKind provider)
    {
        if (provider is not (SchemaProviderKind.PostgreSql or SchemaProviderKind.MySql))
            throw new InvalidOperationException("article_preservation_native_provider_unavailable");
    }

    private static string DataQuote(string identifier, SchemaProviderKind provider)
        => provider == SchemaProviderKind.MySql ? "`" + identifier.Replace("`", "``", StringComparison.Ordinal) + "`" : Quote(identifier);

    private static string DataTable(string table, SchemaProviderKind provider)
        => provider == SchemaProviderKind.MySql ? DataQuote(table, provider) : "public." + Quote(table);

    private static object DataValue(object actual, ArticlePreservationStorageColumn column, SchemaProviderKind provider)
        => provider == SchemaProviderKind.MySql && column.DataType == "boolean" ? actual switch
        {
            sbyte value when value is 0 or 1 => value == 1,
            byte value when value is 0 or 1 => value == 1,
            long value when value is 0 or 1 => value == 1,
            _ => actual
        } : actual;

    private static async Task StageMySqlPointerBatchesAsync(ImmutableArray<ArticlePreservationStorageRow> rows,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token,
        OfflineMigrationApplyNativeSession.OwnedReadContext? originalWrite)
    {
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in rows.Where(static row => row.EntityOwner == ArticleOwner)
            .GroupBy(static row => row.Table, StringComparer.Ordinal))
        {
            ArticlePreservationStorageRow[] articles = group.ToArray();
            int batchSize = Math.Min(limits.MaximumBatchRows, limits.MaximumBatchParameters / 3);
            for (int offset = 0; offset < articles.Length; offset += batchSize)
            {
                token.ThrowIfCancellationRequested();
                ArticlePreservationStorageRow[] batch = articles.Skip(offset).Take(batchSize).ToArray();
                await CommandAsync(connection, transaction, limits, async command =>
                {
                    ConfigureMySqlPointerBatch(command, batch);
                    if (await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) != batch.Length)
                        throw new InvalidOperationException("article_preservation_native_pointer_cas_failed");
                    return true;
                }, originalWrite, token).ConfigureAwait(false);
            }
        }
    }

    internal static void ConfigureMySqlPointerBatch(DbCommand command, IReadOnlyList<ArticlePreservationStorageRow> rows)
    {
        if (rows.Count == 0)
            throw new InvalidOperationException("article_preservation_native_pointer_shape_changed");
        ArticlePreservationStorageRow first = rows[0];
        ArticlePreservationStorageColumn[] pointers = first.Columns.Where(static column => IsPointer(column)).ToArray();
        ArticlePreservationStorageColumn[] keys = first.Columns.Where(static column => column.IsPrimaryKey).ToArray();
        if (first.EntityOwner != ArticleOwner || pointers.Length != 2 || keys.Length != 1)
            throw new InvalidOperationException("article_preservation_native_pointer_shape_changed");
        ArticlePreservationStorageColumn[] shape = [keys[0], .. pointers];
        var selects = new List<string>(rows.Count);
        foreach (ArticlePreservationStorageRow row in rows)
        {
            if (row.Table != first.Table || row.EntityOwner != first.EntityOwner || row.Columns.Length != first.Columns.Length)
                throw new InvalidOperationException("article_preservation_native_pointer_shape_changed");
            var fields = new List<string>(3);
            foreach (ArticlePreservationStorageColumn column in shape)
            {
                ArticlePreservationStorageColumn actual = row.Columns.Single(value => value.Name == column.Name);
                if ((actual with
                {
                    Value = null
                }) != (column with
                {
                    Value = null
                }) || actual.Value is null)
                    throw new InvalidOperationException("article_preservation_native_pointer_shape_changed");
                fields.Add(Parameter(command, actual, actual.Value) + " AS " + DataQuote(column.Name, SchemaProviderKind.MySql));
            }
            selects.Add("SELECT " + string.Join(',', fields));
        }
        string key = DataQuote(keys[0].Name, SchemaProviderKind.MySql);
        string assignments = string.Join(',', pointers.Select(column => "target." + DataQuote(column.Name, SchemaProviderKind.MySql)
            + "=desired." + DataQuote(column.Name, SchemaProviderKind.MySql)));
        string nulls = string.Join(" AND ", pointers.Select(column => "target." + DataQuote(column.Name, SchemaProviderKind.MySql) + " IS NULL"));
        command.CommandText = $"UPDATE {DataTable(first.Table, SchemaProviderKind.MySql)} AS target JOIN ({string.Join(" UNION ALL ", selects)}) AS desired ON target.{key}=desired.{key} SET {assignments} WHERE {nulls};";
    }
}
