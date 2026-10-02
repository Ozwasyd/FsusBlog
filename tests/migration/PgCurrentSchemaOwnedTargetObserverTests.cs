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
            original with { Expressions = original.Expressions.Where(static value => value.Kind != "default").ToArray() }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            Effects("1", "revision BETWEEN 1 AND 10", [])));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            original with { StandardConformingStrings = false }));
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
            original with { Expressions = [original.Expressions[0] with { SequenceReferences = ["foreign.probe_revision_seq"] }] }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot,
            original with { Expressions = [original.Expressions[0] with { Expression = "nextval('public.probe_revision_seq'::regclass) + 1" }] }));
    }

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
