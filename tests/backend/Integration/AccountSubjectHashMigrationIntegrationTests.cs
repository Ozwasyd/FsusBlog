using Npgsql;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AccountSubjectHashMigrationIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Backfill_UsesCanonicalHasherAndIsIdempotent()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        await fixture.ExecuteAsync(
            connectionString,
            """
            INSERT INTO sys_user(id, identity_kind, public_handle, account_subject_hash)
            SELECT id, 'anonymous_account', 'reader-' || id::text, NULL
            FROM generate_series(4, 300) AS series(id);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);

        await ExecuteDescriptorTwiceAsync(db, "20260711-post-account-subject-hash-backfill");

        string first = await fixture.QueryScalarAsync<string>(
            connectionString,
            "SELECT account_subject_hash FROM sys_user WHERE id = 1;");
        string second = await fixture.QueryScalarAsync<string>(
            connectionString,
            "SELECT account_subject_hash FROM sys_user WHERE id = 2;");
        string third = await fixture.QueryScalarAsync<string>(
            connectionString,
            "SELECT account_subject_hash FROM sys_user WHERE id = 3;");
        string finalBatchRow = await fixture.QueryScalarAsync<string>(
            connectionString,
            "SELECT account_subject_hash FROM sys_user WHERE id = 300;");

        Assert.Equal(AccountSubjectHasher.Create(new User
        {
            Id = 1,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PublicHandle = "QuietReader"
        }), first);
        Assert.Equal(AccountSubjectHasher.Create(new User
        {
            Id = 2,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyUserHandle = "QWJjZA"
        }), second);
        Assert.Equal(AccountSubjectHasher.Create(new User
        {
            Id = 3,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind
        }), third);
        Assert.Equal(AccountSubjectHasher.Create(new User
        {
            Id = 300,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PublicHandle = "reader-300"
        }), finalBatchRow);
        Assert.Equal(0, await CountInvalidAsync(connectionString));
    }

    [Fact]
    public async Task FormatConstraint_AllowsRollingNullButRejectsMalformedProjection()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await ExecuteDescriptorTwiceAsync(db, "20260711-post-account-subject-hash-backfill");

        await fixture.ExecuteAsync(
            connectionString,
            "INSERT INTO sys_user(id, identity_kind, account_subject_hash) VALUES (4, 'anonymous_account', NULL);");
        await Assert.ThrowsAsync<PostgresException>(() => fixture.ExecuteAsync(
            connectionString,
            "INSERT INTO sys_user(id, identity_kind, account_subject_hash) VALUES (5, 'anonymous_account', 'malformed');"));
    }

    [Fact]
    public async Task StartupGate_RechecksProjectionAfterMigrationHistoryCouldAlreadyExist()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await ExecuteDescriptorTwiceAsync(db, "20260711-post-account-subject-hash-backfill");
        var gate = new AccountSubjectHashInvariantGate(db);

        await fixture.ExecuteAsync(
            connectionString,
            "UPDATE sys_user SET account_subject_hash = NULL WHERE id = 1;");
        await Assert.ThrowsAsync<InvalidOperationException>(() => gate.EnsureAsync());

        await new AccountSubjectHashBackfillStep().ExecuteAsync(db, CancellationToken.None);
        await gate.EnsureAsync();
        Assert.Equal(0, await CountInvalidAsync(connectionString));
    }

    [Fact]
    public async Task OnlineBackfillHandler_ResumesFromDurableKeysetTokenAndFinalizesValidation()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        await fixture.ExecuteAsync(
            connectionString,
            """
            INSERT INTO sys_user(id, identity_kind, public_handle, account_subject_hash)
            SELECT id, 'anonymous_account', 'reader-' || id::text, NULL
            FROM generate_series(4, 12) AS series(id);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var handler = new AccountSubjectHashOnlineBackfillHandler(db);

        OnlineSchemaBackfillBatchResult first = await handler.ExecuteBatchAsync(
            resumeToken: null,
            batchSize: 2,
            CancellationToken.None);
        Assert.Equal(2, first.RowsProcessed);
        Assert.Equal("2", first.ResumeToken);
        Assert.False(first.Complete);
        Assert.False(await handler.VerifyAsync(CancellationToken.None));

        string? resumeToken = first.ResumeToken;
        OnlineSchemaBackfillBatchResult current = first;
        while (!current.Complete)
        {
            current = await handler.ExecuteBatchAsync(resumeToken, 2, CancellationToken.None);
            resumeToken = current.ResumeToken;
        }

        Assert.Equal("12", resumeToken);
        Assert.True(await handler.VerifyAsync(CancellationToken.None));
        Assert.Equal(0, await CountInvalidAsync(connectionString));
        await Assert.ThrowsAsync<PostgresException>(() => fixture.ExecuteAsync(
            connectionString,
            "INSERT INTO sys_user(id, identity_kind, account_subject_hash) VALUES (13, 'anonymous_account', 'malformed');"));
    }

    private async Task<string> CreateLegacyAccountTableAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        await fixture.ExecuteAsync(
            connectionString,
            """
            CREATE TABLE sys_user (
                id integer PRIMARY KEY,
                identity_kind varchar(32) NULL,
                passkey_user_handle varchar(128) NULL,
                public_handle varchar(64) NULL,
                account_subject_hash varchar(64) NULL
            );
            INSERT INTO sys_user(id, identity_kind, passkey_user_handle, public_handle, account_subject_hash)
            VALUES
                (1, 'anonymous_account', NULL, ' QuietReader ', NULL),
                (2, 'anonymous_account', ' QWJjZA ', 'ignored-handle', ''),
                (3, NULL, NULL, NULL, 'INVALID');
            """);
        return connectionString;
    }

    private static async Task ExecuteDescriptorTwiceAsync(SqlSugarClient db, string migrationId)
    {
        ISchemaMigrationDescriptor descriptor = new SchemaMigrationRegistry()
            .GetDescriptors()
            .Single(item => item.MigrationId == migrationId);
        for (int pass = 0; pass < 2; pass++)
        {
            foreach (SchemaMigrationStep step in descriptor.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
    }

    private Task<int> CountInvalidAsync(string connectionString)
        => fixture.QueryScalarAsync<int>(
            connectionString,
            """
            SELECT COUNT(1)
            FROM sys_user
            WHERE account_subject_hash IS NULL
               OR account_subject_hash = ''
               OR account_subject_hash !~ '^[0-9a-f]{64}$';
            """);
}
