using System.Buffers.Binary;
using System.Buffers.Text;

using Fido2NetLib;
using Fido2NetLib.Exceptions;
using Fido2NetLib.Objects;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
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
    public async Task VerifiedCounterRollback_RevokesAllSessionsBumpsSnapshotAuditsAndNotifies()
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<VerifyAssertionResult>(
                new Fido2VerificationException(
                    Fido2ErrorCode.InvalidSignCount,
                    "signature counter rollback")));
        await using TestHarness harness = await CreateHarnessAsync(fido, "rollback");

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, actualSignCount: 7),
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Null(result.User);
        Assert.Contains("重新认证", result.Message, StringComparison.Ordinal);
        await harness.Sessions.Received(1).RevokeAllSessionsAsync(
            harness.AccountId,
            "passkey_counter_rollback",
            Arg.Any<CancellationToken>());
        await harness.Cache.Received(1).IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            harness.AccountId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            1,
            Arg.Any<CancellationToken>());
        await harness.NotificationStream.Received(1).PublishToUserAsync(
            NotificationStreamEventType.SessionRevoked,
            harness.AccountId,
            Arg.Is<SessionRevokedPayload>(payload =>
                payload.reason == "passkey_counter_rollback"
                && payload.revokedSessionCount == 2),
            "passkey-counter-rollback-session-revoked");
        await harness.AuditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(audit =>
                audit.Action == AuditActionCatalog.PasskeyCounterRollback
                && audit.ReasonCode == "passkey_counter_rollback"
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

    [Fact]
    public async Task VerifiedZeroCounterAgainstStoredCounter_AlsoRevokesAllSessions()
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new VerifyAssertionResult
            {
                CredentialId = [1, 2, 3],
                SignCount = 0,
                IsBackedUp = false
            }));
        await using TestHarness harness = await CreateHarnessAsync(fido, "zero");

        var result = await harness.Service.CompleteAssertionAsync(
            CreateRequest(harness.CredentialId, actualSignCount: 0),
            CancellationToken.None);

        Assert.False(result.Success);
        Assert.Contains("重新认证", result.Message, StringComparison.Ordinal);
        await harness.Sessions.Received(1).RevokeAllSessionsAsync(
            harness.AccountId,
            "passkey_counter_rollback",
            Arg.Any<CancellationToken>());
    }

    private async Task<TestHarness> CreateHarnessAsync(IFido2 fido, string suffix)
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
            SignCount = 10,
            AaGuid = Guid.Empty.ToString()
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
        cache.RemoveAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        cache.IncrementAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));

        IUserSessionCommandService sessions = Substitute.For<IUserSessionCommandService>();
        sessions.RevokeAllSessionsAsync(accountId, "passkey_counter_rollback", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(2));
        IMessageNotificationStreamPort notificationStream = Substitute.For<IMessageNotificationStreamPort>();
        IAuditEventService auditEvents = Substitute.For<IAuditEventService>();
        var service = new PasskeyService(
            fido,
            db,
            cache,
            sessions,
            notificationStream,
            auditEvents,
            NullLogger<PasskeyService>.Instance);
        return new TestHarness(
            db,
            accountId,
            credentialId,
            service,
            cache,
            sessions,
            notificationStream,
            auditEvents);
    }

    private static PasskeyLoginCompleteCoreModel CreateRequest(string credentialId, uint actualSignCount)
    {
        byte[] authenticatorData = new byte[37];
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
