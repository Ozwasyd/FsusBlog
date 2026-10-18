using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaOwnedTargetObserverTests
{
    [Fact]
    public void CompleteRawExpressions_NormalizeOriginalCastAndBoundCheckDependencies()
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation effects = Effects("'1'::bigint", "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, effects));
    }

    [Theory]
    [InlineData("default")]
    [InlineData("check")]
    public void SameCountRawExpressionDrift_IsNotHiddenByTheOldDecodedSnapshot(string mutation)
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation original = Effects("'1'::bigint", "revision BETWEEN 1 AND 10", ["revision"]);
        PgCurrentSchemaEffectObservation changed = Effects(mutation == "default" ? "'2'::bigint" : "'1'::bigint",
            mutation == "check" ? "revision BETWEEN 1 AND 11" : "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, original));
        Assert.Equal(original.Expressions.Count, changed.Expressions.Count);
        // Deliberately retain the same old decoded snapshot in both calls: the
        // production predicate must read the complete raw observations instead.
        Assert.NotEmpty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, changed));
    }

    [Fact]
    public void MissingRawAndChangedDependencies_RefuseInsteadOfDroppingDefaultOrCheckFacts()
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation original = Effects("1", "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            original with
            {
                Expressions = original.Expressions.Where(static value => value.Kind != "default").ToArray()
            }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            Effects("1", "revision BETWEEN 1 AND 10", [])));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            original with
            {
                StandardConformingStrings = false
            }));
    }

    [Fact]
    public void OwnedSequenceDefault_MustUseTheActualCompleteDependencyAndUnmodifiedNextval()
    {
        var sequence = new SchemaOwnedSequenceModel("public", "probe_revision_seq", "probe", "revision", "bigint", 1, 1, 1, long.MaxValue, 1, false);
        SchemaColumnModel column = new("revision", false, false, true, null, "int64", Conversion: "none", PhysicalType: "bigint",
            GenerationKind: "owned-sequence-default", OwnedSequence: sequence);
        var table = new SchemaTableModel("probe", new Dictionary<string, SchemaColumnModel> { [column.Name] = column }, []);
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [table.Name] = table }, provider: SchemaProviderKind.PostgreSql);
        var expected = new CurrentSchemaCompletePhysicalProjection(snapshot, [], []);
        PgCurrentSchemaEffectObservation original = new(true,
            [new("default", "probe", "revision", "nextval('public.probe_revision_seq'::regclass)", [], ["public.probe_revision_seq"])], [], [], []);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot, original));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot,
            original with
            {
                Expressions = [original.Expressions[0] with { SequenceReferences = ["foreign.probe_revision_seq"] }]
            }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot,
            original with
            {
                Expressions = [original.Expressions[0] with { Expression = "nextval('public.probe_revision_seq'::regclass) + 1" }]
            }));
    }

    [Theory]
    [InlineData("missing-column")]
    [InlineData("extra-column")]
    [InlineData("type")]
    [InlineData("length")]
    [InlineData("nullable")]
    [InlineData("primary-key")]
    [InlineData("identity")]
    [InlineData("owned-sequence")]
    [InlineData("collation")]
    [InlineData("default")]
    [InlineData("default-null")]
    [InlineData("computed")]
    [InlineData("index-direction")]
    [InlineData("primary-index-direction")]
    [InlineData("index-opclass")]
    [InlineData("index-collation")]
    [InlineData("index-include")]
    [InlineData("index-null-distinct")]
    [InlineData("missing-constraint")]
    [InlineData("missing-constraint-same-index")]
    [InlineData("constraint-deferred")]
    [InlineData("constraint-unvalidated")]
    [InlineData("check")]
    [InlineData("trigger")]
    public void CurrentControlShape_RejectsNativeFactDriftAfterCompletePositiveControl(string drift)
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control);
        var actual = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [control.Name] = control },
            provider: SchemaProviderKind.PostgreSql);
        Assert.Empty(PgCurrentSchemaControlShape.CompareApplyJournal(actual, effects));
        Assert.Equal(7, control.Columns.Count);
        Assert.Equal(4, control.Constraints.Count);
        Assert.Equal(3, control.IndexDefinitions.Count); // Includes the native primary backing index.

        var columns = new Dictionary<string, SchemaColumnModel>(control.Columns, StringComparer.Ordinal);
        var indexes = new Dictionary<string, SchemaIndexModel>(control.IndexDefinitions, StringComparer.Ordinal);
        var constraints = new Dictionary<string, SchemaConstraintModel>(control.Constraints, StringComparer.Ordinal);
        SchemaColumnModel payload = columns["entry_payload"];
        SchemaIndexModel index = indexes[control.Name + "_entry_digest_key"];
        SchemaConstraintModel check = constraints[control.Name + "_sequence_check"];
        switch (drift)
        {
            case "missing-column":
                columns.Remove("entry_payload");
                break;
            case "extra-column":
                columns.Add("unexpected", payload with
                {
                    Name = "unexpected"
                });
                break;
            case "type":
                columns["entry_payload"] = payload with
                {
                    DataType = "int64",
                    PhysicalType = "bigint"
                };
                break;
            case "length":
                columns["plan_digest"] = columns["plan_digest"] with
                {
                    MaxLength = 65
                };
                break;
            case "nullable":
                columns["entry_payload"] = payload with
                {
                    IsNullable = true
                };
                break;
            case "primary-key":
                columns["sequence"] = columns["sequence"] with
                {
                    IsPrimaryKey = false
                };
                break;
            case "identity":
                columns["sequence"] = columns["sequence"] with
                {
                    IsIdentity = true,
                    GenerationKind = "identity-always"
                };
                break;
            case "owned-sequence":
                columns["sequence"] = columns["sequence"] with
                {
                    OwnedSequence = new("public", "extra_sequence", control.Name, "sequence", "bigint", 1, 1, 1, long.MaxValue, 1, false)
                };
                break;
            case "collation":
                columns["entry_payload"] = payload with
                {
                    Collation = "pg_catalog.C"
                };
                break;
            case "default":
                effects = effects with
                {
                    Expressions = [.. effects.Expressions, new("default", control.Name, "entry_payload", "'changed'::text", [], [])]
                };
                break;
            case "default-null":
                effects = effects with
                {
                    Expressions = [.. effects.Expressions, new("default", control.Name, "entry_payload", "NULL::text", [], [])]
                };
                break;
            case "computed":
                columns["entry_payload"] = payload with
                {
                    ComputedExpression = "'changed'"
                };
                break;
            case "index-direction":
                indexes[index.Name] = index with
                {
                    Keys = [index.Keys[0] with { Direction = "desc" }]
                };
                break;
            case "primary-index-direction":
                SchemaIndexModel primary = indexes[control.Name + "_pkey"];
                indexes[primary.Name] = primary with
                {
                    Keys = primary.Keys.Select((key, position) =>
                    position == 0 ? key with
                    {
                        Direction = "desc"
                    } : key).ToArray()
                };
                break;
            case "index-opclass":
                indexes[index.Name] = index with
                {
                    Keys = [index.Keys[0] with { OperatorClass = "pg_catalog.text_pattern_ops" }]
                };
                break;
            case "index-collation":
                indexes[index.Name] = index with
                {
                    Keys = [index.Keys[0] with { Collation = "pg_catalog.C" }]
                };
                break;
            case "index-include":
                indexes[index.Name] = index with
                {
                    IncludedColumns = ["parent_digest"]
                };
                break;
            case "index-null-distinct":
                indexes[index.Name] = index with
                {
                    NullsNotDistinct = true
                };
                break;
            case "missing-constraint":
                constraints.Remove(check.Name);
                effects = effects with
                {
                    Expressions = []
                };
                break;
            case "missing-constraint-same-index":
                constraints.Remove(index.Name);
                break;
            case "constraint-deferred":
                constraints[index.Name] = constraints[index.Name] with
                {
                    IsDeferrable = true
                };
                break;
            case "constraint-unvalidated":
                constraints[check.Name] = check with
                {
                    IsValidated = false
                };
                break;
            case "check":
                effects = effects with
                {
                    Expressions = [effects.Expressions[0] with { Expression = "sequence >= 0" }]
                };
                break;
            case "trigger":
                effects = effects with
                {
                    Triggers = [new(control.Name, "unexpected", "unexpected", 27, "O", null, 0, "", false, false, false, null, null)]
                };
                break;
            default:
                throw new InvalidOperationException("Unknown native control drift.");
        }
        var changed = new SchemaTableModel(control.Name, columns, indexes.Keys, indexes, constraints, control.Owner);
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [changed.Name] = changed },
            provider: SchemaProviderKind.PostgreSql);
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(snapshot, effects));
    }

    [Theory]
    [InlineData("missing-control")]
    [InlineData("missing-constraint-same-index")]
    [InlineData("missing-sequence")]
    [InlineData("sequence-cache")]
    public void CompleteControlAndIndependentSequence_RejectEitherNativeDomainDriftAfterCombinedPositive(string drift)
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        var tables = new Dictionary<string, SchemaTableModel> { [control.Name] = control };
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>(tables),
            provider: SchemaProviderKind.PostgreSql);
        var operation = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateSequence, "probe_seq",
            Sequence: CurrentSchemaIndependentSequenceFacts.PostgreSqlBigIntDefaults);
        var expected = new CurrentSchemaCompletePhysicalProjection(snapshot, [operation], [])
        {
            IndependentSequences = [CurrentSchemaCanonicalAuthority.ProjectIndependentSequence(operation, SchemaProviderKind.PostgreSql)]
        };
        PgCurrentSequence sequence = new(operation.Name, "bigint", 1, 1, 1, long.MaxValue, 1, false);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control) with
        {
            Sequences = [sequence]
        };
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot, effects));
        switch (drift)
        {
            case "missing-control":
                tables.Clear();
                effects = effects with
                {
                    Expressions = []
                };
                break;
            case "missing-constraint-same-index":
                var constraints = new Dictionary<string, SchemaConstraintModel>(control.Constraints);
                constraints.Remove(control.Name + "_entry_digest_key");
                tables[control.Name] = new(control.Name, control.Columns, control.Indexes,
                    control.IndexDefinitions, constraints, control.Owner);
                break;
            case "missing-sequence":
                effects = effects with
                {
                    Sequences = []
                };
                break;
            case "sequence-cache":
                effects = effects with
                {
                    Sequences = [sequence with { Cache = 2 }]
                };
                break;
            default:
                throw new InvalidOperationException("Unknown combined native drift.");
        }
        var changed = new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);
        Assert.NotEmpty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, changed, effects));
    }

    [Fact]
    public void CurrentControlShape_MissingOrUnknownTablesAndUnsupportedProviderRefuse()
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control);
        Assert.Empty(PgCurrentSchemaControlShape.CompareApplyJournal(
            new(new Dictionary<string, SchemaTableModel> { [control.Name] = control }, provider: SchemaProviderKind.PostgreSql), effects));
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(
            new(new Dictionary<string, SchemaTableModel>(), provider: SchemaProviderKind.PostgreSql), effects with
            {
                Expressions = []
            }));
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(new(new Dictionary<string, SchemaTableModel>
        {
            [control.Name] = control,
            ["__fsus_schema_unregistered_control"] = new("__fsus_schema_unregistered_control", [], [])
        }, provider: SchemaProviderKind.PostgreSql), effects));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.MySql));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.Sqlite));
    }

    [Fact]
    public void CurrentControlRendering_IsDerivedFromFreshSoleFactsAndKeepsOriginalConstraintNames()
    {
        SchemaTableModel first = CurrentSchemaControlShape.DescribeApplyJournal();
        first.Columns.Clear();
        Assert.Equal(7, CurrentSchemaControlShape.DescribeApplyJournal().Columns.Count);
        string sql = PgCurrentSchemaControlShape.CreateApplyJournalSql();
        Assert.Contains("CREATE TABLE IF NOT EXISTS public.\"__fsus_schema_offline_apply_journal\"", sql);
        Assert.Contains("\"__fsus_schema_offline_apply_j_plan_digest_database_digest_i_key\"", sql);
        Assert.Contains("CHECK (sequence > 0)", sql);
        Assert.DoesNotContain("DEFAULT", sql);
        Assert.DoesNotContain("DROP", sql);
        Assert.DoesNotContain("DELETE", sql);
    }

    private static PgCurrentSchemaEffectObservation ControlEffects(SchemaTableModel table)
        => new(true, [new("check", table.Name, table.Name + "_sequence_check", "(sequence > 0)", ["sequence"], [])], [], [], []);

    private static CurrentSchemaCompletePhysicalProjection Expected()
    {
        SchemaColumnModel column = new("revision", false, false, false, null, "int64", "1", "none", PhysicalType: "bigint");
        var check = new SchemaConstraintModel("bounded_revision", "check", [], Expression: "revision >= 1 AND revision <= 10");
        var table = new SchemaTableModel("probe", new Dictionary<string, SchemaColumnModel> { [column.Name] = column }, [],
            constraints: new Dictionary<string, SchemaConstraintModel> { [check.Name] = check });
        return new(new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [table.Name] = table }, provider: SchemaProviderKind.PostgreSql), [], []);
    }

    private static PgCurrentSchemaEffectObservation Effects(string value, string check, string[] columns)
        => new(true, [new("default", "probe", "revision", value, [], []), new("check", "probe", "bounded_revision", check, columns, [])], [], [], []);
}
