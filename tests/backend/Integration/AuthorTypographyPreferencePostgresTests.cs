using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.AuthorTypography;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorTypographyPreferencePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    // These fixtures exercise persisted device binding, not production device attestation or design-baseline acceptance.
    private const string DeviceA = "device:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DeviceB = "device:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly AuthorTypographyScope s_scope = new(42, "site:test");
    private static readonly AuthorTypographyProfile s_fixtureDefault = new(1, "system-sans", "standard", "standard", "standard", "standard");

    [Fact]
    public async Task MissingDefault_RefusesReadAndResetWithoutCreatingAPreference()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var service = Service(db, withFixturePolicy: false);
        Assert.Equal(AuthorTypographyPreferenceReadOutcome.CurrentDesignDefaultUnavailable,
            (await service.GetTypographyAsync(s_scope)).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.CurrentDesignDefaultUnavailable,
            (await service.UpdateTypographyAsync(s_scope, DeviceA, Request(0, AuthorTypographyMutation.Reset))).Outcome);
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task ClosedManualProfile_PersistsWithoutInventingADefaultAndReloadsFromAnotherClient()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthorTypographyProfile profile = s_fixtureDefault with
        {
            FontFamily = "cjk-sans",
            FontSize = "large",
            CanvasWidth = "wide"
        };
        var request = Request(0, AuthorTypographyMutation.SetProfile, profile);
        AuthorTypographyPreferenceWriteResult committed = await Service(db, false).UpdateTypographyAsync(s_scope, DeviceA, request);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, committed.Outcome);
        Assert.True(AuthorTypographyContractValidator.ValidateRecordedRequest(committed.Record, s_scope));
        AuthorTypographyPreferenceReadResult read = await Service(other, false).GetTypographyAsync(s_scope);
        Assert.Equal(AuthorTypographyPreferenceReadOutcome.Stored, read.Outcome);
        Assert.Equal(committed.Record!.CommittedSnapshot, read.Snapshot);
        Assert.Equal(profile, read.Snapshot!.Profile);
        Assert.Equal(WritingAidPreferenceContract.Defaults,
            (await Service(other).GetWritingAidPreferenceAsync(AidOwner())).Snapshot!.Values);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task SetAndReset_PreserveAidValuesAndShareTheirRevision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var aids = new WritingAidPreferenceValues(1, true, false, true);
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(AidOwner(), DeviceA, new(0, Guid.NewGuid(), aids))).Success);
        AuthorTypographyProfile profile = s_fixtureDefault with
        {
            FontSize = "large",
            ParagraphSpacing = "relaxed"
        };
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.RevisionConflict,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(0, AuthorTypographyMutation.SetProfile, profile))).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(1, AuthorTypographyMutation.SetProfile, profile))).Outcome);
        AuthorTypographyPreferenceWriteResult reset = await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(2, AuthorTypographyMutation.Reset));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, reset.Outcome);
        Assert.Equal(s_fixtureDefault, reset.Record!.CommittedSnapshot.Profile);
        Assert.Null(reset.Record.Request.Command.Profile);
        WritingAidPreferenceResult observed = await Service(db).GetWritingAidPreferenceAsync(AidOwner());
        Assert.Equal(aids, observed.Snapshot!.Values);
        Assert.Equal(3, observed.Snapshot.Revision);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference"));
    }

    [Fact]
    public async Task AidMutation_PreservesTypographyAndInvalidatesStaleTypographyCommands()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyProfile profile = s_fixtureDefault with
        {
            CanvasWidth = "narrow"
        };
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(0, AuthorTypographyMutation.SetProfile, profile))).Outcome);
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(AidOwner(), DeviceA,
            new(1, Guid.NewGuid(), new(1, true, true, false)))).Success);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.RevisionConflict,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(1, AuthorTypographyMutation.Reset))).Outcome);
        AuthorTypographyPreferenceReadResult observed = await Service(db).GetTypographyAsync(s_scope);
        Assert.Equal(profile, observed.Snapshot!.Profile);
        Assert.Equal(2, observed.Snapshot.Revision);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentDevices_CommitOnlyOneSharedRevision(bool existing)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        long revision = 0;
        if (existing)
        {
            Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
                (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault))).Outcome);
            revision = 1;
        }
        AuthorTypographyPreferenceWriteResult[] results = await Task.WhenAll(
            Service(db).UpdateTypographyAsync(s_scope, DeviceA,
                Request(revision, AuthorTypographyMutation.SetProfile, s_fixtureDefault with
                {
                    FontSize = "large"
                })),
            Service(other).UpdateTypographyAsync(s_scope, DeviceB,
                Request(revision, AuthorTypographyMutation.SetProfile, s_fixtureDefault with
                {
                    CanvasWidth = "wide"
                })));
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.Committed);
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.RevisionConflict);
        Assert.Equal(revision + 1, (await Service(other).GetTypographyAsync(s_scope)).Snapshot!.Revision);
        Assert.Equal(revision + 1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task ConcurrentRetry_ReplaysOriginalAfterLaterWritesAndRejectsPayloadOrDeviceReuse()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        AuthorTypographyMutationRequest request = Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault);
        AuthorTypographyPreferenceWriteResult[] results = await Task.WhenAll(
            Service(db).UpdateTypographyAsync(s_scope, DeviceA, request),
            Service(other).UpdateTypographyAsync(s_scope, DeviceA, request));
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.Committed);
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.Replayed);
        Assert.Equal(results[0].Record, results[1].Record);
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(AidOwner(), DeviceB,
            new(1, Guid.NewGuid(), new(1, true, false, false)))).Success);
        AuthorTypographyPreferenceWriteResult replay = await Service(other).UpdateTypographyAsync(s_scope, DeviceA, request);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Replayed, replay.Outcome);
        Assert.Equal(1, replay.Record!.CommittedSnapshot.Revision);
        Assert.Equal(2, (await Service(other).GetTypographyAsync(s_scope)).Snapshot!.Revision);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceB, request)).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, request with
            {
                Command = request.Command with
                {
                    Profile = s_fixtureDefault with
                    {
                        FontSize = "large"
                    }
                }
            })).Outcome);
        Assert.Equal(2, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task ResetRetry_ReplaysEvenWhenCurrentDesignPolicyIsUnavailable()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyMutationRequest request = Request(0, AuthorTypographyMutation.Reset);
        AuthorTypographyPreferenceWriteResult first = await Service(db).UpdateTypographyAsync(s_scope, DeviceA, request);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, first.Outcome);
        AuthorTypographyPreferenceWriteResult replay = await Service(db, false).UpdateTypographyAsync(s_scope, DeviceA, request);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Replayed, replay.Outcome);
        Assert.Equal(first.Record, replay.Record);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task AidInitialization_CannotOverwriteAnExistingTypographyPreference()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyProfile profile = s_fixtureDefault with
        {
            CanvasWidth = "wide"
        };
        AuthorTypographyPreferenceWriteResult committed = await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
            Request(0, AuthorTypographyMutation.SetProfile, profile));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, committed.Outcome);
        WritingAidPreferenceResult initialization = await Service(db).InitializeWritingAidPreferenceAsync(
            AidOwner(), DeviceB, Guid.NewGuid());
        Assert.Equal(WritingAidPreferenceOutcome.RevisionConflict, initialization.Outcome);
        Assert.Equal(committed.Record!.CommittedSnapshot, (await Service(db).GetTypographyAsync(s_scope)).Snapshot);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task SharedJournalCapacity_RetainsTypographyReplayAndRefusesFreshWritesInBothDomains()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyMutationRequest original = Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault);
        AuthorTypographyPreferenceWriteResult committed = await Service(db).UpdateTypographyAsync(s_scope, DeviceA, original);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, committed.Outcome);
        await FillSharedJournalAsync(db, 1, 256);
        AuthorTypographySnapshot current = (await Service(db).GetTypographyAsync(s_scope)).Snapshot!;
        Assert.Equal(256, current.Revision);
        Assert.Equal(256, await CountAsync(db, "user_authoring_preference_operation"));
        AuthorTypographyPreferenceWriteResult replay = await Service(db, false).UpdateTypographyAsync(s_scope, DeviceA, original);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Replayed, replay.Outcome);
        Assert.Equal(committed.Record, replay.Record);
        AuthorTypographyPreferenceWriteResult refused = await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
            Request(256, AuthorTypographyMutation.Reset));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Unavailable, refused.Outcome);
        Assert.Null(refused.Record);
        Assert.Equal(WritingAidPreferenceOutcome.Unavailable,
            (await Service(db).UpdateWritingAidPreferenceAsync(AidOwner(), DeviceB,
                new(256, Guid.NewGuid(), WritingAidPreferenceContract.Defaults))).Outcome);
        Assert.Equal(current, (await Service(db).GetTypographyAsync(s_scope)).Snapshot);
        Assert.Equal(256, await CountAsync(db, "user_authoring_preference_operation"));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
            (await Service(db).UpdateTypographyAsync(s_scope with
            {
                SiteIdentity = "site:other"
            }, DeviceA,
                Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault))).Outcome);
        Assert.Equal(257, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task SharedJournalFinalSlot_AdmitsOneConcurrentTypographyRequestAndPreservesItsReplay()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await FillSharedJournalAsync(db, 0, 255);
        AuthorTypographyMutationRequest[] requests =
        [
            Request(255, AuthorTypographyMutation.SetProfile, s_fixtureDefault with { FontSize = "large" }),
            Request(255, AuthorTypographyMutation.SetProfile, s_fixtureDefault with { CanvasWidth = "wide" })
        ];
        AuthorTypographyPreferenceWriteResult[] results = await Task.WhenAll(
            Service(db).UpdateTypographyAsync(s_scope, DeviceA, requests[0]),
            Service(other).UpdateTypographyAsync(s_scope, DeviceB, requests[1]));
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.Committed);
        Assert.Single(results, result => result.Outcome == AuthorTypographyPreferenceWriteOutcome.RevisionConflict);
        int winner = results[0].Outcome == AuthorTypographyPreferenceWriteOutcome.Committed ? 0 : 1;
        AuthorTypographyPreferenceWriteResult replay = await Service(other, false).UpdateTypographyAsync(s_scope,
            winner == 0 ? DeviceA : DeviceB, requests[winner]);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Replayed, replay.Outcome);
        Assert.Equal(results[winner].Record, replay.Record);
        Assert.Equal(results[winner].Record!.CommittedSnapshot, (await Service(db).GetTypographyAsync(s_scope)).Snapshot);
        Assert.Equal(256, await CountAsync(db, "user_authoring_preference_operation"));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Unavailable,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
                Request(256, AuthorTypographyMutation.SetProfile, s_fixtureDefault))).Outcome);
        Assert.Equal(256, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task BothDomains_RejectTheSameOperationIdWithAnotherDomain()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        Guid identity = Guid.NewGuid();
        Assert.True((await Service(db).UpdateWritingAidPreferenceAsync(AidOwner(), DeviceA,
            new(0, identity, WritingAidPreferenceContract.Defaults))).Success);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
                new(identity, new(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault)))).Outcome);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task AccountAndSiteScope_IsolateValuesAndRequestIds()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyScope[] scopes = [s_scope, s_scope with { AccountId = 43 }, s_scope with { SiteIdentity = "site:other" }];
        Guid identity = Guid.NewGuid();
        foreach (AuthorTypographyScope scope in scopes)
        {
            var profile = s_fixtureDefault with
            {
                FontSize = scope.AccountId == 43 ? "large" : "compact"
            };
            AuthorTypographyPreferenceWriteResult result = await Service(db).UpdateTypographyAsync(scope, DeviceA,
                new(identity, new(0, AuthorTypographyMutation.SetProfile, profile)));
            Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed, result.Outcome);
            Assert.Equal(profile, (await Service(db).GetTypographyAsync(scope)).Snapshot!.Profile);
        }
        Assert.Equal(3, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(3, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task InvalidProfileScopeOrDevice_RefusesWithoutAWrite()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var valid = Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Forbidden,
            (await Service(db).UpdateTypographyAsync(s_scope with
            {
                AccountId = 0
            }, DeviceA, valid)).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.InvalidRequest,
            (await Service(db).UpdateTypographyAsync(s_scope, "account:42", valid)).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.InvalidRequest,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
                Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault with
                {
                    FontFamily = "https://font.example.test/asset.woff2"
                }))).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.InvalidRequest,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(0, AuthorTypographyMutation.Reset, s_fixtureDefault))).Outcome);
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task JournalFailure_RollsBackPreferenceAndReturnsNoRecord()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync("ALTER TABLE user_authoring_preference_operation ADD CONSTRAINT test_refuse_typography CHECK (domain = 'writing-aids');");
        AuthorTypographyPreferenceWriteResult result = await Service(db).UpdateTypographyAsync(s_scope, DeviceA,
            Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault));
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Unavailable, result.Outcome);
        Assert.Null(result.Record);
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference"));
        Assert.Equal(0, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task JournalOrRowTamper_RefusesWithoutAdditionalMutation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyMutationRequest request = Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, request)).Outcome);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference_operation SET receipt = '{invalid}';");
        AuthorTypographyPreferenceWriteResult retry = await Service(db).UpdateTypographyAsync(s_scope, DeviceA, request);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Unavailable, retry.Outcome);
        Assert.Null(retry.Record);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference SET focus_enabled = true;");
        Assert.Equal(AuthorTypographyPreferenceReadOutcome.Unavailable, (await Service(db).GetTypographyAsync(s_scope)).Outcome);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Unavailable,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, Request(1, AuthorTypographyMutation.SetProfile, s_fixtureDefault))).Outcome);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    [Fact]
    public async Task DeviceColumnTamper_CannotTransferAnOriginalRequestToAnotherDevice()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AuthorTypographyMutationRequest request = Request(0, AuthorTypographyMutation.SetProfile, s_fixtureDefault);
        Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
            (await Service(db).UpdateTypographyAsync(s_scope, DeviceA, request)).Outcome);
        await db.Ado.ExecuteCommandAsync("UPDATE user_authoring_preference_operation SET device_scope = @Device;",
            new SugarParameter("@Device", DeviceB));
        AuthorTypographyPreferenceWriteResult result = await Service(db).UpdateTypographyAsync(s_scope, DeviceB, request);
        Assert.True(result.Outcome is AuthorTypographyPreferenceWriteOutcome.RequestIdentityConflict
            or AuthorTypographyPreferenceWriteOutcome.Unavailable, $"Tampered device binding returned {result.Outcome}.");
        Assert.Null(result.Record);
        Assert.Equal(1, await CountAsync(db, "user_authoring_preference_operation"));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        string sql = Assert.IsType<RawSqlStep>(Assert.Single(WritingAidPreferenceMigrationDefinitions.BuildMigration().Steps)).Sql;
        await db.Ado.ExecuteCommandAsync(sql);
        return db;
    }

    private static async Task FillSharedJournalAsync(SqlSugarClient db, long firstRevision, long finalRevision)
    {
        var service = Service(db);
        for (long revision = firstRevision; revision < finalRevision; revision++)
        {
            if (revision % 2 == 0)
            {
                Assert.Equal(AuthorTypographyPreferenceWriteOutcome.Committed,
                    (await service.UpdateTypographyAsync(s_scope, DeviceA,
                        Request(revision, AuthorTypographyMutation.SetProfile, s_fixtureDefault))).Outcome);
            }
            else
            {
                Assert.True((await service.UpdateWritingAidPreferenceAsync(AidOwner(), DeviceB,
                    new(revision, Guid.NewGuid(), new(1, false, revision % 3 == 0, true)))).Success);
            }
        }
    }

    private static UserLocalePreferenceService Service(SqlSugarClient db, bool withFixturePolicy = true)
    {
        TimeProvider clock = TestTemporalContext.CreateCanonical().BusinessClock;
        return withFixturePolicy
            ? new(db, NullLogger<UserLocalePreferenceService>.Instance, clock, new FixtureDefaultPolicy())
            : new(db, NullLogger<UserLocalePreferenceService>.Instance, clock);
    }

    private static AuthorTypographyMutationRequest Request(long revision, AuthorTypographyMutation mutation, AuthorTypographyProfile? profile = null)
    {
        return new(Guid.NewGuid(), new(revision, mutation, profile));
    }

    private static WritingAidPreferenceOwner AidOwner()
    {
        return new("account:42", "site:test");
    }

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

    // This controlled fixture checks server-policy consumption, not the product's current-design default.
    private sealed class FixtureDefaultPolicy : IAuthorTypographyCurrentDesignDefaultPolicy
    {
        public AuthorTypographyProfile? GetCurrentDesignDefault()
        {
            return s_fixtureDefault;
        }
    }
}
