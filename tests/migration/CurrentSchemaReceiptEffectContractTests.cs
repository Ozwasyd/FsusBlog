using System.Text.Json;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaReceiptEffectContractTests
{
    [Fact]
    public void LegacyGuardSerialization_PreservesFrozenOriginalBytes()
    {
        // Captured from the actual frozen030514157 Shared assembly before this extension.
        const string Original = """
        {"Kind":2,"Name":"old_guard","Table":null,"Index":null,"Column":null,"Constraint":null,"ErrorCode":"immutable_row","Function":null,"Columns":null,"Values":null,"ConflictColumn":null,"Sequence":null}
        """;
        var operation = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.DefineImmutableGuard,
            "old_guard", ErrorCode: "immutable_row");
        Assert.Equal(Original, JsonSerializer.Serialize(operation));
    }

    [Fact]
    public void StatementGuardFacts_RoundTripWithoutInventingLegacyDefaults()
    {
        var operation = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateImmutableTrigger,
            "receipt_guard", "receipt", Function: "immutable_guard", Trigger: Statement());
        Assert.Equal(operation, JsonSerializer.Deserialize<CurrentSchemaRecipeOperation>(JsonSerializer.Serialize(operation)));
        Assert.Equal(Statement(), CurrentSchemaImmutableEffects.RequireTrigger(operation.Trigger));
        Assert.Equal(CurrentSchemaTriggerLevel.Row, CurrentSchemaImmutableEffects.RequireTrigger(null).Level);
    }

    [Theory]
    [InlineData(CurrentSchemaTriggerLevel.Row, CurrentSchemaTriggerEvents.Truncate)]
    [InlineData(CurrentSchemaTriggerLevel.Statement, CurrentSchemaTriggerEvents.Update)]
    [InlineData(CurrentSchemaTriggerLevel.Statement, CurrentSchemaTriggerEvents.None)]
    public void UnsupportedInvocationShape_RefusesInsteadOfDroppingFacts(CurrentSchemaTriggerLevel level, CurrentSchemaTriggerEvents events)
        => Assert.Throws<InvalidOperationException>(() => CurrentSchemaImmutableEffects.RequireTrigger(new(level, events)));

    [Fact]
    public void CompleteStatementGuard_IsComparedWithActualSqlStateAndInvocationShape()
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation actual = Actual();
        Assert.Empty(PgCurrentSchemaEffectObserver.CompareEffects(expected, actual));
        Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(expected, actual with
        {
            Functions = [actual.Functions[0] with { Body = "BEGIN RAISE EXCEPTION 'receipt_immutable'; END;" }]
        }));
        foreach (int type in new[] { 27, 26 })
            Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(expected, actual with
            {
                Triggers = [actual.Triggers[0] with { Type = type }]
            }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaEffectObserver.CompareEffects(expected, actual with
        {
            Functions = [actual.Functions[0] with { Body = "BEGIN PERFORM 1; RAISE EXCEPTION 'receipt_immutable' USING ERRCODE = '55000'; END;" }]
        }));
    }

    [Fact]
    public void IntegerArrayConstraints_PreserveQuantifierAndBoundColumn()
    {
        var columns = new Dictionary<string, SchemaColumnModel>
        {
            ["article_ids"] = new("article_ids", false, false, false, null, "int32-array")
        };
        SchemaExpressionNode Parse(string text) => PgCurrentSchemaExpressionParser.Parse(text, columns);
        Assert.True(SchemaExpressionIdentity.Equal(Parse("0 < ALL(article_ids)"), Parse("(0 < ALL (article_ids))")));
        Assert.False(SchemaExpressionIdentity.Equal(Parse("0 < ALL(article_ids)"), Parse("1 < ALL(article_ids)")));
        Assert.Throws<InvalidOperationException>(() => Parse("0 < ANY(article_ids)"));
        Assert.Equal("int32-array", SchemaPhysicalTypeProjection.NormalizeDeclaredSemantic("integer[]"));
        Assert.Throws<InvalidOperationException>(() => SchemaPhysicalTypeProjection.ToPhysical(SchemaProviderKind.MySql, "int32-array", null));
    }

    private static CurrentSchemaImmutableTriggerFacts Statement()
        => new(CurrentSchemaTriggerLevel.Statement, CurrentSchemaTriggerEvents.Update | CurrentSchemaTriggerEvents.Delete | CurrentSchemaTriggerEvents.Truncate);

    private static CurrentSchemaCompletePhysicalProjection Expected()
        => new(new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>(), provider: SchemaProviderKind.PostgreSql),
        [
            new(CurrentSchemaRecipeOperationKind.DefineImmutableGuard, "immutable_guard", ErrorCode: "receipt_immutable", SqlState: "55000"),
            new(CurrentSchemaRecipeOperationKind.CreateImmutableTrigger, "receipt_guard", "receipt", Function: "immutable_guard", Trigger: Statement())
        ], []);

    private static PgCurrentSchemaEffectObservation Actual()
        => new(true, [], [],
            [new("immutable_guard", "plpgsql", "trigger", 0, "BEGIN RAISE EXCEPTION 'receipt_immutable' USING ERRCODE = '55000'; END;", "v", false, false, "u", false, null)],
            [new("receipt", "receipt_guard", "immutable_guard", 58, "O", null, 0, "", false, false, false, null, null)]);
}
