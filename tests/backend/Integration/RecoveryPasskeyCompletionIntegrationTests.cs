using System.Buffers;
using System.Security.Cryptography;
using System.Text;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class RecoveryPasskeyCompletionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string RecoverySessionHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private const string RecoveryRequestHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public async Task AuthenticatorFailure_DoesNotPersistCredentialOrConsumeRegistrationChallenge()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 0, passkeyEnabled: false);
        var fido = Substitute.For<IFido2>();
        fido.MakeNewCredentialAsync(
                Arg.Any<MakeNewCredentialParams>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException<RegisteredPublicKeyCredential>(new InvalidOperationException("authenticator rejected")));
        var cache = Substitute.For<IUnifiedCache>();
        var options = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = "challenge-authenticator-failure",
            Timeout = 60_000,
            RpId = "localhost",
            RpName = "FsusBlog",
            AccountName = "anonymous-account",
            AccountDisplayName = "Anonymous account",
            AccountHandle = [1, 2, 3, 4],
            Challenge = [5, 6, 7, 8],
            PubKeyCredParams = [],
            ExcludeCredentials = []
        };
        cache.TryGetAsync<PasskeyRegisterBeginCoreModel>(
                CachePolicyId.SecurityPasskeyRegChallenge,
                options.SessionKey,
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyRegisterBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyRegisterBeginCoreModel>(true, options)));
        PasskeyService service = CreateService(db, fido, cache);
        var session = new RecoveryKeySession(
            accountId,
            false,
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(9));
        var request = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = options.SessionKey,
            Id = "credential-authenticator-failure",
            RawId = [9, 10],
            ClientDataBytes = [11, 12],
            AttestationObject = [13, 14],
            MfaProofToken = "recovery-token"
        };

        RecoveryPasskeyRegistrationResult result = await service.CompleteRecoveryRegistrationAsync(
            session,
            RecoverySessionHash,
            RecoveryRequestHash,
            request);

        Assert.Equal(RecoveryPasskeyRegistrationStatus.ValidationFailed, result.Status);
        Assert.Equal(0, await db.Queryable<PasskeyCredential>().CountAsync());
        await cache.DidNotReceive().RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            options.SessionKey,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Persistence_CommitsNewCredentialOldCredentialRevocationAndPasskeyFlagTogether()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 0, passkeyEnabled: false);
        DateTime issuedAt = DateTime.UtcNow.AddMinutes(-1);
        SeedCredential(db, accountId, "old-before-recovery", issuedAt.AddMinutes(-5));
        var cache = Substitute.For<IUnifiedCache>();
        PasskeyService service = CreateService(db, suppliedCache: cache);
        var session = new RecoveryKeySession(accountId, true, issuedAt, issuedAt.AddMinutes(10));
        PasskeyCredential newCredential = Credential(accountId, "new-recovery-credential", DateTime.UtcNow);

        RecoveryPasskeyRegistrationResult result = await service.PersistRecoveryRegistrationAsync(
            session,
            RecoverySessionHash,
            RecoveryRequestHash,
            "challenge-transaction",
            newCredential);

        Assert.Equal(RecoveryPasskeyRegistrationStatus.Completed, result.Status);
        PasskeyCredential stored = await db.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.RecoverySessionHash == RecoverySessionHash);
        Assert.Equal("new-recovery-credential", stored.CredentialId);
        Assert.Equal(RecoveryRequestHash, stored.RecoveryRequestHash);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == accountId));
        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
        await cache.Received(1).IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            accountId.ToString(),
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            "challenge-transaction",
            Arg.Any<CancellationToken>());

        RecoveryPasskeyRegistrationResult replay = await service.PersistRecoveryRegistrationAsync(
            session,
            RecoverySessionHash,
            RecoveryRequestHash,
            "challenge-transaction",
            Credential(accountId, "must-not-be-inserted", DateTime.UtcNow));
        Assert.Equal(RecoveryPasskeyRegistrationStatus.AlreadyCompleted, replay.Status);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == accountId));
        await cache.Received(2).IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            accountId.ToString(),
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(2).RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            "challenge-transaction",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SnapshotFailureAfterDatabaseCommit_ReplayFinalizesWithoutSecondCredentialMutation()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 0, passkeyEnabled: false);
        DateTime issuedAt = DateTime.UtcNow.AddMinutes(-1);
        SeedCredential(db, accountId, "old-before-snapshot-failure", issuedAt.AddMinutes(-5));
        var cache = Substitute.For<IUnifiedCache>();
        PasskeyService service = CreateService(db, suppliedCache: cache);
        int snapshotAttempts = 0;
        cache.IncrementAsync(
                CachePolicyId.AccountSnapshotVersion,
                accountId.ToString(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(_ => Interlocked.Increment(ref snapshotAttempts) == 1
                ? Task.FromException<long>(new IOException("snapshot cache unavailable after commit"))
                : Task.FromResult(2L));
        var session = new RecoveryKeySession(accountId, true, issuedAt, issuedAt.AddMinutes(10));
        string sessionHash = new('3', 64);
        string requestHash = new('4', 64);

        await Assert.ThrowsAsync<IOException>(() => service.PersistRecoveryRegistrationAsync(
            session,
            sessionHash,
            requestHash,
            "challenge-snapshot-replay",
            Credential(accountId, "new-before-snapshot-failure", DateTime.UtcNow)));

        Assert.Equal(1, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.RecoverySessionHash == sessionHash));
        Assert.Equal(1, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.AccountId == accountId));
        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
        await cache.DidNotReceive().RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            "challenge-snapshot-replay",
            Arg.Any<CancellationToken>());

        RecoveryPasskeyRegistrationResult replay = await service.PersistRecoveryRegistrationAsync(
            session,
            sessionHash,
            requestHash,
            "challenge-snapshot-replay",
            Credential(accountId, "must-not-be-written-on-snapshot-replay", DateTime.UtcNow));

        Assert.Equal(RecoveryPasskeyRegistrationStatus.AlreadyCompleted, replay.Status);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.AccountId == accountId));
        Assert.Equal(2, snapshotAttempts);
        await cache.Received(1).RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            "challenge-snapshot-replay",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PersistenceFailure_RollsBackCredentialRevocationAndPasskeyFlag()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 2, passkeyEnabled: false);
        DateTime issuedAt = DateTime.UtcNow.AddMinutes(-1);
        SeedCredential(db, accountId, "old-must-survive", issuedAt.AddMinutes(-5));
        PasskeyService service = CreateService(db);
        var session = new RecoveryKeySession(accountId, true, issuedAt, issuedAt.AddMinutes(10));
        string rollbackRecoverySessionHash = new('C', 64);

        RecoveryPasskeyRegistrationResult result = await service.PersistRecoveryRegistrationAsync(
            session,
            rollbackRecoverySessionHash,
            new string('D', 64),
            "challenge-rollback",
            Credential(accountId, "rolled-back-new", DateTime.UtcNow));

        Assert.Equal(RecoveryPasskeyRegistrationStatus.RetryableFailure, result.Status);
        string[] credentialIds = await db.Queryable<PasskeyCredential>()
            .Where(item => item.AccountId == accountId)
            .Select(item => item.CredentialId)
            .ToArrayAsync();
        Assert.Equal(["old-must-survive"], credentialIds);
        User account = await db.Queryable<User>().SingleAsync(item => item.Id == accountId);
        Assert.False(account.PasskeyEnabled);
        Assert.Equal(0, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.RecoverySessionHash == rollbackRecoverySessionHash));
    }

    [Fact]
    public async Task DatabaseUniqueConstraintException_LeavesRecoveryCompletionRetryableAndUncommitted()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 0, passkeyEnabled: false);
        const string DuplicateCredentialId = "duplicate-database-credential";
        SeedCredential(db, accountId, DuplicateCredentialId, DateTime.UtcNow.AddMinutes(-5));
        var cache = Substitute.For<IUnifiedCache>();
        PasskeyService service = CreateService(db, suppliedCache: cache);
        DateTime issuedAt = DateTime.UtcNow.AddMinutes(-1);
        var session = new RecoveryKeySession(accountId, false, issuedAt, issuedAt.AddMinutes(10));
        string sessionHash = new('1', 64);
        string requestHash = new('2', 64);

        RecoveryPasskeyRegistrationResult result = await service.PersistRecoveryRegistrationAsync(
            session,
            sessionHash,
            requestHash,
            "challenge-database-exception",
            Credential(accountId, DuplicateCredentialId, DateTime.UtcNow));

        Assert.Equal(RecoveryPasskeyRegistrationStatus.RetryableFailure, result.Status);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.CredentialId == DuplicateCredentialId));
        Assert.Equal(0, await db.Queryable<PasskeyCredential>()
            .CountAsync(item => item.RecoverySessionHash == sessionHash));
        Assert.False((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
        await cache.DidNotReceive().IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            accountId.ToString(),
            1,
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            "challenge-database-exception",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ConcurrentPersistence_UsesUniqueRecoveryHashForOneLogicalCompletion()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setup);
        int accountId = SeedAccount(setup, status: 0, passkeyEnabled: false);
        DateTime issuedAt = DateTime.UtcNow.AddMinutes(-1);
        var session = new RecoveryKeySession(accountId, false, issuedAt, issuedAt.AddMinutes(10));
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        PasskeyService first = CreateService(firstDb);
        PasskeyService second = CreateService(secondDb);
        using var barrier = new Barrier(2);
        string concurrentRecoverySessionHash = new('E', 64);

        RecoveryPasskeyRegistrationResult[] outcomes = await Task.WhenAll(
            StartTogetherAsync(barrier, () => first.PersistRecoveryRegistrationAsync(
                session,
                concurrentRecoverySessionHash,
                new string('F', 64),
                "challenge-concurrent",
                Credential(accountId, "concurrent-a", DateTime.UtcNow))),
            StartTogetherAsync(barrier, () => second.PersistRecoveryRegistrationAsync(
                session,
                concurrentRecoverySessionHash,
                new string('F', 64),
                "challenge-concurrent",
                Credential(accountId, "concurrent-b", DateTime.UtcNow))));

        Assert.Single(outcomes, item => item.Status == RecoveryPasskeyRegistrationStatus.Completed);
        Assert.Single(outcomes, item => item.Status == RecoveryPasskeyRegistrationStatus.AlreadyCompleted);
        Assert.Equal(1, await setup.Queryable<PasskeyCredential>()
            .CountAsync(item => item.RecoverySessionHash == concurrentRecoverySessionHash));
    }

    [Fact]
    public async Task RawRecoveryToken_FlowsThroughCompletionAsSha256AndCanonicalRequestHashOnly()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        int accountId = SeedAccount(db, status: 0, passkeyEnabled: false);
        const string RawToken = "raw-recovery-token-must-never-reach-postgres";
        string identity = RecoveryKeyService.BuildSessionIdentity(RawToken);
        var session = new RecoveryKeySession(
            accountId,
            false,
            DateTime.UtcNow.AddMinutes(-1),
            DateTime.UtcNow.AddMinutes(9));
        string envelope = RecoveryKeyService.EncodeSessionEnvelope(
            RecoveryKeyService.ToPendingEnvelope(session));
        var request = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = "raw-token-chain-challenge",
            Id = "raw-token-chain-credential",
            RawId = [1, 3, 5, 7],
            ClientDataBytes = [2, 4, 6, 8],
            AttestationObject = [9, 10, 11],
            Transports = [1, 2],
            FriendlyName = "Raw token chain",
            MfaProofToken = RawToken
        };
        var cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                identity,
                Arg.Any<CancellationToken>())
            .Returns(_ => Task.FromResult<string?>(envelope));
        cache.TrySetStringIfValueAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                identity,
                Arg.Any<string>(),
                identity,
                Arg.Any<string>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string expected = call.ArgAt<string>(4);
                if (!string.Equals(envelope, expected, StringComparison.Ordinal))
                {
                    return Task.FromResult(false);
                }

                envelope = call.ArgAt<string>(2);
                return Task.FromResult(true);
            });
        cache.IncrementAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));
        cache.RemoveAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        PasskeyService persistence = CreateService(db, suppliedCache: cache);
        var passkeys = Substitute.For<IPasskeyService>();
        passkeys.TryResolveRecoveryRegistrationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(call => persistence.TryResolveRecoveryRegistrationAsync(
                call.ArgAt<string>(0),
                call.ArgAt<string>(1),
                call.ArgAt<string>(2),
                call.ArgAt<CancellationToken>(3)));
        passkeys.CompleteRecoveryRegistrationAsync(
                Arg.Any<RecoveryKeySession>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                RecoveryKeySession claimedSession = call.ArgAt<RecoveryKeySession>(0);
                PasskeyRegisterCompleteCoreModel claimedRequest = call.ArgAt<PasskeyRegisterCompleteCoreModel>(3);
                return persistence.PersistRecoveryRegistrationAsync(
                    claimedSession,
                    call.ArgAt<string>(1),
                    call.ArgAt<string>(2),
                    claimedRequest.SessionKey,
                    Credential(claimedSession.AccountId, claimedRequest.Id, DateTime.UtcNow),
                    call.ArgAt<CancellationToken>(4));
            });
        var recovery = new RecoveryKeyService(
            db,
            cache,
            cache,
            cache,
            cache,
            cache,
            new ConfigurationBuilder().Build(),
            passkeys,
            NullLogger<RecoveryKeyService>.Instance,
            Substitute.For<IUserSessionValidationCache>());

        Result<RecoveryPasskeyBindOutcome> result = await recovery.CompletePasskeyBindAsync(
            RawToken,
            request,
            CancellationToken.None);

        Assert.True(result.IsSuccess, result.Error.Message);
        var canonical = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WritePasskeyRegisterCompleteRequest(request, canonical);
        string expectedSessionHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(RawToken)));
        string expectedRequestHash = Convert.ToHexString(SHA256.HashData(canonical.WrittenSpan));
        PasskeyCredential stored = await db.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == request.Id);
        Assert.Equal(expectedSessionHash, stored.RecoverySessionHash);
        Assert.Equal(expectedRequestHash, stored.RecoveryRequestHash);
        Assert.NotEqual(RawToken, stored.RecoverySessionHash);
        Assert.DoesNotContain(RawToken, stored.RecoveryRequestHash ?? string.Empty, StringComparison.Ordinal);
        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
    }

    [Fact]
    public async Task Migration_UpgradesLegacyPasskeyTableIdempotentlyAndEnforcesUniqueSessionHash()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE passkey_credential (
                id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                account_id integer NOT NULL,
                credentialid varchar(512) NOT NULL,
                publickey text NOT NULL,
                signcount bigint NOT NULL DEFAULT 0,
                aaguid varchar(36) NOT NULL,
                backupeligible boolean NOT NULL DEFAULT false,
                backupstate boolean NOT NULL DEFAULT false,
                createdat timestamp NOT NULL DEFAULT now()
            );
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        ISchemaMigrationDescriptor descriptor = new SchemaMigrationRegistry()
            .GetDescriptors()
            .Single(item => item.MigrationId == "20260711-post-recovery-passkey-completion-idempotency");

        for (int pass = 0; pass < 2; pass++)
        {
            foreach (SchemaMigrationStep step in descriptor.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }

        Assert.True(await fixture.ColumnExistsAsync(connectionString, "passkey_credential", "recovery_session_hash"));
        Assert.True(await fixture.ColumnExistsAsync(connectionString, "passkey_credential", "recovery_request_hash"));
        Assert.True(await fixture.IndexExistsAsync(connectionString, "ux_passkey_recovery_session_hash"));
        await fixture.ExecuteAsync(connectionString, $"""
            INSERT INTO passkey_credential(account_id, credentialid, publickey, aaguid, recovery_session_hash, recovery_request_hash)
            VALUES (1, 'first', 'pk', '{Guid.Empty}', '{RecoverySessionHash}', '{RecoveryRequestHash}');
            """);
        await Assert.ThrowsAnyAsync<Exception>(() => fixture.ExecuteAsync(connectionString, $"""
            INSERT INTO passkey_credential(account_id, credentialid, publickey, aaguid, recovery_session_hash, recovery_request_hash)
            VALUES (1, 'second', 'pk', '{Guid.Empty}', '{RecoverySessionHash}', '{new string('C', 64)}');
            """));
    }

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));

    private static int SeedAccount(SqlSugarClient db, int status, bool passkeyEnabled)
        => db.Insertable(new User
        {
            PublicHandle = $"recovery-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = status,
            PasskeyEnabled = passkeyEnabled,
            PrivacyInitializedAt = DateTime.UtcNow
        }).ExecuteReturnIdentity();

    private static void SeedCredential(SqlSugarClient db, int accountId, string credentialId, DateTime createdAt)
        => db.Insertable(Credential(accountId, credentialId, createdAt)).ExecuteCommand();

    private static PasskeyCredential Credential(int accountId, string credentialId, DateTime createdAt)
        => new()
        {
            AccountId = accountId,
            CredentialId = credentialId,
            PublicKey = $"public-key-{credentialId}",
            AaGuid = Guid.Empty.ToString(),
            CreatedAt = createdAt
        };

    private static PasskeyService CreateService(
        SqlSugarClient db,
        IFido2? fido = null,
        IUnifiedCache? suppliedCache = null)
    {
        IUnifiedCache cache = suppliedCache ?? Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));
        cache.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        return new PasskeyService(
            fido ?? Substitute.For<IFido2>(),
            db,
            cache,
            cache,
            cache,
            cache,
            cache,
            cache,
            Substitute.For<IUserSessionCommandService>(),
            Substitute.For<IMessageNotificationStreamPort>(),
            Substitute.For<IAuditEventService>(),
            NullLogger<PasskeyService>.Instance);
    }

    private static Task<RecoveryPasskeyRegistrationResult> StartTogetherAsync(
        Barrier barrier,
        Func<Task<RecoveryPasskeyRegistrationResult>> action)
        => Task.Run(async () =>
        {
            barrier.SignalAndWait(TimeSpan.FromSeconds(10));
            return await action();
        });
}
