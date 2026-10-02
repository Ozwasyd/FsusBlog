using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration;

// The target comes only from an actual original-owner invocation. The native
// database tuple comes from the issuer's sole capture, never from a plan.
internal sealed class PgCurrentSchemaOwnedTargetObserver(OwnedCurrentSchemaTarget owned) : IOfflineMigrationCurrentSchemaObserver
{
    internal OwnedCurrentSchemaTarget OwnedTarget { get; } = owned;

    public async Task<CurrentSchemaAdmissionObservation> ObserveAsync(
        DbConnection connection, DbTransaction transaction, CurrentSchemaDatabaseIdentity observedDatabase,
        CancellationToken cancellationToken)
    {
        CurrentSchemaReceiptCodec.ValidateDatabase(observedDatabase);
        if (observedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("current_schema_owned_native_provider_mismatch");
        await OwnedTarget.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        PgCurrentOwnedSnapshot snapshot = await ReadOwnedDomainAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        CurrentSchemaCompletePhysicalProjection expected = OwnedTarget.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql);
        IReadOnlyList<string> errors = Compare(expected, snapshot.Domain, snapshot.Effects);
        if (errors.Count != 0)
            throw new InvalidOperationException("current_schema_owned_native_mismatch:" + string.Join(',', errors));
        CurrentSchemaIdentity identity = OwnedTarget.Target;
        return new(new CurrentSchemaTargetIdentity(identity.ModelVersion, identity.ExtractorVersion, identity.GeneratorVersion,
            identity.SourceDigest, identity.ContentDigest), observedDatabase,
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(snapshot.Complete.Tables));
    }

    internal static async Task<PgCurrentOwnedSnapshot> ReadOwnedDomainAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        SchemaModelSnapshot complete = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        PgCurrentSchemaEffectObservation effects = await PgCurrentSchemaEffectObserver.ReadAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (!complete.Tables.ContainsKey(OfflineMigrationStateStore.ApplyJournalTableName)) return new(complete, complete, effects);
        // The original journal owner, not a copied current table mapping, validates
        // its exact control shape on this same connection and transaction. Retain
        // the complete native snapshot for its original physical observation hash.
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var tables = complete.Tables.Where(static table => table.Key != OfflineMigrationStateStore.ApplyJournalTableName)
            .ToDictionary(static table => table.Key, static table => table.Value, StringComparer.Ordinal);
        return new(complete, new SchemaModelSnapshot(tables, complete.Identity, complete.Provider), effects with
        {
            Expressions = effects.Expressions.Where(static expression => expression.Table != OfflineMigrationStateStore.ApplyJournalTableName).ToArray()
        });
    }

    internal static IReadOnlyList<string> Compare(CurrentSchemaCompletePhysicalProjection expected, SchemaModelSnapshot actual,
        PgCurrentSchemaEffectObservation effects)
    {
        if (!effects.StandardConformingStrings || actual.Provider != SchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("current_schema_owned_native_expression_context_unknown");
        var raw = new Dictionary<string, PgCurrentRawExpression>(StringComparer.Ordinal);
        foreach (PgCurrentRawExpression expression in effects.Expressions)
        {
            if (!raw.TryAdd(Key(expression.Kind, expression.Table, expression.Name), expression))
                throw new InvalidOperationException("current_schema_owned_native_expression_duplicate");
        }
        SchemaModelSnapshot wanted = Normalize(expected.Tables, raw, expected: true);
        SchemaModelSnapshot observed = Normalize(actual, raw, expected: false);
        return [.. SchemaModelComparer.Compare(wanted, observed), .. PgCurrentSchemaEffectObserver.CompareEffects(expected, effects)];
    }

    private static SchemaModelSnapshot Normalize(SchemaModelSnapshot snapshot, IReadOnlyDictionary<string, PgCurrentRawExpression> raw, bool expected)
    {
        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach ((string name, SchemaTableModel table) in snapshot.Tables)
        {
            var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
            foreach ((string columnName, SchemaColumnModel column) in table.Columns)
            {
                string? normalized;
                if (column.IsIdentity)
                {
                    if (!expected) ValidateIdentityDefault(name, column, raw);
                    normalized = null;
                }
                else if (expected)
                {
                    SchemaExpressionNode? expression = column.DefaultValue is null ? null
                        : PgCurrentSchemaExpressionParser.ParseExpectedDefault(column, table.Columns);
                    normalized = expression is null || expression.Kind == "null" ? null : ExpressionIdentity(expression);
                }
                else if (raw.TryGetValue(Key("default", name, columnName), out PgCurrentRawExpression? value))
                {
                    SchemaExpressionNode expression = PgCurrentSchemaExpressionParser.ParseObservedDefault(value.Expression, column, table.Columns);
                    normalized = expression.Kind == "null" ? null : ExpressionIdentity(expression);
                }
                else
                {
                    // The old catalog decoder may have normalized NULL or stripped
                    // a cast. It cannot invent a default missing from raw pg_attrdef.
                    if (column.DefaultValue is not null) throw new InvalidOperationException("current_schema_owned_native_default_unobserved");
                    normalized = null;
                }
                columns.Add(columnName, column with { DefaultValue = normalized });
            }
            var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
            foreach ((string constraintName, SchemaConstraintModel constraint) in table.Constraints)
            {
                if (constraint.Kind != "check")
                {
                    constraints.Add(constraintName, constraint);
                    continue;
                }
                string expression = expected ? constraint.Expression ?? throw new InvalidOperationException("current_schema_owned_check_facts_missing")
                    : raw.TryGetValue(Key("check", name, constraintName), out PgCurrentRawExpression? record) ? record.Expression
                    : throw new InvalidOperationException("current_schema_owned_native_check_unobserved");
                SchemaExpressionNode node = PgCurrentSchemaExpressionParser.Parse(expression, table.Columns);
                string[] referencedColumns = BoundColumns(node).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                if (!expected && !raw[Key("check", name, constraintName)].Columns.Order(StringComparer.Ordinal).SequenceEqual(referencedColumns))
                    throw new InvalidOperationException("current_schema_owned_native_check_dependencies_changed");
                constraints.Add(constraintName, constraint with { Expression = ExpressionIdentity(node), Columns = referencedColumns });
            }
            var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
            foreach ((string indexName, SchemaIndexModel index) in table.IndexDefinitions)
            {
                string? predicate = index.Predicate;
                if (expected && predicate is not null)
                    predicate = ExpressionIdentity(PgCurrentSchemaExpressionParser.Parse(predicate, table.Columns));
                else if (!expected && raw.TryGetValue(Key("index-predicate", name, indexName), out PgCurrentRawExpression? record))
                    predicate = ExpressionIdentity(PgCurrentSchemaExpressionParser.Parse(record.Expression, table.Columns));
                else if (!expected && predicate is not null)
                    throw new InvalidOperationException("current_schema_owned_native_index_predicate_unobserved");
                indexes.Add(indexName, index with { Predicate = predicate });
            }
            tables.Add(name, new SchemaTableModel(name, columns, table.Indexes, indexes, constraints, table.Owner));
        }
        foreach (PgCurrentRawExpression expression in raw.Values)
        {
            if (!snapshot.Tables.TryGetValue(expression.Table, out SchemaTableModel? table))
            {
                if (!expected) throw new InvalidOperationException("current_schema_owned_native_expression_table_unobserved");
                continue;
            }
            bool bound = expression.Kind switch
            {
                "default" => table.Columns.ContainsKey(expression.Name),
                "check" => table.Constraints.TryGetValue(expression.Name, out SchemaConstraintModel? constraint) && constraint.Kind == "check",
                "index-predicate" => table.IndexDefinitions.ContainsKey(expression.Name),
                _ => throw new InvalidOperationException("current_schema_owned_native_expression_kind_unknown")
            };
            if (!bound && !expected) throw new InvalidOperationException("current_schema_owned_native_expression_object_unobserved");
        }
        return new SchemaModelSnapshot(tables, snapshot.Identity, snapshot.Provider);
    }

    private static void ValidateIdentityDefault(string table, SchemaColumnModel column, IReadOnlyDictionary<string, PgCurrentRawExpression> raw)
    {
        bool hasDefault = raw.TryGetValue(Key("default", table, column.Name), out PgCurrentRawExpression? expression);
        if (column.GenerationKind == "identity-by-default" || column.GenerationKind == "identity-always")
        {
            if (hasDefault) throw new InvalidOperationException("current_schema_owned_native_identity_default_changed");
            return;
        }
        if (!hasDefault || column.OwnedSequence is not SchemaOwnedSequenceModel sequence
            || !expression!.SequenceReferences.SequenceEqual(new[] { sequence.Schema + "." + sequence.Name }))
            throw new InvalidOperationException("current_schema_owned_native_sequence_default_unbound");
        SchemaExpressionNode parsed = PgCurrentSchemaExpressionParser.Parse(expression.Expression, new Dictionary<string, SchemaColumnModel>());
        if (parsed.Kind != "call" || parsed.Value != "nextval" || parsed.Arguments.Count != 1)
            throw new InvalidOperationException("current_schema_owned_native_sequence_default_changed");
        SchemaExpressionNode cast = parsed.Arguments[0];
        if (cast.Kind != "cast" || cast.Value != "regclass" || cast.Arguments.Count != 1
            || cast.Arguments[0].Kind != "string" || cast.Arguments[0].Value != sequence.Name && cast.Arguments[0].Value != sequence.Schema + "." + sequence.Name)
            throw new InvalidOperationException("current_schema_owned_native_sequence_default_changed");
    }

    private static string Key(string kind, string table, string name) => kind + ":" + table + ":" + name;
    private static string ExpressionIdentity(SchemaExpressionNode expression) => "ast:v1:" + SchemaExpressionIdentity.Digest(expression);
    private static IEnumerable<string> BoundColumns(SchemaExpressionNode expression)
        => (expression.Kind == "column" ? new[] { expression.Value } : Array.Empty<string>()).Concat(expression.Arguments.SelectMany(BoundColumns));
}

internal sealed record PgCurrentOwnedSnapshot(SchemaModelSnapshot Complete, SchemaModelSnapshot Domain, PgCurrentSchemaEffectObservation Effects);
