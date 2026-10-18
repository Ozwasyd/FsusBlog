using System.Collections.Immutable;

using Npgsql;

using Xunit;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration.Tests;

// These control the production proof validator/locator only. None manufactures
// a native capability, a committed journal, a producer, or successful recovery.
public sealed class PgLegacyNonArticleRecoveryTests
{
    [Fact]
    public void CompleteReorderedProofsRetainTheExactOriginalRoster()
    {
        var programs = Programs();
        PgLegacyNonArticleRecoveryData data = Data(programs);
        PgLegacyNonArticlePreparation.RequireCompleteRecoveryData(data with
        {
            Tables = data.Tables.Reverse().ToImmutableArray()
        }, programs);
    }

    [Theory]
    [InlineData("old-format")]
    [InlineData("missing-tables")]
    [InlineData("duplicate-same-count")]
    [InlineData("different-physical-table")]
    [InlineData("different-field-layout")]
    [InlineData("negative-rows")]
    [InlineData("invalid-data-digest")]
    [InlineData("missing-native-schema")]
    [InlineData("outside-native-schema")]
    [InlineData("missing-run")]
    [InlineData("rewound-sequence")]
    public void OldPartialOrSubstitutedProofCannotConstructRecovery(string change)
    {
        var programs = Programs();
        PgLegacyNonArticleRecoveryData data = Data(programs);
        data = change switch
        {
            "old-format" => data with { Format = "fsusblog.pg-legacy-nonarticle-recovery.v0" },
            "missing-tables" => data with { Tables = data.Tables.RemoveAt(0) },
            "duplicate-same-count" => data with { Tables = data.Tables.SetItem(0, data.Tables[1]) },
            "different-physical-table" => data with { Tables = data.Tables.SetItem(0, data.Tables[0] with { Table = "other" }) },
            "different-field-layout" => data with { Tables = data.Tables.SetItem(0, data.Tables[0] with { ColumnBindingDigest = new string('b', 64) }) },
            "negative-rows" => data with { Tables = data.Tables.SetItem(0, data.Tables[0] with { Rows = -1 }) },
            "invalid-data-digest" => data with { Tables = data.Tables.SetItem(0, data.Tables[0] with { DataDigest = "not-a-digest" }) },
            "missing-native-schema" => data with { IsolatedSchema = null! },
            "outside-native-schema" => data with { IsolatedSchema = "public" },
            "missing-run" => data with { MediaRunId = Guid.Empty },
            "rewound-sequence" => data with { UserMinimumNext = 0 },
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<InvalidOperationException>(() => PgLegacyNonArticlePreparation.RequireCompleteRecoveryData(data, programs));
    }

    [Fact]
    public void MatchingCommittedObservationSelectsOnlyItsExactOriginalLocator()
    {
        OfflineMigrationPredicateObservation observation = Observation();
        Assert.Equal(new CurrentSchemaArtifactReference("/task/recovery.json", new string('a', 64)),
            PgLegacyNonArticlePreparation.ArtifactFromCommittedObservation(observation));
    }

    [Theory]
    [InlineData("missing-reference")]
    [InlineData("duplicate-reference")]
    [InlineData("different-actual")]
    [InlineData("relative-reference")]
    [InlineData("invalid-digest")]
    public void MissingOrEditedJournalFactsDoNotSupplyAnArtifactLocator(string change)
    {
        OfflineMigrationPredicateObservation observation = Observation();
        ImmutableArray<OfflineMigrationFact> facts = observation.ActualFacts;
        facts = change switch
        {
            "missing-reference" => facts.RemoveAt(0),
            "duplicate-reference" => facts.Add(facts[0]),
            "different-actual" => facts.SetItem(0, facts[0] with { Value = "/task/replaced.json" }),
            "relative-reference" => facts.SetItem(0, facts[0] with { Value = "recovery.json" }),
            "invalid-digest" => facts.SetItem(1, facts[1] with { Value = "invalid" }),
            _ => throw new InvalidOperationException()
        };
        observation = observation with
        {
            ActualFacts = facts,
            ExpectedFacts = change == "different-actual" ? observation.ExpectedFacts : facts
        };
        Assert.Throws<InvalidOperationException>(() => PgLegacyNonArticlePreparation.ArtifactFromCommittedObservation(observation));
    }

    [Fact]
    public async Task RestoredCapabilityRequiresActualOriginalNativeTransactionBeforeReadingAnyPayload()
    {
        using var connection = new NpgsqlConnection();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgLegacyNonArticlePreparation.ReadCommittedAsync(null!, null!, null!, null!, null!, null!, null!, null!,
                Guid.Empty, 1, connection, null!, CancellationToken.None));
        Assert.Equal("legacy_target_prepare_original_transaction_required", error.Message);
    }

    private static OfflineMigrationPredicateObservation Observation()
    {
        ImmutableArray<OfflineMigrationFact> facts = [
            new(PgLegacyNonArticlePreparation.RecoveryReferenceFact, "/task/recovery.json"),
            new(PgLegacyNonArticlePreparation.RecoveryDigestFact, new string('a', 64))];
        return new("target", "compiled", new string('a', 64), new string('b', 64), facts, facts, new string('c', 64));
    }

    private static IReadOnlyList<PgLegacyNonArticlePreparation.LegacyTableProgram> Programs()
        => Enumerable.Range(0, 11).Select(index =>
        {
            string owner = "FsusBlog.Server.Entities.Control" + index;
            var table = new SchemaTableModel("actual_table_" + index, new()
            {
                ["actual_id"] = new("actual_id", false, true, false, null, "int32", Owner: new(owner + ".Id", "control"))
            }, [], owner: new(owner, "control"));
            var input = new CurrentSchemaBootstrapInput(new(new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>()),
                new("m", "e", "g", "s", "c")), new("control", "control", "control", "control"), []);
            return PgLegacyNonArticlePreparation.BindTable(table, owner, "SELECT id FROM original",
                new Dictionary<string, string> { ["Id"] = "s.id" }, null, [], false, input);
        }).ToArray();

    private static PgLegacyNonArticleRecoveryData Data(IReadOnlyList<PgLegacyNonArticlePreparation.LegacyTableProgram> programs)
    {
        var source = new OfflineMigrationSourceObservation(new(CurrentSchemaProviderKind.PostgreSql, "instance", "database"),
            "original", "1", [], [], [], new string('a', 64));
        return new(PgLegacyNonArticlePreparation.RecoveryFormat, new("/task/plan.json", new string('a', 64)), new string('b', 64),
            new("/task/source.json", new string('c', 64)), new("/task/current.json", new string('d', 64)), source,
            new("m", "e", "g", new string('a', 64), new string('b', 64)), new string('c', 64),
            new(new string('a', 40), new string('b', 64), new string('c', 64), new string('d', 64)), "invocation",
            Guid.Parse("58a8e6ac-7bd2-4222-a21a-e623cda3af99"), "__fsus_legacy_stage_" + new string('a', 32), 1,
            programs.Select(program => new PgLegacyNonArticleTableProof(program.Owner, program.Table.Name,
                PgLegacyNonArticlePreparation.ColumnBindingDigest(program), 37, new string('a', 64))).ToImmutableArray());
    }
}
