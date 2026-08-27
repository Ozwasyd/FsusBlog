using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AccountProfilePreferenceFixturePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompleteMatrix_UsesProductionCommandsAndIndependentPostgresReaders_ThenCleansOwnedState()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(UserSession),
            typeof(UserLocalePreference));
        string[] roles =
        [
            "preference-account-device-conflict",
            "preference-auto",
            "preference-device-explicit",
            "preference-fixed-default",
            "preference-fixed-non-default",
            "preference-revision-conflict",
            "preference-two-device",
            "profile-conflict-challenger",
            "profile-conflict-owner",
            "profile-empty",
            "profile-set"
        ];
        var identities = new List<AccountFixtureIdentityReference>();
        foreach (string role in roles)
        {
            int userId = await db.Insertable(new User
            {
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                AccountSubjectHash = Digest($"subject:{role}"),
                RegistrationState = AccountRegistrationStates.Active,
                Status = 0
            }).ExecuteReturnIdentityAsync();
            identities.Add(IdentityReference(
                role,
                userId,
                "profile-preference-postgres",
                "run-1717-postgres",
                "account-profile-preferences"));
        }

        ICacheCounterStore counters = Substitute.For<ICacheCounterStore>();
        counters.IncrementAsync(
                CachePolicyId.AccountSnapshotVersion,
                Arg.Any<string>(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(1L);
        NoopAccountCache cache = new();
        var profileCommands = new UserProfileCommandService(
            db,
            NullLogger<UserProfileCommandService>.Instance,
            Substitute.For<IBlacklistService>(),
            cache,
            counters,
            Substitute.For<IUserSessionValidationCache>());
        var accountReader = new UserAccountReader(db, cache, cache, cache, cache);
        var preferences = new UserLocalePreferenceService(
            db,
            NullLogger<UserLocalePreferenceService>.Instance);
        var preferenceCommands = new AccountPreferenceFixtureCommand(preferences);
        var service = new AccountProfilePreferenceFixtureService(
            profileCommands,
            accountReader,
            preferenceCommands,
            preferences,
            new LocaleResolver(),
            new AccountProfilePreferenceFixtureStateReader(db));
        var request = new AccountProfilePreferenceFixtureRequest(
            AccountProfilePreferenceFixtureCapabilities.All.Order(StringComparer.Ordinal).ToArray(),
            "profile-preference-postgres",
            "run-1717-postgres",
            "account-profile-preferences",
            "fxacct:profile-preference-postgres:run-1717-postgres",
            identities,
            ResolvedTemporalRoles: TemporalArtifact());

        AccountProfilePreferenceFixtureResult result = await service.PrepareAsync(request);
        AccountProfilePreferenceFixtureVerification verification = await service.VerifyAsync(result);

        Assert.True(verification.Ok, verification.Failure);
        Assert.Equal(10, result.Observations.Database.Entities.Count);
        Assert.Equal(7, await db.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(2, await db.Queryable<User>().CountAsync(user => user.PublicHandle != null));
        Assert.All(result.Observations.Database.Entities, entity =>
            Assert.Equal(true, entity.Fields["securityStateUnchanged"]));

        await service.CleanupAsync(result);

        Assert.Equal(0, await db.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(0, await db.Queryable<User>().CountAsync(user => user.PublicHandle != null));
    }

    private static string Digest(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static AccountFixtureIdentityReference IdentityReference(
        string role,
        int userId,
        string fixtureNamespace,
        string runId,
        string profileId)
    {
        var planDigests = new AccountFixtureIdentityPlanDigests(
            Digest("auth-plan"),
            Digest("catalog"),
            Digest("fixture-plan"),
            Digest("producer-plan"));
        var reference = new AccountFixtureIdentityReference(
            "fsusblog.fixture-identity-prepare-reference.v1",
            false,
            "auth-session",
            "account-profile-preferences",
            runId,
            fixtureNamespace,
            profileId,
            role,
            $"consumer.account-profile-preferences.{role}",
            "auth.user.active",
            userId.ToString(CultureInfo.InvariantCulture),
            $"fxauth-{Digest($"fixture:{role}")[..24]}",
            Digest("producer-result"),
            planDigests,
            string.Empty);
        return reference with
        {
            Digest = IdentityReferenceDigest(reference)
        };
    }

    private static string IdentityReferenceDigest(AccountFixtureIdentityReference identity)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = identity.Schema,
            verified = identity.Verified,
            ownerProducerId = identity.OwnerProducerId,
            consumerProducerId = identity.ConsumerProducerId,
            runId = identity.RunId,
            @namespace = identity.Namespace,
            profileId = identity.ProfileId,
            role = identity.Role,
            semanticRole = identity.SemanticRole,
            capabilityId = identity.CapabilityId,
            publicId = identity.PublicId,
            fixtureIdentity = identity.FixtureIdentity,
            producerResultDigest = identity.ProducerResultDigest,
            planDigests = new
            {
                authSessionPlanDigest = identity.PlanDigests.AuthSessionPlanDigest,
                catalogDigest = identity.PlanDigests.CatalogDigest,
                fixtureVariantPlanDigest = identity.PlanDigests.FixtureVariantPlanDigest,
                producerVariantPlanDigest = identity.PlanDigests.ProducerVariantPlanDigest
            }
        })));

    private static JsonElement TemporalArtifact()
        => JsonSerializer.SerializeToElement(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "account-profile-preferences",
                schedulerRunId = "run-1717-postgres"
            },
            roles = new[]
            {
                Role("profile.updated", "2024-03-01T00:00:59.000Z"),
                Role("preference.revision", "2024-03-01T00:01:59.000Z"),
                Role("preference.conflict", "2024-03-01T00:01:59.000Z"),
                Role("preference.device-sync", "2024-03-01T00:02:59.000Z")
            },
            contentDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });

    private static object Role(string roleId, string instantUtc)
        => new
        {
            roleId,
            clockKind = "business-wall",
            semanticEffect = "included",
            precision = "millisecond",
            instantUtc
        };

    private sealed class NoopAccountCache :
        ICacheTypedReader,
        ICacheRawWriter,
        ICacheStringReader,
        ICacheInvalidationStore
    {
        public Task<CacheReadResult<T>> TryGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task<string?> GetStringAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetNegativeAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveManyAsync(
            IReadOnlyList<CacheKeyIdentity> keys,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(
            CachePolicyId policyId,
            string identityPrefix,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(
            IReadOnlyList<CachePrefixIdentity> prefixes,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }
}
