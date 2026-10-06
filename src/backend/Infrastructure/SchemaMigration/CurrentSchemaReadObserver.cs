using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Shared.Algorithms.Schema;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>Fresh complete native schema/effect evidence and the single entity-plus-recipe target identity.</summary>
public sealed record CurrentSchemaReadObservation(
    CurrentSchemaIdentity CanonicalIdentity,
    SchemaModelSnapshot ActualSchema,
    string ActualDigest);

/// <summary>Native session facts captured on both sides of one owned read-only repeatable-read catalog snapshot.</summary>
public sealed record CurrentSchemaNativeSessionIdentity(
    CurrentSchemaDatabaseIdentity Database,
    string Username,
    string ServerVersion,
    string ServerVersionNumber,
    string? ServerAddress,
    int? ServerPort,
    int BackendPid,
    string ReadOnly,
    string Isolation);

internal sealed record CurrentSchemaOwnedReadSnapshot(
    CurrentSchemaAdmissionObservation Admission,
    CurrentSchemaReadObservation Schema,
    CurrentSchemaNativeSessionIdentity Session);

/// <summary>Observes current facts without DDL, backfill, journal/history interpretation or receipt issuance.</summary>
public sealed class CurrentSchemaReadObserver(ISqlSugarClient db, ISchemaModelInspector inspector)
{
    private readonly Func<CancellationToken, Task<PgCurrentSchemaNativeObservation>>? _testNativeReader;

    // A unit-only native-fact seam: production admission cannot construct or consume this reader.
    internal CurrentSchemaReadObserver(ISchemaModelInspector inspector,
        Func<CancellationToken, Task<PgCurrentSchemaNativeObservation>> testNativeReader)
        : this(null!, inspector)
    {
        _testNativeReader = testNativeReader;
    }

    /// <summary>Reads the database tuple and complete current facts on the same actual read-only native RR snapshot.</summary>
    public async Task<CurrentSchemaAdmissionObservation> ReadAdmissionAsync(CancellationToken cancellationToken)
        => (await ReadOwnedAdmissionSnapshotAsync(cancellationToken).ConfigureAwait(false)).Admission;

    internal async Task<CurrentSchemaOwnedReadSnapshot> ReadOwnedAdmissionSnapshotAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_testNativeReader is not null)
        {
            throw new InvalidOperationException("current_schema_native_admission_requires_actual_database");
        }
        (PgCurrentSchemaNativeObservation native, CurrentSchemaNativeSessionIdentity session) =
            await ReadNativeAsync(cancellationToken, requireOwnReadOnlySnapshot: true).ConfigureAwait(false);
        CurrentSchemaReadObservation schema = CompareObservation(native);
        CurrentSchemaIdentity identity = schema.CanonicalIdentity;
        cancellationToken.ThrowIfCancellationRequested();
        var admission = new CurrentSchemaAdmissionObservation(
            new CurrentSchemaTargetIdentity(identity.ModelVersion, identity.ExtractorVersion, identity.GeneratorVersion,
                identity.SourceDigest, identity.ContentDigest), session.Database, schema.ActualDigest);
        return new CurrentSchemaOwnedReadSnapshot(admission, schema, session);
    }

    /// <summary>Reads complete native relational/effect facts and rejects missing, unknown or altered current recipes.</summary>
    public async Task<CurrentSchemaReadObservation> ReadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PgCurrentSchemaNativeObservation native;
        try
        {
            native = _testNativeReader is not null
                ? await _testNativeReader(cancellationToken).ConfigureAwait(false)
                : (await ReadNativeAsync(cancellationToken, requireOwnReadOnlySnapshot: false).ConfigureAwait(false)).Native;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            CurrentSchemaIdentity expected = Expected().Identity;
            throw new CurrentSchemaMismatchException(expected.ContentDigest, "unavailable",
                "fsusblog.current-schema.mismatch.unreadable",
                [$"actual complete schema/effects could not be read without writes: {exception.GetType().Name}"]);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return CompareObservation(native);
    }

    private (CurrentSchemaIdentity Identity, CurrentSchemaCompletePhysicalProjection Physical) Expected()
    {
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes());
        CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(canonical);
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
        return (CurrentSchemaOwnedTargetProjection.Observe(entity, recipes),
            CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(entity, recipes, SchemaProviderKind.PostgreSql));
    }

    private CurrentSchemaReadObservation CompareObservation(PgCurrentSchemaNativeObservation native)
    {
        (CurrentSchemaIdentity identity, CurrentSchemaCompletePhysicalProjection expected) = Expected();
        string actualDigest = CurrentSchemaCanonicalAuthority.ComputeObservationDigest(native.Tables.Tables);
        IReadOnlyList<string> errors;
        try
        {
            errors = PgCurrentSchemaNativeObserver.Compare(expected, native.Tables, native.Effects);
        }
        catch (InvalidOperationException exception)
        {
            errors = [exception.Message];
        }
        if (errors.Count > 0)
        {
            throw new CurrentSchemaMismatchException(identity.ContentDigest, actualDigest,
                "fsusblog.current-schema.mismatch", errors);
        }
        return new CurrentSchemaReadObservation(identity, native.Tables, actualDigest);
    }

    private async Task<(PgCurrentSchemaNativeObservation Native, CurrentSchemaNativeSessionIdentity Session)> ReadNativeAsync(
        CancellationToken cancellationToken, bool requireOwnReadOnlySnapshot)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || db.Ado.Connection is not DbConnection connection
            || connection.GetType().FullName != "Npgsql.NpgsqlConnection")
        {
            throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
        }
        if (db.Ado.Transaction is { } supplied)
        {
            if (requireOwnReadOnlySnapshot || supplied is not DbTransaction borrowed)
            {
                throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
            }
            // Schema evidence can borrow the actual caller's RR snapshot. It never
            // commits/disposes that owner, nor becomes production receipt admission.
            return await ReadNativeSnapshotAsync(connection, borrowed, cancellationToken, requireReadOnly: false).ConfigureAwait(false);
        }
        bool opened = connection.State == ConnectionState.Closed;
        DbTransaction? transaction = null;
        (PgCurrentSchemaNativeObservation Native, CurrentSchemaNativeSessionIdentity Session) result = default;
        Exception? primary = null;
        var cleanupFailures = new List<Exception>();
        try
        {
            if (opened)
            {
                await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            }
            RequireConnection(connection, cancellationToken);
            if (db.Ado.Transaction is not null)
            {
                throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
            }
            transaction = await connection.BeginTransactionAsync(
                IsolationLevel.RepeatableRead, cancellationToken).ConfigureAwait(false);
            RequireContext(connection, transaction, null, cancellationToken);
            DbCommand readOnly = connection.CreateCommand();
            Exception? commandFailure = null;
            try
            {
                readOnly.Transaction = transaction;
                readOnly.CommandText = "SET TRANSACTION READ ONLY;";
                await readOnly.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                RequireContext(connection, transaction, null, cancellationToken);
            }
            catch (Exception exception)
            {
                commandFailure = exception;
            }
            try
            {
                await readOnly.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                var failures = new List<Exception>();
                if (commandFailure is not null)
                {
                    failures.Add(commandFailure);
                }
                failures.Add(exception);
                throw new AggregateException("current_schema_read_only_command_cleanup_failed", failures);
            }
            if (commandFailure is not null)
            {
                ExceptionDispatchInfo.Capture(commandFailure).Throw();
            }
            RequireContext(connection, transaction, null, cancellationToken);
            result = await ReadNativeSnapshotAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            primary = exception;
        }
        finally
        {
            if (transaction is not null)
            {
                // The owner must complete rollback even when the observation token was cancelled.
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try
                {
                    await transaction.RollbackAsync(cleanup.Token).ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    cleanupFailures.Add(exception);
                }
                try
                {
                    await transaction.DisposeAsync().ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    cleanupFailures.Add(exception);
                }
                try
                {
                    if (!ReferenceEquals(connection, db.Ado.Connection) || db.Ado.Transaction is not null)
                    {
                        throw new InvalidOperationException("current_schema_cleanup_connection_changed");
                    }
                }
                catch (Exception exception)
                {
                    cleanupFailures.Add(exception);
                }
            }
            if (opened)
            {
                try
                {
                    await connection.CloseAsync().ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    cleanupFailures.Add(exception);
                }
            }
            try
            {
                if (!ReferenceEquals(connection, db.Ado.Connection) || db.Ado.Transaction is not null)
                {
                    throw new InvalidOperationException("current_schema_cleanup_connection_changed");
                }
            }
            catch (Exception exception)
            {
                cleanupFailures.Add(exception);
            }
        }
        if (cleanupFailures.Count > 0)
        {
            if (primary is not null)
            {
                cleanupFailures.Insert(0, primary);
            }
            throw new AggregateException("current_schema_snapshot_cleanup_failed", cleanupFailures);
        }
        if (primary is not null)
        {
            ExceptionDispatchInfo.Capture(primary).Throw();
        }
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }

    private async Task<(PgCurrentSchemaNativeObservation Native, CurrentSchemaNativeSessionIdentity Session)> ReadNativeSnapshotAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken, bool requireReadOnly = true)
    {
        object? originalTransaction = db.Ado.Transaction;
        if (requireReadOnly && originalTransaction is not null)
        {
            throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
        }
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        CurrentSchemaNativeSessionIdentity before = await ReadDatabaseIdentityAsync(
            connection, transaction, originalTransaction, cancellationToken, requireReadOnly).ConfigureAwait(false);
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        PgCurrentSchemaNativeObservation native = await PgCurrentSchemaNativeObserver.ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        CurrentSchemaNativeSessionIdentity after = await ReadDatabaseIdentityAsync(
            connection, transaction, originalTransaction, cancellationToken, requireReadOnly).ConfigureAwait(false);
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        if (before != after)
        {
            throw new InvalidOperationException("current_schema_database_identity_changed");
        }
        return (native, after);
    }

    private void RequireConnection(DbConnection connection, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ReferenceEquals(connection, db.Ado.Connection) || connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("current_schema_observation_connection_changed");
        }
    }

    private void RequireContext(DbConnection connection, DbTransaction transaction, object? originalTransaction,
        CancellationToken cancellationToken)
    {
        RequireConnection(connection, cancellationToken);
        PgCurrentSchemaEffectObserver.RequireSnapshot(connection, transaction);
        if (!ReferenceEquals(originalTransaction, db.Ado.Transaction)
            || !ReferenceEquals(connection, transaction.Connection))
        {
            throw new InvalidOperationException("current_schema_observation_transaction_changed");
        }
    }

    private async Task<CurrentSchemaNativeSessionIdentity> ReadDatabaseIdentityAsync(
        DbConnection connection, DbTransaction transaction, object? originalTransaction, CancellationToken cancellationToken,
        bool requireReadOnly)
    {
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        DbCommand command = connection.CreateCommand();
        DbDataReader? reader = null;
        Exception? primary = null;
        var secondary = new List<Exception>();
        CurrentSchemaNativeSessionIdentity result = null!;
        try
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT control.system_identifier::text AS instance_id,
                       current_database()::text AS database_name,
                       database_identity.oid::text AS database_oid,
                       current_user::text AS username,
                       current_setting('server_version') AS server_version,
                       current_setting('server_version_num') AS server_version_number,
                       inet_server_addr()::text AS server_address,
                       inet_server_port() AS server_port,
                       pg_backend_pid() AS backend_pid,
                       current_setting('transaction_read_only') AS read_only,
                       current_setting('transaction_isolation') AS isolation
                FROM pg_catalog.pg_control_system() AS control
                CROSS JOIN pg_catalog.pg_database AS database_identity
                WHERE database_identity.datname = current_database();
                """;
            reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            RequireContext(connection, transaction, originalTransaction, cancellationToken);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("current_schema_database_identity_unobserved");
            }
            RequireContext(connection, transaction, originalTransaction, cancellationToken);
            var identity = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql,
                reader.GetString(0), $"{reader.GetString(2)}/{reader.GetString(1)}");
            var session = new CurrentSchemaNativeSessionIdentity(identity, reader.GetString(3), reader.GetString(4),
                reader.GetString(5), reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetInt32(7), reader.GetInt32(8), reader.GetString(9), reader.GetString(10));
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("current_schema_database_identity_unobserved");
            }
            RequireContext(connection, transaction, originalTransaction, cancellationToken);
            CurrentSchemaReceiptCodec.ValidateDatabase(identity);
            if ((requireReadOnly && session.ReadOnly != "on") || session.Isolation != "repeatable read"
                || string.IsNullOrWhiteSpace(session.Username) || session.BackendPid <= 0)
            {
                throw new InvalidOperationException("current_schema_native_read_only_identity_mismatch");
            }
            result = session;
        }
        catch (Exception exception)
        {
            primary = exception;
        }
        finally
        {
            if (reader is not null)
            {
                try
                {
                    await reader.DisposeAsync().ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    secondary.Add(exception);
                }
            }
            try
            {
                await command.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                secondary.Add(exception);
            }
        }
        if (secondary.Count > 0)
        {
            if (primary is not null)
            {
                secondary.Insert(0, primary);
            }
            throw new AggregateException("current_schema_identity_cleanup_failed", secondary);
        }
        if (primary is not null)
        {
            ExceptionDispatchInfo.Capture(primary).Throw();
        }
        RequireContext(connection, transaction, originalTransaction, cancellationToken);
        return result;
    }
}
