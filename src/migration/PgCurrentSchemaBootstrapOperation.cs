using System.Collections.Immutable;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Migration;

// A real PostgreSQL empty-source component. It is not a full three-provider DAG,
// a known-legacy target-preparation operation, or permission to bypass core admission.
internal sealed class PgCurrentSchemaBootstrapOperation : OfflineMigrationApplyOperation
{
    internal const string StepReference = "bootstrap-current-schema";
    internal const string EmptyPredicate = "current-owned-empty-source.v1";
    internal const string TargetPredicate = "current-owned-bootstrap-target.v1";
    private readonly OwnedCurrentSchemaTarget _owned;
    private readonly CompiledCurrentSchemaBootstrap _compiled;
    private readonly CurrentSchemaCompletePhysicalProjection _expected;
    private readonly string _assemblyPath;
    private readonly string _assemblyDigest;

    private PgCurrentSchemaBootstrapOperation(OwnedCurrentSchemaTarget owned, CompiledCurrentSchemaBootstrap compiled,
        CurrentSchemaCompletePhysicalProjection expected, CurrentSchemaVerifierIdentity retainedTool,
        string assemblyPath, string assemblyDigest)
    {
        _owned = owned;
        _compiled = compiled;
        _expected = expected;
        _assemblyPath = assemblyPath;
        _assemblyDigest = assemblyDigest;
        RetainedTool = retainedTool;
        string semantic = OfflineMigrationPlanValidation.Digest(new
        {
            Owner = StepReference,
            Source = EmptyPredicate,
            Target = TargetPredicate,
            CurrentTarget = owned.Target,
            Input = CurrentSchemaOwnedTargetProjection.ComputeInputDigest(owned.ReadBoundInput())
        });
        Identity = new(CurrentSchemaProviderKind.PostgreSql, "compiled-pg:" + StepReference, assemblyDigest, semantic, OfflineMigrationExecutionMode.Transaction);
        Step = new(StepReference, EmptyPredicate, TargetPredicate, [], "transactional-create-owned-target-from-empty.v1", false,
            new("current-owned-bootstrap-resume.v1", 0, "no-partial-transaction-watermark", TargetPredicate), [Identity]);
    }

    internal override OfflineMigrationProviderOperation Identity
    {
        get;
    }
    internal OfflineMigrationStep Step
    {
        get;
    }
    internal CurrentSchemaVerifierIdentity RetainedTool
    {
        get;
    }

    internal static async Task<PgCurrentSchemaBootstrapOperation> CreateAsync(
        OwnedCurrentSchemaTarget owned, CurrentSchemaVerifierIdentity actualRetainedTool, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(owned);
        ArgumentNullException.ThrowIfNull(actualRetainedTool);
        if (actualRetainedTool.SourceRevision != owned.Execution.SourceRevision)
            throw new InvalidOperationException("current_schema_bootstrap_tool_source_mismatch");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.WorktreeDigest, "current_schema_bootstrap_tool_worktree_invalid");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.ToolchainDigest, "current_schema_bootstrap_tool_toolchain_invalid");
        OfflineMigrationPlanValidation.RequireDigest(actualRetainedTool.ConfigurationDigest, "current_schema_bootstrap_tool_configuration_invalid");
        await owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        CompiledCurrentSchemaBootstrap compiled = owned.Compile(SchemaProviderKind.PostgreSql);
        if (compiled.Commands.Count == 0)
            throw new InvalidOperationException("current_schema_bootstrap_empty_commands");
        string assemblyPath = Path.GetFullPath(typeof(PgCurrentSchemaBootstrapOperation).Assembly.Location);
        string digest = await HashOriginalAssemblyAsync(assemblyPath, cancellationToken).ConfigureAwait(false);
        var operation = new PgCurrentSchemaBootstrapOperation(owned, compiled, owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql), actualRetainedTool, assemblyPath, digest);
        _ = operation.ExpectedSeedFacts();
        return operation;
    }

    internal override async Task<OfflineMigrationPredicateObservation> ObserveAsync(
        string predicateReference, DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        await RevalidateAsync(cancellationToken).ConfigureAwait(false);
        PgCurrentOwnedSnapshot snapshot = await PgCurrentSchemaOwnedTargetObserver.ReadOwnedDomainAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        ImmutableArray<OfflineMigrationFact> expected;
        ImmutableArray<OfflineMigrationFact> actual;
        if (predicateReference == EmptyPredicate)
        {
            expected = Facts(("functions", "0"), ("sequences", "0"), ("standard_strings", "true"), ("tables", "0"), ("triggers", "0"));
            actual = Facts(("functions", Count(snapshot.Effects.Functions.Count)), ("sequences", Count(snapshot.Effects.Sequences.Count)),
                ("standard_strings", snapshot.Effects.StandardConformingStrings ? "true" : "false"),
                ("tables", Count(snapshot.Domain.Tables.Count)), ("triggers", Count(snapshot.Effects.Triggers.Count)));
        }
        else if (predicateReference == TargetPredicate)
        {
            bool match = PgCurrentSchemaOwnedTargetObserver.Compare(_expected, snapshot.Complete, snapshot.Effects).Count == 0;
            expected = [.. Facts(("owned_shape_match", "true")), .. ExpectedSeedFacts()];
            IEnumerable<OfflineMigrationFact> seedFacts = match
                ? await ReadSeedFactsAsync(connection, transaction, cancellationToken).ConfigureAwait(false)
                : ExpectedSeedFacts().Select(static fact => fact with { Value = "unobserved" });
            actual = [.. Facts(("owned_shape_match", match ? "true" : "false")),
                .. seedFacts];
        }
        else
            throw new InvalidOperationException("current_schema_bootstrap_predicate_unknown");
        var observation = new OfflineMigrationPredicateObservation(predicateReference, Identity.OperationReference,
            Identity.OperationSourceDigest, Identity.SemanticDigest, expected, actual, string.Empty);
        return observation with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
        };
    }

    internal override async Task<OfflineMigrationApplyUnit> ExecuteAsync(
        OfflineMigrationStep step, OfflineMigrationApplyJournalEntry? previousUnit,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireStep(step, Identity);
        if (previousUnit is not null)
            throw new InvalidOperationException("current_schema_bootstrap_partial_transaction_not_resumable");
        OfflineMigrationPredicateObservation before = await ObserveAsync(EmptyPredicate, connection, transaction, cancellationToken).ConfigureAwait(false);
        if (!before.ExpectedFacts.SequenceEqual(before.ActualFacts))
            throw new InvalidOperationException("current_schema_bootstrap_empty_source_required");
        // The original compiler executes every entity and ordered recipe effect on
        // the caller transaction. The core alone commits or rolls it back.
        await CurrentSchemaBootstrapCompiler.ExecuteAsync(_compiled, connection, transaction, cancellationToken).ConfigureAwait(false);
        if (!await CheckInitialSeedValuesAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
            throw new InvalidOperationException("current_schema_bootstrap_seed_values_mismatch");
        OfflineMigrationPredicateObservation after = await ObserveAsync(TargetPredicate, connection, transaction, cancellationToken).ConfigureAwait(false);
        if (!after.ExpectedFacts.SequenceEqual(after.ActualFacts))
            throw new InvalidOperationException("current_schema_bootstrap_target_postcondition_failed");
        long rows = _expected.BootstrapDataEffects.Count;
        return new(null, null, null, rows, rows, true);
    }

    internal void RequireStep(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
    {
        if (operation != Identity || step.StepId != Step.StepId || step.SourcePrecondition != Step.SourcePrecondition
            || step.TargetPostcondition != Step.TargetPostcondition || !step.Dependencies.SequenceEqual(Step.Dependencies)
            || step.IdempotencyDefinition != Step.IdempotencyDefinition || step.Destructive != Step.Destructive
            || step.ResumePolicy != Step.ResumePolicy || step.Operations.Count(value => value.Provider == Identity.Provider) != 1
            || step.Operations.Single(value => value.Provider == Identity.Provider) != Identity)
            throw new InvalidOperationException("current_schema_bootstrap_step_binding_changed");
    }

    private async Task RevalidateAsync(CancellationToken cancellationToken)
    {
        await _owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        if (await HashOriginalAssemblyAsync(_assemblyPath, cancellationToken).ConfigureAwait(false) != _assemblyDigest)
            throw new InvalidOperationException("current_schema_bootstrap_compiled_owner_changed");
    }

    private ImmutableArray<OfflineMigrationFact> ExpectedSeedFacts()
    {
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < _expected.BootstrapDataEffects.Count; index++)
        {
            CurrentSchemaRecipeOperation seed = _expected.BootstrapDataEffects[index];
            (SchemaTableModel table, IReadOnlyList<string> columns, IReadOnlyList<string> values) = Seed(seed);
            int key = columns.ToList().IndexOf(seed.ConflictColumn!);
            if (key < 0)
                throw new InvalidOperationException("current_schema_bootstrap_seed_key_missing");
            SchemaExpressionNode literal = PgCurrentSchemaExpressionParser.Parse(values[key], new Dictionary<string, SchemaColumnModel>());
            string digest = SchemaExpressionIdentity.Digest(ExpectedKey(table.Columns[columns[key]], literal));
            if (!keys.Add(table.Name + ":" + seed.ConflictColumn + ":" + digest))
                throw new InvalidOperationException("current_schema_bootstrap_seed_key_duplicate");
            facts.Add(new(SeedName(index, "count"), "1"));
            facts.Add(new(SeedName(index, "digest"), digest));
        }
        // The original core fact vector has 256 slots; do not fabricate a truncated
        // observation if a future owned source cannot fit its native vocabulary.
        if (facts.Count + 1 > 256)
            throw new InvalidOperationException("current_schema_bootstrap_seed_fact_capacity_unavailable");
        return facts.OrderBy(static fact => fact.Name, StringComparer.Ordinal).ToImmutableArray();
    }

    private async Task<ImmutableArray<OfflineMigrationFact>> ReadSeedFactsAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        for (int index = 0; index < _expected.BootstrapDataEffects.Count; index++)
        {
            (SchemaTableModel table, IReadOnlyList<string> columns, IReadOnlyList<string> values) = Seed(_expected.BootstrapDataEffects[index]);
            int key = columns.ToList().IndexOf(_expected.BootstrapDataEffects[index].ConflictColumn!);
            SchemaColumnModel column = table.Columns[columns[key]];
            await using DbCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"SELECT {Quote(column.Name)} FROM public.{Quote(table.Name)} WHERE {Equality(column, values[key])};";
            await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            long count = 0;
            string digest = "missing";
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                count++;
                if (count == 1)
                    digest = SchemaExpressionIdentity.Digest(ActualKey(column, reader.GetValue(0)));
                // Two actual rows already prove a failed uniqueness/cardinality
                // postcondition. Do not retain unbounded private row values.
                if (count == 2)
                    break;
            }
            facts.Add(new(SeedName(index, "count"), count.ToString(CultureInfo.InvariantCulture)));
            facts.Add(new(SeedName(index, "digest"), digest));
        }
        return facts.OrderBy(static fact => fact.Name, StringComparer.Ordinal).ToImmutableArray();
    }

    internal static SchemaExpressionNode ExpectedKey(SchemaColumnModel column, SchemaExpressionNode value)
    {
        if (column.DataType == "string" && value.Kind == "string")
            return value;
        if (column.DataType is "int16" or "int32" or "int64")
            return PgCurrentSchemaExpressionParser.NormalizeIntegralStorageLiteral(value, column);
        if (column.DataType == "boolean" && value.Kind == "boolean")
            return value;
        if (column.DataType == "uuid")
        {
            if (value.Kind == "cast" && value.Value == "uuid" && value.Arguments.Count == 1)
                value = value.Arguments[0];
            if (value.Kind == "string" && Guid.TryParse(value.Value, out Guid identity))
                return new("uuid", identity.ToString("D"), []);
        }
        throw new InvalidOperationException("current_schema_bootstrap_stable_seed_key_capability_unavailable");
    }

    internal static SchemaExpressionNode ActualKey(SchemaColumnModel column, object value)
        => column.DataType switch
        {
            "string" when value is string text => new("string", text, []),
            "int16" when value is short => NativeIntegralKey(column, value),
            "int32" when value is int => NativeIntegralKey(column, value),
            "int64" when value is long => NativeIntegralKey(column, value),
            "boolean" when value is bool boolean => new("boolean", boolean ? "true" : "false", []),
            "uuid" when value is Guid identity => new("uuid", identity.ToString("D"), []),
            _ => throw new InvalidOperationException("current_schema_bootstrap_native_seed_key_type_unknown")
        };

    private static SchemaExpressionNode NativeIntegralKey(SchemaColumnModel column, object value)
        => PgCurrentSchemaExpressionParser.NormalizeIntegralStorageLiteral(
            new("number", ExactDecimalLiteral.Normalize(Convert.ToString(value, CultureInfo.InvariantCulture)!), []), column);

    private static string SeedName(int index, string fact) => "seed." + index.ToString("D4", CultureInfo.InvariantCulture) + "." + fact;

    private async Task<bool> CheckInitialSeedValuesAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        foreach (CurrentSchemaRecipeOperation seed in _expected.BootstrapDataEffects)
        {
            (SchemaTableModel table, IReadOnlyList<string> columns, IReadOnlyList<string> values) = Seed(seed);
            string predicate = string.Join(" AND ", columns.Select((column, index) => Equality(table.Columns[column], values[index])));
            await using DbCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"SELECT count(*) FROM public.{Quote(table.Name)} WHERE {predicate};";
            if (Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false)) != 1)
                return false;
        }
        return true;
    }

    private (SchemaTableModel Table, IReadOnlyList<string> Columns, IReadOnlyList<string> Values) Seed(CurrentSchemaRecipeOperation seed)
    {
        if (seed.Kind != CurrentSchemaRecipeOperationKind.InsertIfAbsent || seed.Table is null
            || !_expected.Tables.Tables.TryGetValue(seed.Table, out SchemaTableModel? table)
            || seed.Columns is null || seed.Values is null || seed.Columns.Count != seed.Values.Count
            || seed.Columns.Count == 0 || seed.Columns.Distinct(StringComparer.Ordinal).Count() != seed.Columns.Count
            || seed.ConflictColumn is null || seed.Columns.Any(column => !table.Columns.ContainsKey(column)))
            throw new InvalidOperationException("current_schema_bootstrap_seed_binding_invalid");
        return (table, seed.Columns, seed.Values);
    }

    private static string Equality(SchemaColumnModel column, string ownedExpression)
        => $"{Quote(column.Name)} IS NOT DISTINCT FROM CAST(({ownedExpression}) AS {column.PhysicalType ?? throw new InvalidOperationException("current_schema_bootstrap_seed_storage_type_missing")})";

    private static string Quote(string name) => SchemaMigrationSql.QuoteIdentifier(name);
    private static string Count(int value) => value.ToString(CultureInfo.InvariantCulture);
    private static ImmutableArray<OfflineMigrationFact> Facts(params (string Name, string Value)[] facts)
        => facts.OrderBy(static fact => fact.Name, StringComparer.Ordinal).Select(static fact => new OfflineMigrationFact(fact.Name, fact.Value)).ToImmutableArray();

    private static async Task<string> HashOriginalAssemblyAsync(string path, CancellationToken cancellationToken)
    {
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, cancellationToken);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
        await using var stream = new FileStream(handle, FileAccess.Read, 4096);
        string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false));
        OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(path, handle, initial, cancellationToken);
        return digest;
    }
}

internal sealed class OwnedCurrentSchemaBootstrapRegistry(PgCurrentSchemaBootstrapOperation operation) : IOfflineMigrationApplyOperationRegistry
{
    public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
    {
        operation.RequireStep(step, identity);
        return operation;
    }
}
