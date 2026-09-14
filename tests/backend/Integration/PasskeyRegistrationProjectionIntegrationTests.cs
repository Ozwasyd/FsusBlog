using System.Buffers.Text;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "Concurrency")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class PasskeyRegistrationProjectionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Registration_CommitsCredentialMetadataAndEnabledProjectionTogether()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertAccountAsync(db);
        (PasskeyService service, PasskeyRegisterCompleteCoreModel request) = CreateService(db, accountId, "commit");

        var result = await service.CompleteRegistrationAsync(accountId, request);

        Assert.True(result.Success);
        Assert.NotNull(result.SignalState);
        Assert.Single(result.SignalState.Value.AllAcceptedCredentialIds);
        User account = await db.Queryable<User>().SingleAsync(item => item.Id == accountId);
        PasskeyCredential credential = await db.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.AccountId == accountId);
        Assert.True(account.PasskeyEnabled);
        Assert.Equal(1, account.PasskeySignalVersion);
        Assert.True(credential.BackupEligible);
        Assert.True(credential.BackupState);
    }

    [Fact]
    public async Task Registration_ProjectionWriteFailureRollsBackCredentialInsert()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertAccountAsync(db);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE OR REPLACE FUNCTION reject_passkey_projection_for_test()
            RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'projection rejected';
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER reject_passkey_projection_for_test
            BEFORE UPDATE OF passkey_enabled ON sys_user
            FOR EACH ROW
            EXECUTE FUNCTION reject_passkey_projection_for_test();
            """);
        (PasskeyService service, PasskeyRegisterCompleteCoreModel request) = CreateService(db, accountId, "rollback");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.CompleteRegistrationAsync(accountId, request));

        Assert.Equal(0, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == accountId));
        Assert.False((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
    }

    [Fact]
    public async Task Registration_ConcurrentCapacityCompletionPersistsExactlyOneAndDoesNotSerializeOtherAccount()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertAccountAsync(
            setupDb,
            passkeyEnabled: true,
            passkeySignalVersion: PasskeyService.MaxCredentialsPerUser - 1);
        int otherAccountId = await InsertAccountAsync(setupDb);
        await SeedCredentialsAsync(setupDb, accountId, PasskeyService.MaxCredentialsPerUser - 1, "capacity-seed");

        string applicationPrefix = $"issue2331-cap-{Guid.NewGuid():N}"[..40];
        IUnifiedCache cache = CreateRegistrationCache();
        SqlSugarClient[] clients =
        [
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, $"{applicationPrefix}-a")),
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, $"{applicationPrefix}-b")),
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, $"issue2331-other-{Guid.NewGuid():N}"))
        ];
        RegistrationFixture[] targetRegistrations =
        [
            CreateRegistration(clients[0], cache, accountId, "capacity-a", [0xA1, 0x01]),
            CreateRegistration(clients[1], cache, accountId, "capacity-b", [0xA1, 0x02])
        ];
        RegistrationFixture otherRegistration =
            CreateRegistration(clients[2], cache, otherAccountId, "other-account", [0xB1, 0x01]);

        try
        {
            await using var holder = new NpgsqlConnection(connectionString);
            await holder.OpenAsync();
            await using NpgsqlTransaction holderTransaction = await holder.BeginTransactionAsync();
            await LockAccountRowAsync(holder, holderTransaction, accountId);

            using var barrier = new Barrier(3);
            Task<(bool Success, string Message, PasskeySignalStateDto? SignalState)>[] targetTasks =
            [
                StartTogetherAsync(barrier, () => targetRegistrations[0].Service.CompleteRegistrationAsync(
                    accountId,
                    targetRegistrations[0].Request)),
                StartTogetherAsync(barrier, () => targetRegistrations[1].Service.CompleteRegistrationAsync(
                    accountId,
                    targetRegistrations[1].Request))
            ];
            Task<(bool Success, string Message, PasskeySignalStateDto? SignalState)> otherTask =
                StartTogetherAsync(barrier, () => otherRegistration.Service.CompleteRegistrationAsync(
                    otherAccountId,
                    otherRegistration.Request));
            (bool Success, string Message, PasskeySignalStateDto? SignalState) otherResult = default;

            bool holderCommitted = false;
            try
            {
                await WaitForAccountLockWaitersAsync(connectionString, applicationPrefix, expectedCount: 2);
                otherResult = await otherTask.WaitAsync(TimeSpan.FromSeconds(30));
                Assert.True(otherResult.Success);
                Assert.NotNull(otherResult.SignalState);
                Assert.All(targetTasks, static task => Assert.False(task.IsCompleted));

                await holderTransaction.CommitAsync();
                holderCommitted = true;
            }
            finally
            {
                if (!holderCommitted)
                {
                    await holderTransaction.RollbackAsync();
                }
            }

            var targetResults = await Task.WhenAll(targetTasks).WaitAsync(TimeSpan.FromSeconds(30));
            var winner = Assert.Single(targetResults, static result => result.Success);
            var loser = Assert.Single(targetResults, static result => !result.Success);
            Assert.NotNull(winner.SignalState);
            Assert.Null(loser.SignalState);
            Assert.Equal(
                $"已达到 {PasskeyService.MaxCredentialsPerUser} 枚通行密钥上限",
                loser.Message);

            List<PasskeyCredential> stored = await setupDb.Queryable<PasskeyCredential>()
                .Where(credential => credential.AccountId == accountId)
                .OrderBy(credential => credential.Id)
                .ToListAsync();
            Assert.Equal(PasskeyService.MaxCredentialsPerUser, stored.Count);
            Assert.Equal(stored.Count, stored.Select(static credential => credential.CredentialId).Distinct().Count());
            Assert.Equal(
                stored.Select(static credential => credential.CredentialId),
                winner.SignalState.Value.AllAcceptedCredentialIds);
            Assert.Equal(
                PasskeyService.MaxCredentialsPerUser,
                (await targetRegistrations[0].Service.GetCredentialsAsync(accountId)).Count);

            PasskeySignalStateDto? readModel = await targetRegistrations[0].Service.GetSignalStateAsync(accountId);
            Assert.NotNull(readModel);
            Assert.Equal(PasskeyService.MaxCredentialsPerUser, readModel.Value.Revision);
            Assert.Equal(
                stored.Select(static credential => credential.CredentialId),
                readModel.Value.AllAcceptedCredentialIds);
            User account = await setupDb.Queryable<User>().SingleAsync(user => user.Id == accountId);
            Assert.True(account.PasskeyEnabled);
            Assert.Equal(PasskeyService.MaxCredentialsPerUser, account.PasskeySignalVersion);
            PasskeyCredential otherStored = await setupDb.Queryable<PasskeyCredential>()
                .SingleAsync(credential => credential.AccountId == otherAccountId);
            User otherAccount = await setupDb.Queryable<User>().SingleAsync(user => user.Id == otherAccountId);
            Assert.True(otherAccount.PasskeyEnabled);
            Assert.Equal(1, otherAccount.PasskeySignalVersion);
            Assert.NotNull(otherResult.SignalState);
            Assert.Equal([otherStored.CredentialId], otherResult.SignalState.Value.AllAcceptedCredentialIds);
            Assert.Single(await otherRegistration.Service.GetCredentialsAsync(otherAccountId));
            PasskeySignalStateDto? otherReadModel =
                await otherRegistration.Service.GetSignalStateAsync(otherAccountId);
            Assert.NotNull(otherReadModel);
            Assert.Equal(otherResult.SignalState.Value.Revision, otherReadModel.Value.Revision);
            Assert.Equal(
                otherResult.SignalState.Value.AllAcceptedCredentialIds,
                otherReadModel.Value.AllAcceptedCredentialIds);

            int winnerIndex = Array.FindIndex(targetResults, static result => result.Success);
            int loserIndex = 1 - winnerIndex;
            await targetRegistrations[winnerIndex].AccountStates.Received(1)
                .ProjectCommittedMutationAsync(accountId, Arg.Any<CancellationToken>());
            await targetRegistrations[loserIndex].AccountStates.DidNotReceive()
                .ProjectCommittedMutationAsync(accountId, Arg.Any<CancellationToken>());
            await otherRegistration.AccountStates.Received(1)
                .ProjectCommittedMutationAsync(otherAccountId, Arg.Any<CancellationToken>());
            await cache.Received(1).RemoveAsync(
                CachePolicyId.SecurityPasskeyRegChallenge,
                targetRegistrations[winnerIndex].Request.SessionKey,
                Arg.Any<CancellationToken>());
            await cache.DidNotReceive().RemoveAsync(
                CachePolicyId.SecurityPasskeyRegChallenge,
                targetRegistrations[loserIndex].Request.SessionKey,
                Arg.Any<CancellationToken>());
            await cache.Received(1).RemoveAsync(
                CachePolicyId.SecurityPasskeyRegChallenge,
                otherRegistration.Request.SessionKey,
                Arg.Any<CancellationToken>());
            Assert.All(targetRegistrations, static registration =>
                registration.Fido.Received(1).MakeNewCredentialAsync(
                    Arg.Any<MakeNewCredentialParams>(),
                    Arg.Any<CancellationToken>()));
        }
        finally
        {
            foreach (SqlSugarClient client in clients)
            {
                client.Dispose();
            }

            await DeleteAccountsAsync(setupDb, accountId, otherAccountId);
        }
    }

    [Fact]
    public async Task Registration_FullAccountRejectsEveryConcurrentCompletionWithoutSideEffects()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertAccountAsync(
            setupDb,
            passkeyEnabled: true,
            passkeySignalVersion: PasskeyService.MaxCredentialsPerUser);
        await SeedCredentialsAsync(setupDb, accountId, PasskeyService.MaxCredentialsPerUser, "full-seed");
        IUnifiedCache cache = CreateRegistrationCache();
        SqlSugarClient[] clients =
        [
            PostgresSqlSugarTestClient.Create(connectionString),
            PostgresSqlSugarTestClient.Create(connectionString)
        ];
        RegistrationFixture[] registrations =
        [
            CreateRegistration(clients[0], cache, accountId, "full-a", [0xC1, 0x01]),
            CreateRegistration(clients[1], cache, accountId, "full-b", [0xC1, 0x02])
        ];

        try
        {
            using var barrier = new Barrier(2);
            var results = await Task.WhenAll(
                StartTogetherAsync(barrier, () => registrations[0].Service.CompleteRegistrationAsync(
                    accountId,
                    registrations[0].Request)),
                StartTogetherAsync(barrier, () => registrations[1].Service.CompleteRegistrationAsync(
                    accountId,
                    registrations[1].Request)));

            Assert.All(results, result =>
            {
                Assert.False(result.Success);
                Assert.Equal(
                    $"已达到 {PasskeyService.MaxCredentialsPerUser} 枚通行密钥上限",
                    result.Message);
                Assert.Null(result.SignalState);
            });
            Assert.Equal(
                PasskeyService.MaxCredentialsPerUser,
                await setupDb.Queryable<PasskeyCredential>().CountAsync(credential => credential.AccountId == accountId));
            User account = await setupDb.Queryable<User>().SingleAsync(user => user.Id == accountId);
            Assert.True(account.PasskeyEnabled);
            Assert.Equal(PasskeyService.MaxCredentialsPerUser, account.PasskeySignalVersion);
            Assert.All(registrations, static registration =>
                registration.Fido.DidNotReceive().MakeNewCredentialAsync(
                    Arg.Any<MakeNewCredentialParams>(),
                    Arg.Any<CancellationToken>()));
            await cache.DidNotReceiveWithAnyArgs().IncrementAsync(default, default!, default, default);
            await cache.DidNotReceiveWithAnyArgs().RemoveAsync(default, (string)null!, default);
        }
        finally
        {
            foreach (SqlSugarClient client in clients)
            {
                client.Dispose();
            }

            await DeleteAccountsAsync(setupDb, accountId);
        }
    }

    [Fact]
    public async Task Registration_ConcurrentDuplicateCredentialReturnsVerificationConflictDistinctFromCapacity()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertAccountAsync(
            setupDb,
            passkeyEnabled: true,
            passkeySignalVersion: 1);
        await SeedCredentialsAsync(setupDb, accountId, count: 1, "unique-seed");

        string applicationPrefix = $"issue2331-unique-{Guid.NewGuid():N}"[..43];
        IUnifiedCache cache = CreateRegistrationCache();
        using SqlSugarClient firstDb =
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, $"{applicationPrefix}-a"));
        using SqlSugarClient secondDb =
            PostgresSqlSugarTestClient.Create(WithApplicationName(connectionString, $"{applicationPrefix}-b"));
        byte[] duplicateCredentialId = [0xD1, 0x01];
        RegistrationFixture[] registrations =
        [
            CreateRegistration(firstDb, cache, accountId, "unique-a", duplicateCredentialId),
            CreateRegistration(secondDb, cache, accountId, "unique-b", duplicateCredentialId)
        ];

        try
        {
            await using var holder = new NpgsqlConnection(connectionString);
            await holder.OpenAsync();
            await using NpgsqlTransaction holderTransaction = await holder.BeginTransactionAsync();
            await LockAccountRowAsync(holder, holderTransaction, accountId);
            using var barrier = new Barrier(2);
            Task<(bool Success, string Message, PasskeySignalStateDto? SignalState)>[] tasks =
            [
                StartTogetherAsync(barrier, () => registrations[0].Service.CompleteRegistrationAsync(
                    accountId,
                    registrations[0].Request)),
                StartTogetherAsync(barrier, () => registrations[1].Service.CompleteRegistrationAsync(
                    accountId,
                    registrations[1].Request))
            ];

            bool holderCommitted = false;
            try
            {
                await WaitForAccountLockWaitersAsync(connectionString, applicationPrefix, expectedCount: 2);
                await holderTransaction.CommitAsync();
                holderCommitted = true;
            }
            finally
            {
                if (!holderCommitted)
                {
                    await holderTransaction.RollbackAsync();
                }
            }

            var results = await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Single(results, static result => result.Success);
            var conflict = Assert.Single(results, static result => !result.Success);
            Assert.Equal("通行密钥验证失败，请重试", conflict.Message);
            Assert.NotEqual(
                $"已达到 {PasskeyService.MaxCredentialsPerUser} 枚通行密钥上限",
                conflict.Message);
            Assert.Null(conflict.SignalState);

            List<PasskeyCredential> stored = await setupDb.Queryable<PasskeyCredential>()
                .Where(credential => credential.AccountId == accountId)
                .ToListAsync();
            Assert.Equal(2, stored.Count);
            Assert.Equal(2, stored.Select(static credential => credential.CredentialId).Distinct().Count());
            Assert.Equal(2, (await setupDb.Queryable<User>().SingleAsync(user => user.Id == accountId)).PasskeySignalVersion);
            int winnerIndex = Array.FindIndex(results, static result => result.Success);
            int conflictIndex = 1 - winnerIndex;
            await registrations[winnerIndex].AccountStates.Received(1)
                .ProjectCommittedMutationAsync(accountId, Arg.Any<CancellationToken>());
            await registrations[conflictIndex].AccountStates.DidNotReceive()
                .ProjectCommittedMutationAsync(accountId, Arg.Any<CancellationToken>());
            await cache.Received(1).RemoveAsync(
                CachePolicyId.SecurityPasskeyRegChallenge,
                registrations[winnerIndex].Request.SessionKey,
                Arg.Any<CancellationToken>());
            await cache.DidNotReceive().RemoveAsync(
                CachePolicyId.SecurityPasskeyRegChallenge,
                registrations[conflictIndex].Request.SessionKey,
                Arg.Any<CancellationToken>());
            Assert.All(registrations, static registration =>
                registration.Fido.Received(1).MakeNewCredentialAsync(
                    Arg.Any<MakeNewCredentialParams>(),
                    Arg.Any<CancellationToken>()));
        }
        finally
        {
            await DeleteAccountsAsync(setupDb, accountId);
        }
    }

    private static (PasskeyService Service, PasskeyRegisterCompleteCoreModel Request) CreateService(
        SqlSugarClient db,
        int accountId,
        string suffix)
    {
        string sessionKey = $"registration-{suffix}";
        var options = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = sessionKey,
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
        var request = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = sessionKey,
            Id = $"credential-{suffix}",
            RawId = [9, 10],
            ClientDataBytes = [11, 12],
            AttestationObject = [13, 14]
        };
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeNewCredentialAsync(
                Arg.Any<MakeNewCredentialParams>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new RegisteredPublicKeyCredential
            {
                Id = [21, 22, 23],
                PublicKey = [31, 32, 33],
                SignCount = 0,
                IsBackupEligible = true,
                IsBackedUp = true,
                Transports = []
            }));
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.TryGetAsync<PasskeyRegisterBeginCoreModel>(
                CachePolicyId.SecurityPasskeyRegChallenge,
                sessionKey,
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyRegisterBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyRegisterBeginCoreModel>(true, options)));
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
        var accountStates = Substitute.For<IAccountStateProjectionMutationPublisher>();
        var service = new PasskeyService(
            fido,
            db,
            cache,
            cache,
            cache,
            cache,
            cache,
            accountStates,
            Substitute.For<IUserSessionCommandService>(),
            Substitute.For<IMessageNotificationStreamPort>(),
            Substitute.For<IAuditEventService>(),
            NullLogger<PasskeyService>.Instance);
        return (service, request);
    }

    private static RegistrationFixture CreateRegistration(
        SqlSugarClient db,
        IUnifiedCache cache,
        int accountId,
        string suffix,
        byte[] credentialId)
    {
        string sessionKey = $"registration-{suffix}-{Guid.NewGuid():N}";
        var options = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = sessionKey,
            Timeout = 60_000,
            RpId = "localhost",
            RpName = "FsusBlog",
            AccountName = "fsus-anonymous-account",
            AccountDisplayName = "Anonymous account",
            AccountHandle = Enumerable.Repeat((byte)(accountId % byte.MaxValue + 1), 32).ToArray(),
            Challenge = [5, 6, 7, 8],
            PubKeyCredParams = [],
            ExcludeCredentials = []
        };
        var request = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = sessionKey,
            Id = Base64Url.EncodeToString(credentialId),
            RawId = credentialId,
            ClientDataBytes = [11, 12],
            AttestationObject = [13, 14],
            FriendlyName = suffix
        };
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeNewCredentialAsync(
                Arg.Any<MakeNewCredentialParams>(),
                Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                MakeNewCredentialParams parameters = call.ArgAt<MakeNewCredentialParams>(0);
                CancellationToken cancellationToken = call.ArgAt<CancellationToken>(1);
                bool unique = await parameters.IsCredentialIdUniqueToUserCallback(
                    new IsCredentialIdUniqueToUserParams(
                        credentialId,
                        new Fido2User
                        {
                            Id = options.AccountHandle,
                            Name = options.AccountName,
                            DisplayName = options.AccountDisplayName
                        }),
                    cancellationToken);
                if (!unique)
                {
                    throw new InvalidOperationException("credential id is not unique");
                }

                return new RegisteredPublicKeyCredential
                {
                    Id = credentialId,
                    PublicKey = [31, 32, credentialId[^1]],
                    SignCount = 0,
                    IsBackupEligible = true,
                    IsBackedUp = true,
                    Transports = []
                };
            });
        cache.TryGetAsync<PasskeyRegisterBeginCoreModel>(
                CachePolicyId.SecurityPasskeyRegChallenge,
                sessionKey,
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyRegisterBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyRegisterBeginCoreModel>(true, options)));
        var accountStates = Substitute.For<IAccountStateProjectionMutationPublisher>();
        var service = new PasskeyService(
            fido,
            db,
            cache,
            cache,
            cache,
            cache,
            cache,
            accountStates,
            Substitute.For<IUserSessionCommandService>(),
            Substitute.For<IMessageNotificationStreamPort>(),
            Substitute.For<IAuditEventService>(),
            NullLogger<PasskeyService>.Instance);
        return new RegistrationFixture(service, request, fido, accountStates);
    }

    private static IUnifiedCache CreateRegistrationCache()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
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
        return cache;
    }

    private static Task<int> InsertAccountAsync(
        SqlSugarClient db,
        bool passkeyEnabled = false,
        long passkeySignalVersion = 0)
        => db.Insertable(new User
        {
            PublicHandle = $"registration-{Guid.NewGuid():N}"[..20],
            IdentityKind = "anonymous_account",
            PasskeyEnabled = passkeyEnabled,
            PasskeySignalVersion = passkeySignalVersion,
            PasskeyUserHandle = Base64Url.EncodeToString(Enumerable.Repeat((byte)1, 32).ToArray()),
            Status = 0
        }).ExecuteReturnIdentityAsync();

    private static async Task SeedCredentialsAsync(
        SqlSugarClient db,
        int accountId,
        int count,
        string prefix)
    {
        for (int index = 0; index < count; index++)
        {
            await db.Insertable(new PasskeyCredential
            {
                AccountId = accountId,
                CredentialId = Base64Url.EncodeToString([0x70, (byte)index, (byte)(accountId % byte.MaxValue)]),
                PublicKey = Base64Url.EncodeToString([0x71, (byte)index]),
                SignCount = 0,
                DeviceFriendlyName = $"{prefix}-{index}",
                AaGuid = Guid.Empty.ToString(),
                BackupEligible = true,
                BackupState = true,
                CreatedAt = DateTime.UtcNow.AddMinutes(-count + index)
            }).ExecuteCommandAsync();
        }
    }

    private static async Task LockAccountRowAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        int accountId)
    {
        await using var command = new NpgsqlCommand(
            "UPDATE sys_user SET passkey_signal_version = passkey_signal_version WHERE id = @account_id;",
            connection,
            transaction);
        command.Parameters.AddWithValue("account_id", accountId);
        Assert.Equal(1, await command.ExecuteNonQueryAsync());
    }

    private static async Task WaitForAccountLockWaitersAsync(
        string connectionString,
        string applicationPrefix,
        int expectedCount)
    {
        await using var observer = new NpgsqlConnection(connectionString);
        await observer.OpenAsync();
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            await using var command = new NpgsqlCommand(
                """
                SELECT COUNT(DISTINCT application_name)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND application_name LIKE @application_prefix
                  AND wait_event_type = 'Lock';
                """,
                observer);
            command.Parameters.AddWithValue("application_prefix", $"{applicationPrefix}%");
            if (Convert.ToInt32(await command.ExecuteScalarAsync(), System.Globalization.CultureInfo.InvariantCulture) >= expectedCount)
            {
                return;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(25));
        }

        throw new TimeoutException($"Expected {expectedCount} Passkey registration account-lock waiters.");
    }

    private static string WithApplicationName(string connectionString, string applicationName)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            ApplicationName = applicationName
        };
        return builder.ConnectionString;
    }

    private static async Task DeleteAccountsAsync(SqlSugarClient db, params int[] accountIds)
    {
        await db.Deleteable<PasskeyCredential>()
            .Where(credential => accountIds.Contains(credential.AccountId))
            .ExecuteCommandAsync();
        await db.Deleteable<User>()
            .Where(user => accountIds.Contains(user.Id))
            .ExecuteCommandAsync();
    }

    private static Task<T> StartTogetherAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent Passkey registration completions.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private sealed record RegistrationFixture(
        PasskeyService Service,
        PasskeyRegisterCompleteCoreModel Request,
        IFido2 Fido,
        IAccountStateProjectionMutationPublisher AccountStates);
}
