using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;

using Npgsql;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Migration;

internal sealed record ArticlePreservationWriteLimits(
    int MaximumRows, int MaximumBatchRows, int MaximumBatchParameters, long MaximumArtifactBytes, TimeSpan OperationBudget);
internal sealed record ArticlePreservationStorageStage(string PlanDigest, long VerifiedRows, bool AlreadyPresent);

// Stage only: the original apply owner owns lock/admission, media CAS, commit/rollback
// and its one journal. No connection, transaction, grant or durable receipt is created here.
internal static class ArticlePreservationStorageWriter
{
    internal const string CleanupFailuresKey = "FsusBlog.ArticlePreservation.StorageCleanupFailures";
    private const string ArticleOwner = "FsusBlog.Server.Entities.Article";
    private const string ConfigurationOwner = "FsusBlog.Server.Entities.SystemConfig";

    internal static async Task<ArticlePreservationStorageStage> StagePostgreSqlAsync(
        ArticlePreservationWritePlan plan, ArticlePreservationSourceExport source, ArticlePreservationCurrentExport current,
        OwnedCurrentSchemaTarget ownedTarget, DbConnection connection, DbTransaction transaction,
        CurrentSchemaDatabaseIdentity observedDatabase, ArticlePreservationLimits projectionLimits,
        ArticleMediaLimits mediaLimits, ArticlePreservationWriteLimits writeLimits, CancellationToken cancellationToken)
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
        bool alreadyPresent = await StageRowsAsync(program.Rows, connection, transaction, writeLimits, token).ConfigureAwait(false);
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
        return new(plan.ContentDigest, program.Rows.Length, alreadyPresent);
    }

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
                    if ((column with { Value = null }) != (first.Columns[index] with { Value = null })
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
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token)
    {
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
                command.CommandText = $"SELECT count(*) FROM public.{Quote(group.Key)};";
                return Convert.ToInt64(await command.ExecuteScalarAsync(token).ConfigureAwait(false), CultureInfo.InvariantCulture);
            }).ConfigureAwait(false);
            anyExisting |= count != 0;
            allComplete &= count == group.Count();
        }
        if (anyExisting)
        {
            if (!allComplete) throw new InvalidOperationException("article_preservation_native_partial_target_refused");
            await VerifyRowsAsync(groups, connection, transaction, limits, token).ConfigureAwait(false);
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
                    ConfigureInsert(command, batch);
                    if (await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) != batch.Length)
                        throw new InvalidOperationException("article_preservation_native_batch_count_changed");
                    return true;
                }).ConfigureAwait(false);
            }
        }
        foreach (ArticlePreservationStorageRow article in rows.Where(static row => row.EntityOwner == ArticleOwner))
        {
            token.ThrowIfCancellationRequested();
            await CommandAsync(connection, transaction, limits, async command =>
            {
                ConfigurePointerCas(command, article);
                if (await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) != 1)
                    throw new InvalidOperationException("article_preservation_native_pointer_cas_failed");
                return true;
            }).ConfigureAwait(false);
        }
        await VerifyRowsAsync(groups, connection, transaction, limits, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return false;
    }

    internal static void ConfigureInsert(DbCommand command, IReadOnlyList<ArticlePreservationStorageRow> rows)
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
        string identity = first.Columns.Any(static column => column.IsIdentity) ? " OVERRIDING SYSTEM VALUE" : string.Empty;
        command.CommandText = $"INSERT INTO public.{Quote(first.Table)} ({string.Join(',', first.Columns.Select(static column => Quote(column.Name)))}){identity} VALUES {string.Join(',', values)};";
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

    private static async Task VerifyRowsAsync(IEnumerable<IGrouping<string, ArticlePreservationStorageRow>> groups,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token)
    {
        foreach (IGrouping<string, ArticlePreservationStorageRow> group in groups)
        {
            ArticlePreservationStorageColumn[] columns = group.First().Columns.OrderByDescending(static column => column.IsPrimaryKey)
                .ThenBy(static column => column.Name, StringComparer.Ordinal).ToArray();
            int keys = columns.Count(static column => column.IsPrimaryKey);
            var expected = group.ToDictionary(row => Key(row.Columns.Where(static column => column.IsPrimaryKey)
                .OrderBy(static column => column.Name, StringComparer.Ordinal).Select(static column => column.Value).ToArray()), StringComparer.Ordinal);
            await CommandAsync(connection, transaction, limits, async command =>
            {
                command.CommandText = $"SELECT {string.Join(',', columns.Select(static column => Quote(column.Name)))} FROM public.{Quote(group.Key)};";
                await ReaderAsync(command, token, async reader =>
                {
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                    {
                        object?[] key = new object?[keys];
                        for (int index = 0; index < keys; index++) key[index] = reader.IsDBNull(index) ? null : reader.GetValue(index);
                        if (!expected.Remove(Key(key), out ArticlePreservationStorageRow? row))
                            throw new InvalidOperationException("article_preservation_native_row_identity_changed");
                        var values = row.Columns.ToDictionary(static column => column.Name, static column => column.Value, StringComparer.Ordinal);
                        for (int index = keys; index < columns.Length; index++)
                        {
                            object? wanted = values[columns[index].Name];
                            if (await reader.IsDBNullAsync(index, token).ConfigureAwait(false))
                            {
                                if (wanted is not null) throw new InvalidOperationException("article_preservation_native_row_value_changed");
                            }
                            else if (wanted is string text)
                            {
                                await CompareTextAsync(reader.GetTextReader(index), text, token).ConfigureAwait(false);
                            }
                            else if (!Equals(wanted, reader.GetValue(index)))
                                throw new InvalidOperationException("article_preservation_native_row_value_changed");
                        }
                    }
                    if (expected.Count != 0) throw new InvalidOperationException("article_preservation_native_row_missing");
                    return true;
                }).ConfigureAwait(false);
                return true;
            }).ConfigureAwait(false);
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
                if (total > expected.Length) throw new InvalidOperationException("article_preservation_native_original_artifact_changed");
                hash.AppendData(buffer.AsSpan(0, read));
            }
            if (total != expected.Length || Convert.ToHexStringLower(hash.GetHashAndReset()) != artifact.Sha256)
                throw new InvalidOperationException("article_preservation_native_original_artifact_changed");
        }
        catch (Exception failure) { first = failure; }
        try { await input.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RememberCleanup(ref first, cleanup, "article_preservation_native_artifact_disposal_failed"); }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
    }

    private static async Task RequireSiteAuthorAsync(ArticlePreservationSourceExport source, SchemaModelSnapshot schema,
        DbConnection connection, DbTransaction transaction, ArticlePreservationWriteLimits limits, CancellationToken token)
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
            command.CommandText = $"SELECT {Quote(value.Name)} FROM public.{Quote(table.Name)} WHERE {Quote(key.Name)}=@key;";
            return await ReaderAsync(command, token, async reader =>
            {
                string? result = null;
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    result = reader.IsDBNull(0) ? null : reader.GetString(0);
                    if (await reader.ReadAsync(token).ConfigureAwait(false))
                        throw new InvalidOperationException("article_preservation_native_site_author_ambiguous");
                }
                return result;
            }).ConfigureAwait(false);
        }).ConfigureAwait(false);
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
            "string" => DbType.String, "int32" => DbType.Int32, "int64" => DbType.Int64,
            "boolean" => DbType.Boolean, "timestamp" => DbType.DateTime2,
            _ => throw new InvalidOperationException("article_preservation_native_parameter_type_unavailable")
        };
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
        return parameter.ParameterName;
    }

    internal static async Task<T> CommandAsync<T>(DbConnection connection, DbTransaction transaction,
        ArticlePreservationWriteLimits limits, Func<DbCommand, Task<T>> body)
    {
        DbCommand command = connection.CreateCommand();
        Exception? first = null;
        T result = default!;
        try
        {
            command.Transaction = transaction;
            command.CommandTimeout = checked((int)Math.Max(1, Math.Ceiling(limits.OperationBudget.TotalSeconds)));
            result = await body(command).ConfigureAwait(false);
        }
        catch (Exception failure) { first = failure; }
        try { await command.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RememberCleanup(ref first, cleanup, "article_preservation_native_command_disposal_failed"); }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private static async Task<T> ReaderAsync<T>(DbCommand command, CancellationToken token, Func<DbDataReader, Task<T>> body)
    {
        DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false);
        Exception? first = null;
        T result = default!;
        try { result = await body(reader).ConfigureAwait(false); }
        catch (Exception failure) { first = failure; }
        try { await reader.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RememberCleanup(ref first, cleanup, "article_preservation_native_reader_disposal_failed"); }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private static void RememberCleanup(ref Exception? first, Exception cleanup, string code)
    {
        first ??= cleanup;
        ImmutableArray<string> codes = first.Data[CleanupFailuresKey] is ImmutableArray<string> recorded
            ? recorded : ImmutableArray<string>.Empty;
        first.Data[CleanupFailuresKey] = codes.Add(code);
    }
    private static async Task CompareTextAsync(TextReader actual, string text, CancellationToken token)
    {
        Exception? first = null;
        try
        {
            char[] chunk = new char[4096];
            int offset = 0;
            int read;
            while ((read = await actual.ReadAsync(chunk.AsMemory(), token).ConfigureAwait(false)) != 0)
            {
                if (read > text.Length - offset || !chunk.AsSpan(0, read).SequenceEqual(text.AsSpan(offset, read)))
                    throw new InvalidOperationException("article_preservation_native_row_value_changed");
                offset += read;
            }
            if (offset != text.Length) throw new InvalidOperationException("article_preservation_native_row_value_changed");
        }
        catch (Exception failure) { first = failure; }
        try { actual.Dispose(); }
        catch (Exception cleanup) { RememberCleanup(ref first, cleanup, "article_preservation_native_text_disposal_failed"); }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
    }
    private static bool IsPointer(ArticlePreservationStorageColumn column)
        => column.PropertyOwner == ArticleOwner + ".CurrentRevisionId" || column.PropertyOwner == ArticleOwner + ".CurrentPublicationId";
    private static string Key(object?[] values) => ArticlePreservationSemanticReceipt.Digest("article-storage-native-key-v1", values);
    private static string Quote(string identifier) => SchemaMigrationSql.QuoteIdentifier(identifier);
}
