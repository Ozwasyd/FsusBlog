using System.Buffers.Text;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
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
        var service = new PasskeyService(
            fido,
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
        return (service, request);
    }

    private static Task<int> InsertAccountAsync(SqlSugarClient db)
        => db.Insertable(new User
        {
            PublicHandle = $"registration-{Guid.NewGuid():N}"[..20],
            IdentityKind = "anonymous_account",
            PasskeyEnabled = false,
            PasskeyUserHandle = Base64Url.EncodeToString(Enumerable.Repeat((byte)1, 32).ToArray()),
            Status = 0
        }).ExecuteReturnIdentityAsync();
}
