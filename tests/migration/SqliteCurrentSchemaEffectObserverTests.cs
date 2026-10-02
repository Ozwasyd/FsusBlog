using System.Data;

using Microsoft.Data.Sqlite;
using Xunit;

using FsusBlog.Algorithms;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Actual native trigger/catalog source fixtures, not approved SQLite current
/// recipes, production incarnation, a completed apply or three-provider acceptance.
/// </summary>
public sealed class SqliteCurrentSchemaEffectObserverTests
{
    [Theory]
    [InlineData("ABORT", SqliteTriggerRaiseAction.Abort)]
    [InlineData("ROLLBACK", SqliteTriggerRaiseAction.Rollback)]
    [InlineData("FAIL", SqliteTriggerRaiseAction.Fail)]
    [InlineData("IGNORE", SqliteTriggerRaiseAction.Ignore)]
    public async Task ActualRaiseActionsAreRecordedWithoutChoosingAnExpectedPolicy(string action, SqliteTriggerRaiseAction expected)
    {
        string arguments = action == "IGNORE" ? "IGNORE" : action + ", 'immutable_message'";
        await using var fixture = await NativeFixture.CreateAsync($"""
            CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT);
            INSERT INTO item VALUES(1, 'original');
            CREATE TRIGGER item_guard BEFORE UPDATE ON item FOR EACH ROW
                BEGIN SELECT RAISE({arguments}); END;
            """);
        SqliteCurrentSchemaEffectObservation observation = await fixture.ReadAsync();
        SqliteImmutableTriggerObservation trigger = Assert.Single(observation.Triggers);
        Assert.Equal("item_guard", trigger.Name);
        Assert.Equal("item", trigger.Table);
        Assert.Equal(SqliteImmutableTriggerEvent.Update, trigger.Event);
        Assert.Equal(expected, trigger.Action);
        Assert.Equal(action == "IGNORE" ? null : "immutable_message", trigger.Message);
        if (action == "IGNORE")
        {
            Assert.Equal(0, await fixture.ExecuteAsync("UPDATE item SET value = 'changed' WHERE id = 1"));
        }
        else
        {
            SqliteException actual = await Assert.ThrowsAsync<SqliteException>(() =>
                fixture.ExecuteAsync("UPDATE item SET value = 'changed' WHERE id = 1"));
            Assert.Contains("immutable_message", actual.Message);
        }
    }

    [Theory]
    [InlineData("UPDATE", SqliteImmutableTriggerEvent.Update)]
    [InlineData("DELETE", SqliteImmutableTriggerEvent.Delete)]
    public async Task SingleNativeEventsAreNotMistakenForCombinedPostgresTrigger(string nativeEvent, SqliteImmutableTriggerEvent expected)
    {
        await using var fixture = await NativeFixture.CreateAsync($"""
            CREATE TABLE item(id INTEGER PRIMARY KEY);
            CREATE TRIGGER item_guard BEFORE {nativeEvent} ON item
                BEGIN SELECT RAISE(ABORT, 'immutable'); END;
            """);
        SqliteImmutableTriggerObservation actual = Assert.Single((await fixture.ReadAsync()).Triggers);
        Assert.Equal(expected, actual.Event);
    }

    [Fact]
    public async Task ActualQuotedIdentifiersAndMessageEscapesAreDecodedExactly()
    {
        await using var fixture = await NativeFixture.CreateAsync("""
            CREATE TABLE "odd""table"(id INTEGER PRIMARY KEY);
            CREATE TRIGGER "odd""trigger" BEFORE DELETE ON "odd""table"
                BEGIN SELECT RAISE(ABORT, 'it''s \literal and UPDATE'); END;
            """);
        SqliteImmutableTriggerObservation actual = Assert.Single((await fixture.ReadAsync()).Triggers);
        Assert.Equal("odd\"trigger", actual.Name);
        Assert.Equal("odd\"table", actual.Table);
        Assert.Equal("it's \\literal and UPDATE", actual.Message);
    }

    [Theory]
    [InlineData("`item`")]
    [InlineData("[item]")]
    [InlineData("\"item\"")]
    public async Task NativeIdentifierQuoteFormsDoNotDefineAnotherTableAuthority(string identifier)
    {
        await using var fixture = await NativeFixture.CreateAsync($"""
            CREATE TABLE {identifier}(id INTEGER PRIMARY KEY);
            CREATE TRIGGER guard BEFORE UPDATE ON {identifier}
                BEGIN SELECT RAISE(ABORT, 'message'); END;
            """);
        SqliteImmutableTriggerObservation actual = Assert.Single((await fixture.ReadAsync()).Triggers);
        Assert.Equal("item", actual.Table);
    }

    [Theory]
    [InlineData("BEFORE UPDATE OF value", "", "SELECT RAISE(ABORT, 'message');")]
    [InlineData("BEFORE UPDATE OF absent_column", "", "SELECT RAISE(ABORT, 'message');")]
    [InlineData("BEFORE UPDATE", "WHEN 0", "SELECT RAISE(ABORT, 'message');")]
    [InlineData("AFTER UPDATE", "", "SELECT RAISE(ABORT, 'message');")]
    [InlineData("BEFORE INSERT", "", "SELECT RAISE(ABORT, 'message');")]
    [InlineData("BEFORE UPDATE", "", "SELECT 1;")]
    [InlineData("BEFORE UPDATE", "", "SELECT RAISE(ABORT, 'message'); SELECT 1;")]
    public async Task ConditionalNarrowOrAdditionalNativeEffectsAreRefusedNotSkipped(string header, string condition, string body)
    {
        await using var fixture = await NativeFixture.CreateAsync($"""
            CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT);
            CREATE TRIGGER guard {header} ON item {condition} BEGIN {body} END;
            """);
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("sqlite_current_trigger_effect_not_supported", actual.Message);
    }

    [Fact]
    public async Task OneValidGuardDoesNotHideAnAdditionalUnknownTrigger()
    {
        await using var fixture = await NativeFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY);
            CREATE TRIGGER known BEFORE UPDATE ON item BEGIN SELECT RAISE(ABORT, 'message'); END;
            CREATE TRIGGER unknown AFTER UPDATE ON item BEGIN SELECT 1; END;
            """);
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("sqlite_current_trigger_effect_not_supported", actual.Message);
    }

    [Fact]
    public async Task RealAbsentColumnUpdateOfGuardDoesNotProtectOtherNativeWrites()
    {
        await using var fixture = await NativeFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT);
            INSERT INTO item VALUES(1, 'original');
            CREATE TRIGGER guard BEFORE UPDATE OF absent_column ON item
                BEGIN SELECT RAISE(ABORT, 'message'); END;
            """);
        // SQLite genuinely accepts the absent-column trigger but does not fire it
        // for this update. Name-only catalog evidence would miss this counterexample.
        Assert.Equal(1, await fixture.ExecuteAsync("UPDATE item SET value = 'changed' WHERE id = 1"));
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("sqlite_current_trigger_effect_not_supported", actual.Message);
    }

    [Fact]
    public async Task ActualNativeDynamicRaiseMessageIsAnUnsupportedEffectNotALiteralFact()
    {
        await using var fixture = await NativeFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY);
            CREATE TRIGGER guard BEFORE UPDATE ON item
                BEGIN SELECT RAISE(ABORT, 'prefix' || 'suffix'); END;
            """);
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("sqlite_current_trigger_effect_not_supported", actual.Message);
    }

    [Fact]
    public async Task ObservingEffectsLeavesOriginalCallerTransactionAndDataUnchanged()
    {
        await using var fixture = await NativeFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY, value TEXT);
            INSERT INTO item VALUES(1, 'original');
            CREATE TRIGGER guard BEFORE DELETE ON item BEGIN SELECT RAISE(ABORT, 'message'); END;
            """);
        SqliteCurrentSchemaEffectObservation actual = await fixture.ReadAsync();
        Assert.False(actual.Catalog.QueryOnly);
        Assert.Single(actual.Triggers);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
        Assert.Equal(1, await fixture.ExecuteAsync("UPDATE item SET value = 'caller-owned' WHERE id = 1"));
        await fixture.Transaction.RollbackAsync();
        await using SqliteCommand command = fixture.Connection.CreateCommand();
        command.CommandText = "SELECT value FROM item WHERE id = 1";
        Assert.Equal("original", await command.ExecuteScalarAsync());
    }

    [Fact]
    public async Task EmptyEffectsStayEmptyAndAreNotATargetOrFactoryGrant()
    {
        await using var fixture = await NativeFixture.CreateAsync("CREATE TABLE item(id INTEGER PRIMARY KEY);");
        SqliteCurrentSchemaEffectObservation actual = await fixture.ReadAsync();
        Assert.Empty(actual.Triggers);
        Assert.Contains(actual.Catalog.Tables, table => table.Name == "item");
    }

    [Fact]
    public async Task NativeCancelledObservationDoesNotOpenAnotherSession()
    {
        await using var fixture = await NativeFixture.CreateAsync("CREATE TABLE item(id INTEGER PRIMARY KEY);");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteCurrentSchemaEffectObserver.ReadAsync(fixture.Connection, fixture.Transaction, cancellation.Token));
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Theory]
    [InlineData("CREATE TRIGGER guard BEFORE UPDATE ON item BEGIN SELECT RAISE(ABORT, 'message'); END; SELECT 1;")]
    [InlineData("CREATE TRIGGER guard BEFORE UPDATE ON item BEGIN SELECT RAISE(ABORT, 'message'); END;\0")]
    [InlineData("CREATE TRIGGER guard BEFORE UPDATE ON item BEGIN SELECT RAISE(ABORT, 'message' || 'dynamic'); END;")]
    [InlineData("CREATE TRIGGER guard BEFORE UPDATE ON item BEGIN ſELECT RAISE(ABORT, 'message'); END;")]
    public void PureDecoderRejectsTrailingNulExtraStatementsOrDynamicMessage(string sql)
    {
        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() => SqliteImmutableTriggerObserver.Decode(sql));
        Assert.Equal("sqlite_current_trigger_effect_not_supported", actual.Message);
    }

    private sealed class NativeFixture(SqliteConnection connection, SqliteTransaction transaction) : IAsyncDisposable
    {
        internal SqliteConnection Connection { get; } = connection;
        internal SqliteTransaction Transaction { get; } = transaction;

        internal static async Task<NativeFixture> CreateAsync(string setup)
        {
            var connection = new SqliteConnection("Data Source=:memory:;Pooling=False");
            try
            {
                await connection.OpenAsync();
                await using (SqliteCommand command = connection.CreateCommand())
                {
                    command.CommandText = setup;
                    await command.ExecuteNonQueryAsync();
                }
                return new(connection, connection.BeginTransaction(IsolationLevel.Serializable, deferred: true));
            }
            catch
            {
                await connection.DisposeAsync();
                throw;
            }
        }

        internal Task<SqliteCurrentSchemaEffectObservation> ReadAsync() =>
            SqliteCurrentSchemaEffectObserver.ReadAsync(Connection, Transaction, CancellationToken.None);

        internal async Task<int> ExecuteAsync(string sql)
        {
            await using SqliteCommand command = Connection.CreateCommand();
            command.Transaction = Transaction;
            command.CommandText = sql;
            return await command.ExecuteNonQueryAsync();
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await Transaction.DisposeAsync();
            }
            finally
            {
                await Connection.DisposeAsync();
            }
        }
    }
}
