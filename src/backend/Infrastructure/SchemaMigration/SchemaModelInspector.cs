using System.Collections.Concurrent;
using System.Data;
using System.Data.Common;
using System.Reflection;

using SqlSugar;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaModelInspector
{
    IReadOnlyList<Type> GetManagedEntityTypes();
    CurrentSchemaCanonicalModel BuildCanonicalModel(IReadOnlyList<Type> entityTypes);
    SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes);
    Task<SchemaModelSnapshot> ReadActualModelAsync(ISqlSugarClient db, CancellationToken cancellationToken);
    Task ValidateAsync(
        ISqlSugarClient db,
        IReadOnlyList<Type> entityTypes,
        IReadOnlyCollection<string> allowedExtraTables,
        CancellationToken cancellationToken);
}

public sealed class SchemaModelInspector : ISchemaModelInspector
{
    private static readonly Lazy<IReadOnlyList<Type>> s_managedEntityTypes = new(
        () => typeof(SchemaModelInspector).Assembly
            .GetTypes()
            .Where(static type => type.GetCustomAttribute<SugarTable>(inherit: false) is not null)
            .OrderBy(static type => type.FullName, StringComparer.Ordinal)
            .ToArray());
    private static readonly ConcurrentDictionary<string, CurrentSchemaCanonicalModel> s_canonicalModelCache = new(StringComparer.Ordinal);

    public IReadOnlyList<Type> GetManagedEntityTypes()
        => s_managedEntityTypes.Value;

    public CurrentSchemaCanonicalModel BuildCanonicalModel(IReadOnlyList<Type> entityTypes)
        => s_canonicalModelCache.GetOrAdd(
            BuildEntityTypeCacheKey(entityTypes),
            _ => CurrentSchemaEntityExtractor.Extract(entityTypes));

    public SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes)
        => CurrentSchemaCanonicalAuthority.ProjectProvider(
            BuildCanonicalModel(entityTypes),
            SchemaProviderKind.PostgreSql);

    /// <summary>Reads through the sole current native catalog algorithm, borrowing only an actual caller RR transaction.</summary>
    public async Task<SchemaModelSnapshot> ReadActualModelAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
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
            if (supplied is not DbTransaction borrowed)
            {
                throw new InvalidOperationException("current_schema_provider_snapshot_unavailable");
            }
            // The shared reader verifies actual connection/TX identity and RR.
            // The caller alone owns rollback, commit and disposal of this transaction.
            return await PgCurrentSchemaCatalogObserver.ReadAsync(connection, borrowed, cancellationToken).ConfigureAwait(false);
        }
        bool opened = connection.State == ConnectionState.Closed;
        try
        {
            if (opened)
            {
                await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            }
            await using DbTransaction transaction = await connection.BeginTransactionAsync(
                IsolationLevel.RepeatableRead, cancellationToken).ConfigureAwait(false);
            await using (DbCommand readOnly = connection.CreateCommand())
            {
                readOnly.Transaction = transaction;
                readOnly.CommandText = "SET TRANSACTION READ ONLY;";
                await readOnly.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            return await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (opened)
            {
                await connection.CloseAsync().ConfigureAwait(false);
            }
        }
    }

    public async Task ValidateAsync(
        ISqlSugarClient db,
        IReadOnlyList<Type> entityTypes,
        IReadOnlyCollection<string> allowedExtraTables,
        CancellationToken cancellationToken)
    {
        SchemaModelSnapshot expected = BuildExpectedModel(entityTypes);
        SchemaModelSnapshot actual = await ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(
            expected,
            actual,
            allowedExtraTables,
            SchemaAllowedExtraLinkNames.Names);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Schema migration validation failed:{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}");
        }
    }

    internal static string NormalizeIdentifier(string name)
        => CurrentSchemaCanonicalAuthority.NormalizeIdentifier(name);

    private static string BuildEntityTypeCacheKey(IReadOnlyList<Type> entityTypes)
        => string.Join('|', entityTypes.Select(static type => type.AssemblyQualifiedName ?? type.FullName ?? type.Name));

    internal static string NormalizePostgresForeignKeyAction(string? action)
        => PgCurrentSchemaCatalogObserver.NormalizePostgresForeignKeyAction(action);

    internal static string NormalizePostgresForeignKeyMatchType(string? matchType)
        => PgCurrentSchemaCatalogObserver.NormalizePostgresForeignKeyMatchType(matchType);

    internal static IReadOnlyList<SchemaIndexKeyModel> ParsePostgresIndexKeys(string? json, bool hasExpressions)
        => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(json, hasExpressions);

    internal static string[] ParsePostgresIncludedColumns(string? json)
        => PgCurrentSchemaCatalogObserver.ParsePostgresIncludedColumns(json);

    internal static string ResolvePostgresGenerationKind(string? identityKind, string? rawDefault, bool hasOwnedSequence)
        => PgCurrentSchemaCatalogObserver.ResolvePostgresGenerationKind(identityKind, rawDefault, hasOwnedSequence);

    internal static string NormalizePostgresCollation(string? value)
        => PgCurrentSchemaCatalogObserver.NormalizePostgresCollation(value);

    internal static string NormalizePostgresPhysicalType(string value)
        => PgCurrentSchemaCatalogObserver.NormalizePostgresPhysicalType(value);

    internal static string? NormalizePostgresDefault(string? rawDefault)
        => PgCurrentSchemaCatalogObserver.NormalizePostgresDefault(rawDefault);
}
