using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaEffectObserverTests
{
    private static readonly CurrentSchemaCompletePhysicalProjection s_expected = new(
        new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>(), provider: SchemaProviderKind.PostgreSql),
        [
            new(CurrentSchemaRecipeOperationKind.CreateSequence, "revision_seq"),
            new(CurrentSchemaRecipeOperationKind.DefineImmutableGuard, "immutable_guard", ErrorCode: "immutable_row"),
            new(CurrentSchemaRecipeOperationKind.RemoveTrigger, "old_guard", "ledger"),
            new(CurrentSchemaRecipeOperationKind.CreateImmutableTrigger, "ledger_guard", "ledger", Function: "immutable_guard")
        ], []);

    private static PgCurrentSchemaEffectObservation Original() => new(true, [],
        [new("revision_seq", "bigint", 1, 1, 1, long.MaxValue, 1, false)],
        [new("immutable_guard", "plpgsql", "trigger", 0, " BEGIN\n RAISE EXCEPTION 'immutable_row';\n END; ", "v", false, false, "u", false, null)],
        [new("ledger", "ledger_guard", "immutable_guard", 27, "O", null, 0, "", false, false, false, null, null)]);

    [Fact]
    public void OriginalOrderedEffects_AreFoldedWithoutRequiringTheRemovedTrigger()
    {
        Assert.Empty(PgCurrentSchemaEffectObserver.CompareEffects(s_expected, Original()));
    }

    [Theory]
    [InlineData("increment")]
    [InlineData("cycle")]
    [InlineData("function-code")]
    [InlineData("security-definer")]
    [InlineData("set-returning")]
    [InlineData("disabled-trigger")]
    [InlineData("column-trigger")]
    [InlineData("clone-trigger")]
    [InlineData("argument-trigger")]
    public void SameCountEffectMutation_IsNotEquivalent(string mutation)
    {
        PgCurrentSchemaEffectObservation original = Original();
        PgCurrentSchemaEffectObservation changed = mutation switch
        {
            "increment" => original with { Sequences = [original.Sequences[0] with { Increment = 2 }] },
            "cycle" => original with { Sequences = [original.Sequences[0] with { Cyclic = true }] },
            "function-code" => original with { Functions = [original.Functions[0] with { Body = "BEGIN RAISE EXCEPTION 'different_code'; END;" }] },
            "security-definer" => original with { Functions = [original.Functions[0] with { SecurityDefiner = true }] },
            "set-returning" => original with { Functions = [original.Functions[0] with { ReturnsSet = true }] },
            "disabled-trigger" => original with { Triggers = [original.Triggers[0] with { Enabled = "D" }] },
            "column-trigger" => original with { Triggers = [original.Triggers[0] with { ColumnNumbers = "1" }] },
            "clone-trigger" => original with { Triggers = [original.Triggers[0] with { IsClone = true }] },
            "argument-trigger" => original with { Triggers = [original.Triggers[0] with { ArgumentCount = 1, ArgumentsHex = "6100" }] },
            _ => throw new InvalidOperationException()
        };
        Assert.Equal(original.Sequences.Count, changed.Sequences.Count);
        Assert.Equal(original.Functions.Count, changed.Functions.Count);
        Assert.Equal(original.Triggers.Count, changed.Triggers.Count);
        Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(s_expected, changed));
    }

    [Fact]
    public void ExtraMissingAndDuplicateEffects_AreNotAClosedOwnedProjection()
    {
        PgCurrentSchemaEffectObservation original = Original();
        Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(s_expected, original with
        {
            Sequences = []
        }));
        Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(s_expected, original with
        {
            Functions = [.. original.Functions, original.Functions[0]]
        }));
        Assert.NotEmpty(PgCurrentSchemaEffectObserver.CompareEffects(s_expected, original with
        {
            Triggers = [.. original.Triggers, original.Triggers[0] with { Name = "foreign_guard" }]
        }));
    }

    [Fact]
    public void GuardBody_UnknownStatementsAreNotSilentlyIgnored()
    {
        Assert.Equal("immutable_row", PgCurrentSchemaEffectObserver.ParseGuard("BEGIN RAISE EXCEPTION 'immutable_row'; END;"));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaEffectObserver.ParseGuard("BEGIN PERFORM 1; RAISE EXCEPTION 'immutable_row'; END;"));
    }
}
