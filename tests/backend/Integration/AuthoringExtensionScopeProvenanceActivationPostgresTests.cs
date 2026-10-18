using System.Diagnostics;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Npgsql;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionScopeProvenanceActivationPostgresTests(PostgresSchemaMigrationFixture postgres)
{
    [Theory]
    [InlineData("none")]
    [InlineData("expiry")]
    [InlineData("site")]
    [InlineData("session-revoke")]
    [InlineData("principal-revoke")]
    public async Task ActualBlockedCas_HoldsActorRowsAndRevalidatesAfterUpdateBeforeCommit(string mutation)
    {
        await using AuthoringExtensionScopeProvenancePostgresTests.Harness host =
            await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.SqlAsync("""
            CREATE FUNCTION activation_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD.status=0 AND NEW.status=1 THEN
                    PERFORM pg_advisory_xact_lock(21424643);
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER activation_test_gate BEFORE UPDATE ON authoring_extension_scope_provenance
                FOR EACH ROW EXECUTE FUNCTION activation_test_gate();
            """);
        await using NpgsqlConnection blocker = await host.DataSource.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(21424643)", blocker))
        {
            await command.ExecuteNonQueryAsync();
        }
        if (mutation == "expiry")
        {
            await host.SqlAsync("UPDATE admin_session SET idleexpiresatutc=clock_timestamp()+interval '2 seconds' WHERE adminprincipalid=1");
        }
        Task<AuthoringStateScope> activation = host.CompleteAsync(registration);
        await WaitForQueryLockAsync(host.DataSource, "UPDATE authoring_extension_scope_provenance SET status=1%");
        Assert.False(activation.IsCompleted);
        Task? revoke = null;
        switch (mutation)
        {
            case "expiry":
                await Task.Delay(2100);
                break;
            case "site":
                host.Configuration["AuthoringExtensions:SiteId"] = "changed-during-cas";
                break;
            case "session-revoke":
                revoke = host.SqlAsync("UPDATE admin_session SET revokedatutc=clock_timestamp() WHERE adminprincipalid=1");
                await WaitForQueryLockAsync(host.DataSource, "UPDATE admin_session SET revokedatutc%");
                break;
            case "principal-revoke":
                revoke = host.SqlAsync("UPDATE admin_principal SET status='disabled' WHERE id=1");
                await WaitForQueryLockAsync(host.DataSource, "UPDATE admin_principal SET status='disabled'%");
                break;
        }
        if (revoke is not null)
        {
            Assert.False(revoke.IsCompleted);
        }
        await transaction.RollbackAsync();
        if (mutation is "expiry" or "site")
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => activation);
        }
        else
        {
            Assert.Equal(registration.Scope, await activation);
        }
        if (revoke is not null)
        {
            await revoke;
            await host.RefuseAsync(registration.Scope);
        }
        await using NpgsqlConnection inspect = await host.DataSource.OpenConnectionAsync();
        await using var status = new NpgsqlCommand(
            "SELECT status,revision,creation_seen FROM authoring_extension_scope_provenance WHERE registration_id=$1", inspect);
        status.Parameters.AddWithValue(registration.RegistrationId);
        await using NpgsqlDataReader reader = await status.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        bool rejected = mutation is "expiry" or "site";
        Assert.Equal(rejected ? 0 : 1, reader.GetInt16(0));
        Assert.Equal(rejected ? 0L : 1L, reader.GetInt64(1));
        Assert.True(reader.GetBoolean(2));
    }

    internal static async Task WaitForQueryLockAsync(NpgsqlDataSource dataSource, string query)
    {
        long started = Stopwatch.GetTimestamp();
        while (Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(3))
        {
            await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync();
            await using var command = new NpgsqlCommand("""
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                    AND query LIKE $1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0)
                """, connection);
            command.Parameters.AddWithValue(query);
            if (await command.ExecuteScalarAsync() is true)
            {
                return;
            }
            await Task.Delay(10);
        }
        Assert.Fail("Expected the actual SQL statement to be blocked by its PostgreSQL control lock.");
    }
}
