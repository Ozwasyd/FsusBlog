using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AccountEnrollmentIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task FirstPasskey_ActivatesAccountAndCreatesFormalSessionAtomically_ThenReplaysSameResponse()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed seed = await SeedPendingEnrollmentAsync(db, "atomic-success");
        IAccountEnrollmentService service = CreateService(db, seed.AccountId, seed.CredentialId);

        AuthBinaryFlowResult first = await service.CompletePasskeyRegistrationAsync(
            seed.RawToken,
            seed.Request,
            new AuthBinaryClientContext("127.0.0.1", "device-a", "integration-test"));

        Assert.True(first.Success, first.Error.Message);
        Assert.Equal("authenticated", first.Flow.AuthPhase);
        Assert.NotNull(first.SessionTokens);
        User account = await db.Queryable<User>().InSingleAsync(seed.AccountId);
        Assert.Equal(AccountRegistrationStates.Active, account.RegistrationState);
        Assert.True(account.PasskeyEnabled);
        Assert.False(string.IsNullOrWhiteSpace(account.PasskeyUserHandle));
        Assert.Equal(1, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == seed.AccountId));
        Assert.Equal(1, await db.Queryable<UserSession>().CountAsync(item => item.UserId == seed.AccountId));

        AuthBinaryFlowResult replay = await service.CompletePasskeyRegistrationAsync(
            seed.RawToken,
            seed.Request,
            new AuthBinaryClientContext("127.0.0.1", "device-a", "integration-test"));

        Assert.True(replay.Success, replay.Error.Message);
        Assert.Equal(first.SessionTokens.Value.SessionId, replay.SessionTokens!.Value.SessionId);
        Assert.Equal(first.SessionTokens.Value.RefreshToken, replay.SessionTokens.Value.RefreshToken);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == seed.AccountId));
        Assert.Equal(1, await db.Queryable<UserSession>().CountAsync(item => item.UserId == seed.AccountId));
    }

    [Fact]
    public async Task CompletedEnrollment_RejectsDifferentAttestationWithoutCreatingSecondCredentialOrSession()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed seed = await SeedPendingEnrollmentAsync(db, "different-replay");
        IAccountEnrollmentService service = CreateService(db, seed.AccountId, seed.CredentialId);
        AuthBinaryFlowResult first = await service.CompletePasskeyRegistrationAsync(
            seed.RawToken,
            seed.Request,
            new AuthBinaryClientContext("127.0.0.1", null, null));
        Assert.True(first.Success, first.Error.Message);

        PasskeyRegisterCompleteCoreModel different = seed.Request with
        {
            FriendlyName = "another-tab"
        };
        AuthBinaryFlowResult conflict = await service.CompletePasskeyRegistrationAsync(
            seed.RawToken,
            different,
            new AuthBinaryClientContext("127.0.0.1", null, null));

        Assert.False(conflict.Success);
        Assert.Equal(ErrorCode.Conflict, conflict.Error.Code);
        Assert.Equal(1, await db.Queryable<PasskeyCredential>().CountAsync(item => item.AccountId == seed.AccountId));
        Assert.Equal(1, await db.Queryable<UserSession>().CountAsync(item => item.UserId == seed.AccountId));
    }

    [Fact]
    public async Task ExpiryCleanup_DeletesOnlyProvisionalAccountAndNeverActiveAccount()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed expired = await SeedPendingEnrollmentAsync(db, "expired", DateTime.UtcNow.AddMinutes(-1));
        Seed active = await SeedPendingEnrollmentAsync(db, "active", DateTime.UtcNow.AddMinutes(-1));
        await db.Updateable<User>()
            .Where(item => item.Id == active.AccountId)
            .SetColumns(item => item.RegistrationState == AccountRegistrationStates.Active)
            .ExecuteCommandAsync();

        IAccountEnrollmentService service = CreateService(db, expired.AccountId, expired.CredentialId);
        int removed = await service.CleanupExpiredAsync();

        Assert.True(removed >= 2);
        Assert.Null(await db.Queryable<User>().InSingleAsync(expired.AccountId));
        Assert.NotNull(await db.Queryable<User>().InSingleAsync(active.AccountId));
        Assert.Equal(AccountRegistrationStates.Active, (await db.Queryable<User>().InSingleAsync(active.AccountId))!.RegistrationState);
    }

    private async Task<SqlSugarClient> CreateDbAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(PasskeyCredential),
            typeof(AccountEnrollmentSession));
        return db;
    }

    private static async Task<Seed> SeedPendingEnrollmentAsync(
        SqlSugarClient db,
        string suffix,
        DateTime? expiresAt = null)
    {
        string uniqueness = Guid.NewGuid().ToString("N");
        var account = new User
        {
            PublicHandle = $"enrollment-{suffix}-{uniqueness}"[..Math.Min(64, $"enrollment-{suffix}-{uniqueness}".Length)],
            IdentityKind = "anonymous_account",
            AccountSubjectHash = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(uniqueness))),
            RegistrationState = AccountRegistrationStates.Provisional,
            AnonymousCredentialStatus = "active",
            AnonymousCredentialLevel = "basic",
            Status = 0,
            CreateTime = DateTime.UtcNow
        };
        int accountId = await db.Insertable(account).ExecuteReturnIdentityAsync();
        string rawToken = $"enrollment-token-{uniqueness}";
        string challenge = $"challenge-{uniqueness}";
        await db.Insertable(new AccountEnrollmentSession
        {
            TokenHash = AnonymousAccountBootstrapService.HashEnrollmentToken(rawToken),
            AccountId = accountId,
            State = AccountEnrollmentStates.Pending,
            PasskeyUserHandle = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
            RegistrationChallengeKey = challenge,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = expiresAt ?? DateTime.UtcNow.AddMinutes(20)
        }).ExecuteCommandAsync();
        return new Seed(
            accountId,
            rawToken,
            $"credential-{uniqueness}",
            new PasskeyRegisterCompleteCoreModel
            {
                SessionKey = challenge,
                Id = $"credential-{uniqueness}",
                RawId = [1, 2, 3],
                ClientDataBytes = [4, 5, 6],
                AttestationObject = [7, 8, 9],
                Transports = []
            });
    }

    private static IAccountEnrollmentService CreateService(SqlSugarClient db, int accountId, string credentialId)
    {
        IPasskeyService passkeys = Substitute.For<IPasskeyService>();
        passkeys.ValidateEnrollmentRegistrationAsync(
                accountId,
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(PasskeyRegistrationValidationResult.Accepted(new PasskeyCredential
            {
                AccountId = accountId,
                CredentialId = credentialId,
                PublicKey = "AQID",
                AaGuid = Guid.Empty.ToString(),
                CreatedAt = DateTime.UtcNow
            })));

        var settings = Options.Create(new JwtSettings
        {
            KeyVersion = "test-k1",
            SecretKey = "account-enrollment-test-signing-key-at-least-32-bytes",
            Issuer = "FsusBlog.Tests",
            Audience = "FsusBlog.Tests",
            AccessTokenExpiresMinutes = 15
        });
        return new AccountEnrollmentService(
            db,
            passkeys,
            new JwtHelper(settings),
            Substitute.For<ICacheCounterStore>(),
            Substitute.For<ICacheInvalidationStore>(),
            new EphemeralDataProtectionProvider(),
            NullLogger<AccountEnrollmentService>.Instance);
    }

    private sealed record Seed(
        int AccountId,
        string RawToken,
        string CredentialId,
        PasskeyRegisterCompleteCoreModel Request);
}
