using System.Buffers.Binary;
using System.Buffers.Text;

using Fido2NetLib;
using Fido2NetLib.Exceptions;
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
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class PasskeyCounterRollbackIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ExplicitAccountCompromisePolicy_RevokesAllSessionsBumpsSnapshotAuditsAndNotifies()
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<VerifyAssertionResult>(
                new Fido2VerificationException(
                    Fido2ErrorCode.InvalidSignCount,
                    "signature counter rollback")));
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            "rollback",
            responseAction: "revoke_account_sessions");

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, actualSignCount: 7),
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Null(result.User);
        Assert.Contains("重新认证", result.Message, StringComparison.Ordinal);
        await harness.Sessions.Received(1).RevokeAllSessionsAsync(
            harness.AccountId,
            "passkey_counter_non_monotonic",
            Arg.Any<CancellationToken>());
        await harness.AccountStates.Received(1).ProjectCommittedMutationAsync(
            harness.AccountId,
            Arg.Any<CancellationToken>());
        await harness.NotificationStream.Received(1).PublishToUserAsync(
            NotificationStreamEventType.SessionRevoked,
            harness.AccountId,
            Arg.Is<SessionRevokedPayload>(payload =>
                payload.reason == "passkey_counter_non_monotonic"
                && payload.revokedSessionCount == 2),
            "passkey-counter-risk-session-revoked");
        await harness.AuditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(audit =>
                audit.Action == AuditActionCatalog.PasskeyCounterRollback
                && audit.ReasonCode == "passkey_counter_non_monotonic"
                && Equals(audit.Context!["responseAction"], "revoke_account_sessions")
                && audit.IsHighValue),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task InvalidSignature_DoesNotRevokeExistingSessions()
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<VerifyAssertionResult>(
                new Fido2VerificationException(
                    Fido2ErrorCode.InvalidSignature,
                    "invalid signature")));
        await using TestHarness harness = await CreateHarnessAsync(fido, "forged");

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, actualSignCount: 7),
            CancellationToken.None);

        Assert.False(result.Success);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
        await harness.NotificationStream.DidNotReceiveWithAnyArgs().PublishToUserAsync(
            default,
            default,
            default(SessionRevokedPayload),
            default!);
        await harness.AuditEvents.DidNotReceiveWithAnyArgs().RecordHighValueAsync(default!, default);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(9)]
    [InlineData(10)]
    public async Task NonMonotonicCounter_DefaultPolicyRejectsCredentialWithoutRevokingSessions(long actualSignCount)
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new VerifyAssertionResult
            {
                CredentialId = [1, 2, 3],
                SignCount = (uint)actualSignCount,
                IsBackedUp = false
            }));
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            $"risk-{actualSignCount}",
            responseAction: actualSignCount == 9 ? "unknown-action" : null);

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, (uint)actualSignCount),
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("重新认证", result.Message, StringComparison.Ordinal);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
        await harness.NotificationStream.DidNotReceiveWithAnyArgs().PublishToUserAsync(
            default,
            default,
            default(SessionRevokedPayload),
            default!);
        await harness.AuditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(audit =>
                audit.ReasonCode == "passkey_counter_non_monotonic"
                && Equals(audit.Context!["responseAction"], "reject_credential")
                && Equals(audit.Context["revokedSessionCount"], 0)),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UnsupportedZeroCounter_LoginSucceedsAndTouchesCredential()
    {
        IFido2 fido = InvalidSignCountFido();
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            "unsupported",
            storedSignCount: 0,
            backupEligible: true);

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(
                harness.CredentialId,
                actualSignCount: 0,
                backupEligible: true,
                backupState: true),
            CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.User);
        PasskeyCredential stored = await harness.Database.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == harness.CredentialId);
        Assert.Equal(0, stored.SignCount);
        Assert.NotNull(stored.LastUsedAt);
        Assert.True(stored.BackupEligible);
        Assert.True(stored.BackupState);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
        await harness.AuditEvents.DidNotReceiveWithAnyArgs().RecordHighValueAsync(default!, default);
    }

    [Fact]
    public async Task SuccessfulAssertion_AtomicallyRefreshesBackupFlagsAndLastUsedAt()
    {
        IFido2 fido = SuccessfulFido(actualSignCount: 11);
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            "backup-refresh",
            storedSignCount: 10,
            backupEligible: true);
        await harness.Database.Updateable<PasskeyCredential>()
            .SetColumns(credential => credential.BackupState == false)
            .Where(credential => credential.CredentialId == harness.CredentialId)
            .ExecuteCommandAsync();

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(
                harness.CredentialId,
                actualSignCount: 11,
                backupEligible: true,
                backupState: true),
            CancellationToken.None);

        Assert.True(result.Success);
        PasskeyCredential stored = await harness.Database.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == harness.CredentialId);
        Assert.Equal(11, stored.SignCount);
        Assert.NotNull(stored.LastUsedAt);
        Assert.True(stored.BackupEligible);
        Assert.True(stored.BackupState);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
    }

    [Theory]
    [InlineData(0, 4)]
    [InlineData(10, 11)]
    public async Task AdvancedCounter_LoginSucceedsAndPersistsMonotonicValue(
        long storedSignCount,
        long actualSignCount)
    {
        IFido2 fido = SuccessfulFido((uint)actualSignCount);
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            $"advanced-{storedSignCount}-{actualSignCount}",
            storedSignCount);

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, (uint)actualSignCount),
            CancellationToken.None);

        Assert.True(result.Success);
        PasskeyCredential stored = await harness.Database.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == harness.CredentialId);
        Assert.Equal(actualSignCount, stored.SignCount);
        Assert.NotNull(stored.LastUsedAt);
    }

    [Fact]
    public async Task UnsupportedZeroCounter_StepUpUsesSameSemanticsAsLogin()
    {
        IFido2 fido = InvalidSignCountFido();
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            "step-up-unsupported",
            storedSignCount: 0);

        var result = await harness.Service.CompleteStepUpAssertionAsync(
            harness.AccountId,
            CreateRequest(
                harness.CredentialId,
                actualSignCount: 0,
                backupEligible: true,
                backupState: true),
            CancellationToken.None);

        Assert.True(result.Success);
        PasskeyCredential stored = await harness.Database.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == harness.CredentialId);
        Assert.NotNull(stored.LastUsedAt);
        Assert.True(stored.BackupState);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
        await harness.AuditEvents.DidNotReceiveWithAnyArgs().RecordHighValueAsync(default!, default);
    }

    [Fact]
    public async Task CounterRisk_AuditFailureStillFailsClosedWithoutRevokingUnrelatedSessions()
    {
        IFido2 fido = SuccessfulFido(actualSignCount: 9);
        IAuditEventService auditEvents = Substitute.For<IAuditEventService>();
        auditEvents.RecordHighValueAsync(Arg.Any<AuditEvent>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("audit unavailable")));
        await using TestHarness harness = await CreateHarnessAsync(
            fido,
            "audit-failure",
            auditEvents: auditEvents);

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, actualSignCount: 9),
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("重新认证", result.Message, StringComparison.Ordinal);
        await harness.Sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
    }

    private static IFido2 InvalidSignCountFido()
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<VerifyAssertionResult>(
                new Fido2VerificationException(
                    Fido2ErrorCode.InvalidSignCount,
                    "signature counter unavailable")));
        return fido;
    }

    private static IFido2 SuccessfulFido(uint actualSignCount)
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new VerifyAssertionResult
            {
                CredentialId = [1, 2, 3],
                SignCount = actualSignCount,
                IsBackedUp = false
            }));
        return fido;
    }

    private async Task<TestHarness> CreateHarnessAsync(
        IFido2 fido,
        string suffix,
        long storedSignCount = 10,
        bool backupEligible = false,
        string? responseAction = null,
        IAuditEventService? auditEvents = null)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int accountId = await db.Insertable(new User
        {
            PublicHandle = $"passkey-{suffix}",
            IdentityKind = "anonymous_account",
            PasskeyEnabled = true,
            Status = 0
        }).ExecuteReturnIdentityAsync();
        string credentialId = $"credential-{suffix}-{Guid.NewGuid():N}";
        await db.Insertable(new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = credentialId,
            PublicKey = Base64Url.EncodeToString(new byte[] { 1, 2, 3, 4 }),
            SignCount = storedSignCount,
            AaGuid = Guid.Empty.ToString(),
            BackupEligible = backupEligible,
            BackupState = backupEligible
        }).ExecuteCommandAsync();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.TryGetAsync<PasskeyLoginBeginCoreModel>(
                CachePolicyId.SecurityPasskeyAuthChallenge,
                "challenge-token",
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyLoginBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyLoginBeginCoreModel>(
                true,
                new PasskeyLoginBeginCoreModel
                {
                    ChallengeToken = "challenge-token",
                    RpId = "localhost",
                    UserVerification = (int)UserVerificationRequirement.Required,
                    Challenge = [1, 2, 3]
                })));
        cache.ConsumeOnceAndGetAsync<PasskeyLoginBeginCoreModel>(
                CachePolicyId.SecurityPasskeyAuthChallenge,
                "stepup:challenge-token",
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyLoginBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyLoginBeginCoreModel>(
                true,
                new PasskeyLoginBeginCoreModel
                {
                    ChallengeToken = "challenge-token",
                    RpId = "localhost",
                    UserVerification = (int)UserVerificationRequirement.Required,
                    Challenge = [1, 2, 3]
                })));
        cache.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        cache.IncrementAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));

        IUserSessionCommandService sessions = Substitute.For<IUserSessionCommandService>();
        sessions.RevokeAllSessionsAsync(accountId, "passkey_counter_non_monotonic", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(2));
        IMessageNotificationStreamPort notificationStream = Substitute.For<IMessageNotificationStreamPort>();
        auditEvents ??= Substitute.For<IAuditEventService>();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(responseAction is null
                ? null
                : new Dictionary<string, string?>
                {
                    ["PasskeyCounterRisk:ResponseAction"] = responseAction
                })
            .Build();
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
            sessions,
            notificationStream,
            auditEvents,
            NullLogger<PasskeyService>.Instance,
            configuration);
        return new TestHarness(
            db,
            accountId,
            credentialId,
            service,
            cache,
            accountStates,
            sessions,
            notificationStream,
            auditEvents);
    }

    private static PasskeyLoginCompleteCoreModel CreateRequest(
        string credentialId,
        uint actualSignCount,
        bool backupEligible = false,
        bool backupState = false)
    {
        byte[] authenticatorData = new byte[37];
        authenticatorData[32] = (byte)((backupEligible ? (byte)AuthenticatorFlags.BE : 0)
            | (backupState ? (byte)AuthenticatorFlags.BS : 0));
        BinaryPrimitives.WriteUInt32BigEndian(authenticatorData.AsSpan(33, sizeof(uint)), actualSignCount);
        return new PasskeyLoginCompleteCoreModel
        {
            ChallengeToken = "challenge-token",
            Id = credentialId,
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AuthenticatorData = authenticatorData,
            Signature = [7, 8, 9]
        };
    }

    private sealed record TestHarness(
        SqlSugarClient Database,
        int AccountId,
        string CredentialId,
        PasskeyService Service,
        IUnifiedCache Cache,
        IAccountStateProjectionMutationPublisher AccountStates,
        IUserSessionCommandService Sessions,
        IMessageNotificationStreamPort NotificationStream,
        IAuditEventService AuditEvents) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            Database.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
