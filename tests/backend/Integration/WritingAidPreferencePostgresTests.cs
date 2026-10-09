using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class WritingAidPreferencePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string DeviceA = "device:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DeviceB = "device:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly WritingAidPreferenceOwner s_owner = new("account:42", "site:test");

    [Fact]
    public async Task BoundedJournal_RefusesOverflowPreservesAllReplayIdentitiesAndDoesNotBlockAnotherOwner()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var first = new WritingAidPreferenceUpdate(0, Guid.NewGuid(), new(1, true, false, false));
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, first)).Success);
        for (long revision = 1; revision < 256; revision++)
        {
            Assert.Equal(WritingAidPreferenceOutcome.Success,
                (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
                    new(revision, Guid.NewGuid(), new(1, revision % 2 == 0, false, false)))).Outcome);
        }
        WritingAidPreferenceResult overflow = await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
            new(256, Guid.NewGuid(), WritingAidPreferenceContract.Defaults));
        Assert.Equal(WritingAidPreferenceOutcome.Unavailable, overflow.Outcome);
        Assert.Null(overflow.Receipt);
        Assert.Equal(256, await CountAsync(db, "user_authoring_preference_operation"));
        Assert.Equal(256, (await Service(db).GetWritingAidPreferenceAsync(s_owner)).Snapshot!.Revision);
        Assert.Equal(WritingAidPreferenceOutcome.Replayed,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, first)).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.IdempotencyConflict,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, first with
            {
                Values = WritingAidPreferenceContract.Defaults
            })).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.Success,
            (await Service(db).InitializeWritingAidPreferenceAsync(s_owner with { UserScope = "account:43" }, DeviceA, Guid.NewGuid())).Outcome);
    }

    [Fact]
    public async Task Initialization_IsOneTimeScopedIdempotentAndNeverOverwritesSubsequentPreferences()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        Guid operation = Guid.NewGuid();
        WritingAidPreferenceResult initial = await Service(db).InitializeWritingAidPreferenceAsync(s_owner, DeviceA, operation);
        Assert.Equal(WritingAidPreferenceOutcome.Success, initial.Outcome);
        Assert.Equal("initialize", initial.Receipt!.Action);
        Assert.Equal(WritingAidPreferenceContract.Defaults, initial.Snapshot!.Values);
        Assert.True(WritingAidPreferenceReceiptValidator.Validate(initial.Receipt, s_owner));
        var values = new WritingAidPreferenceValues(1, true, true, true);
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, new(1, Guid.NewGuid(), values))).Success);
        Assert.Equal(WritingAidPreferenceOutcome.Replayed,
            (await Service(db).InitializeWritingAidPreferenceAsync(s_owner, DeviceA, operation)).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.RevisionConflict,
            (await Service(db).InitializeWritingAidPreferenceAsync(s_owner, DeviceB, Guid.NewGuid())).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.IdempotencyConflict,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
                new(0, operation, WritingAidPreferenceContract.Defaults))).Outcome);
        Assert.Equal(values, (await Service(db).GetWritingAidPreferenceAsync(s_owner)).Snapshot!.Values);
        Assert.Equal(2, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task EveryCombination_PersistsThroughProductionCommandAndReloadsFromAnotherClient()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var writer = Service(db);
        var reader = Service(other);
        WritingAidPreferenceResult missing = await reader.GetWritingAidPreferenceAsync(s_owner);
        Assert.Equal(WritingAidPreferenceContract.Defaults, missing.Snapshot!.Values);
        Assert.Equal(0, missing.Snapshot.Revision);
        for (int mask = 0; mask < 8; mask++)
        {
            var values = new WritingAidPreferenceValues(1, (mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0);
            WritingAidPreferenceResult committed = await writer.UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
                new(mask, Guid.NewGuid(), values));
            Assert.Equal(WritingAidPreferenceOutcome.Success, committed.Outcome);
            Assert.True(WritingAidPreferenceReceiptValidator.Validate(committed.Receipt, s_owner));
            WritingAidPreferenceResult reloaded = await reader.GetWritingAidPreferenceAsync(s_owner);
            Assert.Equal(committed.Snapshot, reloaded.Snapshot);
            await using var connection = new NpgsqlConnection(other.CurrentConnectionConfig.ConnectionString);
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT focus_enabled, typewriter_enabled, immersive_enabled, revision FROM user_authoring_preference;";
            await using NpgsqlDataReader observed = await command.ExecuteReaderAsync();
            Assert.True(await observed.ReadAsync());
            Assert.Equal(values.FocusEnabled, observed.GetBoolean(0));
            Assert.Equal(values.TypewriterEnabled, observed.GetBoolean(1));
            Assert.Equal(values.ImmersiveEnabled, observed.GetBoolean(2));
            Assert.Equal(mask + 1L, observed.GetInt64(3));
            Assert.False(await observed.ReadAsync());
        }
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(8, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentDevices_CompareTheSameRevisionAndCommitOnlyOneMutation(bool existing)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        long revision = 0;
        if (existing)
        {
            Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
                new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Success);
            revision = 1;
        }
        Task<WritingAidPreferenceResult>[] writes =
        [
            Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, new(revision, Guid.NewGuid(), new(1, true, false, false))),
            Service(other).UpdateWritingAidPreferenceAsync(s_owner, DeviceB, new(revision, Guid.NewGuid(), new(1, false, true, false)))
        ];
        WritingAidPreferenceResult[] results = await Task.WhenAll(writes);
        Assert.Single(results, result => result.Outcome == WritingAidPreferenceOutcome.Success);
        Assert.Single(results, result => result.Outcome == WritingAidPreferenceOutcome.RevisionConflict);
        Assert.Equal(revision + 1, (await Service(other).GetWritingAidPreferenceAsync(s_owner)).Snapshot!.Revision);
        Assert.Equal(revision + 1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task ConcurrentRetry_ReplaysItsOriginalReceiptAfterLaterUpdatesAndRejectsPayloadOrDeviceReuse()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var request = new WritingAidPreferenceUpdate(0, Guid.NewGuid(), new(1, true, false, true));
        WritingAidPreferenceResult[] results = await Task.WhenAll(
            Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request),
            Service(other).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request));
        Assert.Single(results, result => result.Outcome == WritingAidPreferenceOutcome.Success);
        Assert.Single(results, result => result.Outcome == WritingAidPreferenceOutcome.Replayed);
        Assert.Equal(results[0].Receipt, results[1].Receipt);
        Assert.Equal(WritingAidPreferenceOutcome.Success, (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceB,
            new(1, Guid.NewGuid(), new(1, false, true, false)))).Outcome);
        WritingAidPreferenceResult retry = await Service(other).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request);
        Assert.Equal(WritingAidPreferenceOutcome.Replayed, retry.Outcome);
        Assert.Equal(1, retry.Snapshot!.Revision);
        Assert.Equal(2, (await Service(other).GetWritingAidPreferenceAsync(s_owner)).Snapshot!.Revision);
        Assert.Equal(WritingAidPreferenceOutcome.IdempotencyConflict,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceB, request)).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.IdempotencyConflict,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request with
            {
                Values = request.Values with { ImmersiveEnabled = false }
            })).Outcome);
        Assert.Equal(2, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task AccountAdminAndSiteCoordinates_DoNotShareValuesOrRequestIdentity()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        WritingAidPreferenceOwner[] owners =
        [s_owner, s_owner with { UserScope = "account:43" }, s_owner with { UserScope = "admin:42" }, s_owner with { SiteScope = "site:other" }];
        Guid operation = Guid.NewGuid();
        for (int index = 0; index < owners.Length; index++)
        {
            var values = new WritingAidPreferenceValues(1, index == 0, index == 1, index == 2);
            Assert.Equal(WritingAidPreferenceOutcome.Success,
                (await Service(db).UpdateWritingAidPreferenceAsync(owners[index], DeviceA, new(0, operation, values))).Outcome);
            Assert.Equal(values, (await Service(db).GetWritingAidPreferenceAsync(owners[index])).Snapshot!.Values);
        }
        Assert.Equal(4, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(4, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task RowOrJournalTamper_RefusesWithoutDefaultFallbackOrAdditionalMutation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var request = new WritingAidPreferenceUpdate(0, Guid.NewGuid(), new(1, true, false, false));
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request)).Success);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference_operation SET receipt = '{invalid}';");
        WritingAidPreferenceResult retry = await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, request);
        Assert.Equal(WritingAidPreferenceOutcome.Corrupt, retry.Outcome);
        Assert.Null(retry.Snapshot);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference SET immersive_enabled = true;");
        Assert.Equal(WritingAidPreferenceOutcome.Corrupt, (await Service(db).GetWritingAidPreferenceAsync(s_owner)).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.Corrupt, (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
            new(1, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Outcome);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task JournalFailure_RollsBackTheProfileAndReturnsNoCommittedReceipt()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync("ALTER TABLE user_authoring_preference_operation ADD CONSTRAINT test_refuse_operation CHECK (domain = 'typography');");
        WritingAidPreferenceResult result = await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA,
            new(0, Guid.NewGuid(), new(1, true, true, true)));
        Assert.Equal(WritingAidPreferenceOutcome.Unavailable, result.Outcome);
        Assert.Null(result.Receipt);
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task InvalidOrCancelledCommands_LeaveTheOwnedDatabaseEmpty()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        Assert.Equal(WritingAidPreferenceOutcome.Invalid, (await Service(db).UpdateWritingAidPreferenceAsync(
            s_owner with { UserScope = "guest:42" }, DeviceA, new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.Invalid, (await Service(db).UpdateWritingAidPreferenceAsync(
            s_owner, "raw-session-secret", new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Outcome);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Service(db).UpdateWritingAidPreferenceAsync(
            s_owner, DeviceA, new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults), cancelled.Token));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task OpaqueTypographyObservation_IsPreservedAndItsSharedRevisionInvalidatesStaleAidCommands()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var values = new WritingAidPreferenceValues(1, true, false, true);
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, new(0, Guid.NewGuid(), values))).Success);
        // Independent seed of the other domain's owned payload is not a typography production command receipt.
        const string Typography = "{\"schemaVersion\":1,\"fontFamily\":\"system-sans\",\"fontSize\":\"standard\",\"lineHeight\":\"standard\",\"canvasWidth\":\"standard\",\"paragraphSpacing\":\"standard\"}";
        string contentDigest = RowDigest(s_owner, 2, values, Typography);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference SET typography_payload = @Typography, revision = 2, content_digest = @Digest;",
            new SugarParameter("@Typography", Typography), new SugarParameter("@Digest", contentDigest));
        Assert.Equal(WritingAidPreferenceOutcome.RevisionConflict,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, new(1, Guid.NewGuid(), values))).Outcome);
        Assert.Equal(WritingAidPreferenceOutcome.Success,
            (await Service(db).UpdateWritingAidPreferenceAsync(s_owner, DeviceA, new(2, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Outcome);
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT typography_payload, revision FROM user_authoring_preference;";
        await using NpgsqlDataReader observed = await command.ExecuteReaderAsync();
        Assert.True(await observed.ReadAsync());
        Assert.Equal(Typography, observed.GetString(0));
        Assert.Equal(3, observed.GetInt64(1));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        string sql = Assert.IsType<RawSqlStep>(Assert.Single(WritingAidPreferenceMigrationDefinitions.BuildMigration().Steps)).Sql;
        await db.Ado.ExecuteCommandAsync(sql);
        await db.Ado.ExecuteCommandAsync(sql);
        return db;
    }

    private static UserLocalePreferenceService Service(SqlSugarClient db)
        => new(db, NullLogger<UserLocalePreferenceService>.Instance, TestTemporalContext.CreateCanonical().BusinessClock);

    private static async Task<long> CountAsync(SqlSugarClient db, string table)
    {
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = table switch
        {
            "user_authoring_preference" => "SELECT count(*) FROM user_authoring_preference;",
            "user_authoring_preference_operation" => "SELECT count(*) FROM user_authoring_preference_operation;",
            _ => throw new ArgumentOutOfRangeException(nameof(table))
        };
        return (long)(await command.ExecuteScalarAsync())!;
    }

    private static string RowDigest(WritingAidPreferenceOwner owner, long revision, WritingAidPreferenceValues values, string typography)
    {
        object[] fields = ["fsusblog.authoring-preference-row.v1", owner.UserScope, owner.SiteScope, revision,
            values.SchemaVersion, values.FocusEnabled, values.TypewriterEnabled, values.ImmersiveEnabled, typography];
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(fields))));
    }
}
