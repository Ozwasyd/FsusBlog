using System.Data;
using System.Data.Common;

using FsusBlog.Server.Services.Fixtures.DataScale;

using Microsoft.Data.Sqlite;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual native owner contract tests, not a prepared product-schema or seed acceptance lane.</summary>
public class DataScaleAutoIncrementIdentityReservationTests(Xunit.Abstractions.ITestOutputHelper output) : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "fsus-allocation-owner-" + Guid.NewGuid().ToString("N"));
    private protected virtual DataScaleBulkProvider Provider => DataScaleBulkProvider.Sqlite;
    protected virtual DbConnection Connection() => new SqliteConnection("Data Source=" + Path.Combine(_root, "owner.db")
        + ";Pooling=false;Default Timeout=15;Foreign Keys=true");
    private IsolationLevel Isolation => Provider == DataScaleBulkProvider.MySql ? IsolationLevel.ReadCommitted : IsolationLevel.Serializable;
    private static readonly DataScaleAutoIncrementIdentityOwner s_owner = new("native_article_ids");
    private static readonly IReadOnlyDictionary<string, DataScaleAutoIncrementIdentityOwner> s_owners
        = new Dictionary<string, DataScaleAutoIncrementIdentityOwner> { ["article"] = s_owner };
    private static readonly string s_authority = new('a', 64);

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using (DbCommand version = db.CreateCommand())
        {
            version.CommandText = Provider == DataScaleBulkProvider.MySql ? "SELECT VERSION()" : "SELECT sqlite_version()";
            output.WriteLine("NativeVersion=" + Provider + ":" + await version.ExecuteScalarAsync());
        }
        await ResetAsync(db);
    }

    public Task DisposeAsync()
    {
        Directory.Delete(_root, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task NativeOwner_AssignsExplicitRolesAndAliasesThenReplaysWithoutAllocation()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var request = Request(Group("canonical/a", "canonical/a-alias"), Group("canonical/b"));
        var first = await CommitAsync(db, request);
        Assert.Equal(1, first[0].InsertCommands);
        Assert.Equal(first[0].RoleIds["canonical/a"], first[0].RoleIds["canonical/a-alias"]);
        Assert.NotEqual(first[0].RoleIds["canonical/a"], first[0].RoleIds["canonical/b"]);
        Assert.Equal(0L, await CountAsync(db, "article"));
        await using (DbTransaction transaction = await db.BeginTransactionAsync(Isolation))
        {
            var replay = await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction, Provider,
                [request], s_owners, s_authority, CancellationToken.None, first);
            Assert.Equal(0, replay[0].InsertCommands);
            Assert.Equal(first[0].RoleIds.OrderBy(pair => pair.Key), replay[0].RoleIds.OrderBy(pair => pair.Key));
            await transaction.CommitAsync();
        }
        Assert.Equal(2L, await CountAsync(db, s_owner.Table));
        await ExecuteAsync(db, "INSERT INTO article(id) VALUES(" + first[0].RoleIds["canonical/a"] + ")");
        await Assert.ThrowsAnyAsync<DbException>(() => ExecuteAsync(db, "INSERT INTO article(id) VALUES(-1)"));
        await Assert.ThrowsAnyAsync<DbException>(() => ExecuteAsync(db, "INSERT INTO article DEFAULT VALUES"));
    }

    [Fact]
    public async Task CallerRollback_PublishesNoIdentityAndCommittedRetryKeepsItsOwnMapping()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var request = Request(Group("canonical/a"));
        await using (DbTransaction transaction = await db.BeginTransactionAsync(Isolation))
        {
            Assert.Single(await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction, Provider,
                [request], s_owners, s_authority, CancellationToken.None));
            await transaction.RollbackAsync();
        }
        Assert.Equal(0L, await CountAsync(db, s_owner.Table));
        var committed = await CommitAsync(db, request);
        await using DbTransaction replayTransaction = await db.BeginTransactionAsync(Isolation);
        var replay = await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, replayTransaction, Provider,
            [request], s_owners, s_authority, CancellationToken.None, committed);
        Assert.Equal(committed[0].RoleIds["canonical/a"], replay[0].RoleIds["canonical/a"]);
        Assert.Equal(0, replay[0].InsertCommands);
        await replayTransaction.CommitAsync();
    }

    [Theory]
    [InlineData("authority")]
    [InlineData("aliases")]
    [InlineData("native-id")]
    [InlineData("missing-row")]
    public async Task ChangedOriginalBinding_RefusesWithoutRepair(string scenario)
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var request = Request(Group("canonical/a"));
        var original = await CommitAsync(db, request);
        if (scenario == "native-id")
        {
            await ExecuteAsync(db, "UPDATE native_article_ids SET id=99999");
        }
        else if (scenario == "missing-row")
        {
            await ExecuteAsync(db, "DELETE FROM native_article_ids");
        }
        await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction,
            Provider, [scenario == "aliases" ? Request(Group("canonical/a", "new-alias")) : request], s_owners,
            scenario == "authority" ? new string('b', 64) : s_authority, CancellationToken.None,
            scenario is "native-id" or "missing-row" ? original : null));
        await transaction.CommitAsync();
        Assert.Equal(scenario == "missing-row" ? 0L : 1L, await CountAsync(db, s_owner.Table));
    }

    [Fact]
    public async Task NativeOverflow_RollsBackOnlyTheOwnedSavepointEvenIfCallerCommits()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await ExecuteAsync(db, Provider == DataScaleBulkProvider.MySql
            ? "ALTER TABLE native_article_ids AUTO_INCREMENT=2147483647"
            : "INSERT INTO sqlite_sequence(name,seq) VALUES('native_article_ids',2147483646)");
        await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
        await Assert.ThrowsAnyAsync<Exception>(() => DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction, Provider,
            [Request(Group("canonical/a"), Group("canonical/b"))], s_owners, s_authority, CancellationToken.None));
        await transaction.CommitAsync();
        Assert.Equal(0L, await CountAsync(db, s_owner.Table));
    }

    [Theory]
    [InlineData("missing-fk")]
    [InlineData("independent-identity")]
    [InlineData("owner-no-autoincrement")]
    [InlineData("owner-wrong-unique")]
    [InlineData("fk-disabled")]
    [InlineData("owner-trigger")]
    public async Task MissingRealOwnershipPort_RefusesBeforeNativeAllocation(string scenario)
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await ResetAsync(db, scenario);
        if (scenario == "fk-disabled")
        {
            await ExecuteAsync(db, Provider == DataScaleBulkProvider.MySql ? "SET FOREIGN_KEY_CHECKS=0" : "PRAGMA foreign_keys=OFF");
        }
        await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction,
            Provider, [Request(Group("canonical/a"))], s_owners, s_authority, CancellationToken.None));
        await transaction.CommitAsync();
        Assert.Equal(0L, await CountAsync(db, s_owner.Table));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentReservations_KeepDistinctNativeIdsAndStableOverlappingRoles(bool overlap)
    {
        async Task<IReadOnlyList<DataScaleAutoIncrementIdentityReservationResult>> Worker(string role)
        {
            await using DbConnection db = Connection();
            await db.OpenAsync();
            return await CommitAsync(db, Request(Group(role), Group(overlap ? "shared" : role + "-extra")));
        }
        // SQLite's existing immediate write transaction serializes native allocation;
        // InnoDB's unique role index and current reads bind racing reservations exactly.
        var first = Task.Run(() => Worker("canonical/a"));
        var second = Task.Run(() => Worker("canonical/b"));
        var results = await Task.WhenAll(first, second);
        if (overlap)
        {
            Assert.Equal(results[0][0].RoleIds["shared"], results[1][0].RoleIds["shared"]);
        }
        var unique = results.SelectMany(result => result[0].RoleIds).GroupBy(pair => pair.Key).ToArray();
        Assert.Equal(unique.Length, unique.Select(group => group.First().Value).Distinct().Count());
        await using DbConnection observed = Connection();
        await observed.OpenAsync();
        Assert.Equal(overlap ? 3L : 4L, await CountAsync(observed, s_owner.Table));
    }

    [Fact]
    public async Task ConcurrentAuthorities_ExactlyOneMayOwnTheSameCanonicalRole()
    {
        async Task<bool> Worker(string authority)
        {
            await using DbConnection db = Connection();
            await db.OpenAsync();
            await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
            try
            {
                await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction, Provider,
                    [Request(Group("shared"))], s_owners, authority, CancellationToken.None);
                await transaction.CommitAsync();
                return true;
            }
            catch (InvalidOperationException)
            {
                await transaction.RollbackAsync();
                return false;
            }
        }
        var results = await Task.WhenAll(Task.Run(() => Worker(s_authority)), Task.Run(() => Worker(new string('b', 64))));
        Assert.Single(results, result => result);
        await using DbConnection observed = Connection();
        await observed.OpenAsync();
        Assert.Equal(1L, await CountAsync(observed, s_owner.Table));
    }

    [Fact]
    public async Task LaterOwnerConflict_RollsBackEarlierReservationAndKeepsCallerWrites()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var laterOwner = new DataScaleAutoIncrementIdentityOwner("native_revision_ids");
        await ExecuteAsync(db, DataScaleAutoIncrementIdentityReservation.OwnerSchemaSql(Provider, laterOwner, DbType.Int64));
        await ExecuteAsync(db, Provider == DataScaleBulkProvider.MySql
            ? "CREATE TABLE article_revision(id BIGINT NOT NULL PRIMARY KEY,FOREIGN KEY(id) REFERENCES native_revision_ids(id)) ENGINE=InnoDB"
            : "CREATE TABLE article_revision(id INTEGER NOT NULL PRIMARY KEY,FOREIGN KEY(id) REFERENCES native_revision_ids(id)) WITHOUT ROWID");
        await ExecuteAsync(db, "CREATE TABLE caller_marker(value INTEGER NOT NULL)");
        var later = new DataScaleNativeIdentityTableRequest("article_revision", new("id", DbType.Int64), [Group("revision")]);
        var laterOwners = new Dictionary<string, DataScaleAutoIncrementIdentityOwner> { [later.Table] = laterOwner };
        await using (DbTransaction initial = await db.BeginTransactionAsync(Isolation))
        {
            await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, initial, Provider, [later], laterOwners, s_authority, CancellationToken.None);
            await initial.CommitAsync();
        }
        await ExecuteAsync(db, "UPDATE native_revision_ids SET authority_digest='" + new string('b', 64) + "'");
        await using DbTransaction caller = await db.BeginTransactionAsync(Isolation);
        await using (DbCommand marker = db.CreateCommand())
        {
            marker.Transaction = caller;
            marker.CommandText = "INSERT INTO caller_marker(value) VALUES(1)";
            await marker.ExecuteNonQueryAsync();
        }
        var allOwners = new Dictionary<string, DataScaleAutoIncrementIdentityOwner>(s_owners) { [later.Table] = laterOwner };
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, caller, Provider,
            [Request(Group("canonical/a")), later], allOwners, s_authority, CancellationToken.None));
        await caller.CommitAsync();
        Assert.Equal(0L, await CountAsync(db, s_owner.Table));
        Assert.Equal(1L, await CountAsync(db, laterOwner.Table));
        Assert.Equal(1L, await CountAsync(db, "caller_marker"));
    }

    [Fact]
    public async Task BoundedNativeInsert_ReadsEveryRoleByKeyAcrossChunks()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var groups = Enumerable.Range(0, 513).Select(index => Group("canonical/" + index)).ToArray();
        var actual = await CommitAsync(db, Request(groups));
        Assert.Equal(3, actual[0].InsertCommands);
        Assert.Equal(513, actual[0].RoleIds.Count);
        Assert.Equal(513, actual[0].RoleIds.Values.Distinct().Count());
        Assert.Equal(513L, await CountAsync(db, s_owner.Table));
    }

    [Fact]
    public async Task Cancellation_LeavesNoAllocationOrProductRows()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction,
            Provider, [Request(Group("canonical/a"))], s_owners, s_authority, cancellation.Token));
        await transaction.RollbackAsync();
        Assert.Equal(0L, await CountAsync(db, s_owner.Table));
    }

    private async Task<IReadOnlyList<DataScaleAutoIncrementIdentityReservationResult>> CommitAsync(DbConnection db,
        DataScaleNativeIdentityTableRequest request)
    {
        await using DbTransaction transaction = await db.BeginTransactionAsync(Isolation);
        var result = await DataScaleAutoIncrementIdentityReservation.ReserveAsync(db, transaction, Provider,
            [request], s_owners, s_authority, CancellationToken.None);
        await transaction.CommitAsync();
        return result;
    }

    private async Task ResetAsync(DbConnection db, string? scenario = null)
    {
        await ExecuteAsync(db, "DROP TABLE IF EXISTS article_revision;DROP TABLE IF EXISTS native_revision_ids;DROP TABLE IF EXISTS caller_marker;"
            + "DROP TABLE IF EXISTS article;DROP TABLE IF EXISTS native_article_ids");
        string ownerSql = DataScaleAutoIncrementIdentityReservation.OwnerSchemaSql(Provider, s_owner, DbType.Int32);
        if (scenario == "owner-no-autoincrement")
        {
            ownerSql = ownerSql.Replace(" AUTO_INCREMENT", "", StringComparison.Ordinal).Replace(" AUTOINCREMENT", "", StringComparison.Ordinal);
        }
        if (scenario == "owner-wrong-unique")
        {
            ownerSql = ownerSql.Replace(" NOT NULL UNIQUE", " NOT NULL", StringComparison.Ordinal);
        }
        await ExecuteAsync(db, ownerSql);
        string target = Provider == DataScaleBulkProvider.MySql ? "CREATE TABLE article(id INT NOT NULL PRIMARY KEY"
            + (scenario == "independent-identity" ? " AUTO_INCREMENT" : "") : "CREATE TABLE article(id INTEGER NOT NULL PRIMARY KEY";
        target += scenario is "missing-fk" or "independent-identity" ? ")" : ",FOREIGN KEY(id) REFERENCES native_article_ids(id))";
        target += Provider == DataScaleBulkProvider.MySql ? " ENGINE=InnoDB" : scenario == "independent-identity" ? "" : " WITHOUT ROWID";
        await ExecuteAsync(db, target);
        if (scenario == "owner-trigger")
        {
            await InstallDiagnosticTriggerAsync(db);
        }
    }

    protected virtual Task InstallDiagnosticTriggerAsync(DbConnection db) => ExecuteAsync(db,
        "CREATE TRIGGER native_owner_tamper AFTER INSERT ON native_article_ids BEGIN UPDATE native_article_ids SET authority_digest='bad';END");

    private static DataScaleNativeIdentityRoleGroup Group(string role, params string[] aliases) => new(role, new[] { role }.Concat(aliases).ToArray());
    private static DataScaleNativeIdentityTableRequest Request(params DataScaleNativeIdentityRoleGroup[] groups) => new("article", new("id", DbType.Int32), groups);
    private static async Task ExecuteAsync(DbConnection db, string sql)
    {
        await using DbCommand command = db.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<long> CountAsync(DbConnection db, string table)
    {
        await using DbCommand command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM " + table;
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }
}
