using System.Security.Cryptography;
using System.Text;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminSessionProjectionTests
{
    [Fact]
    public void Validate_CompiledBodyCallsCryptographicFixedTimeEquals()
    {
        MethodInfo validate = typeof(AdminSessionProjection).GetMethod(nameof(AdminSessionProjection.Validate))!;
        byte[] il = validate.GetMethodBody()!.GetILAsByteArray()!;
        bool callsFixedTimeEquals = false;
        for (int index = 0; index <= il.Length - 5; index++)
        {
            if (il[index] != 0x28)
            {
                continue;
            }
            int token = BitConverter.ToInt32(il, index + 1);
            try
            {
                MethodBase? called = validate.Module.ResolveMethod(token);
                if (called?.DeclaringType == typeof(CryptographicOperations)
                    && string.Equals(called.Name, nameof(CryptographicOperations.FixedTimeEquals), StringComparison.Ordinal))
                {
                    callsFixedTimeEquals = true;
                    break;
                }
            }
            catch (ArgumentException)
            {
            }
        }

        Assert.True(callsFixedTimeEquals);
    }

    private static readonly DateTimeOffset s_now = new(2026, 9, 13, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void StartsNotReady_AndUnknownOrLaggedProjectionFailsClosed()
    {
        var projection = CreateProjection();
        byte[] tokenHash = Hash("token");

        AdminSessionProjectionValidationResult cold = projection.Validate("sid-1", 1, tokenHash);
        Assert.False(cold.IsValid);
        Assert.Equal(AdminSessionProjectionReasons.NotReady, cold.Reason);
        Assert.Equal(AdminSessionProjectionSources.None, cold.Source);

        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(Session("sid-1", 1, tokenHash)).Status);
        Assert.False(projection.MarkReady(authorityGeneration: 2));
        Assert.Equal(AdminSessionProjectionReasons.NotReady, projection.Validate("sid-1", 1, tokenHash).Reason);

        Assert.True(projection.MarkReady(authorityGeneration: 1));
        AdminSessionProjectionValidationResult unknown = projection.Validate("missing", 1, tokenHash);
        Assert.False(unknown.IsValid);
        Assert.Equal(AdminSessionProjectionReasons.UnknownSession, unknown.Reason);
        Assert.Equal(AdminSessionProjectionSources.None, unknown.Source);
    }

    [Fact]
    public void Apply_EnforcesSessionPrincipalAndByteBudgetsWithoutEvictingActiveState()
    {
        byte[] tokenHash = Hash("token");
        var entryBounded = CreateProjection(maxSessions: 1, maxPrincipals: 1);
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, entryBounded.Apply(Session("sid-1", 1, tokenHash)).Status);
        Assert.True(entryBounded.MarkReady(1));

        AdminSessionProjectionApplyResult entryRejected = entryBounded.Apply(
            Session("sid-2", 2, tokenHash, version: 2, generation: 2, principalVersion: 2));

        Assert.Equal(AdminSessionProjectionApplyStatus.CapacityExceeded, entryRejected.Status);
        AdminSessionProjectionSnapshot entrySnapshot = entryBounded.Snapshot();
        Assert.False(entrySnapshot.IsReady);
        Assert.Equal(1, entrySnapshot.SessionEntries);
        Assert.Equal(1, entrySnapshot.PrincipalEntries);
        Assert.InRange(entrySnapshot.ResidentBytes, 1, entrySnapshot.MaxResidentBytes);

        var measuring = CreateProjection();
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, measuring.Apply(Session("sid-byte-budget", 1, tokenHash)).Status);
        long requiredBytes = measuring.Snapshot().ResidentBytes;
        var byteBounded = CreateProjection(maxBytes: requiredBytes - 1);

        AdminSessionProjectionApplyResult byteRejected = byteBounded.Apply(Session("sid-byte-budget", 1, tokenHash));

        Assert.Equal(AdminSessionProjectionApplyStatus.CapacityExceeded, byteRejected.Status);
        AdminSessionProjectionSnapshot byteSnapshot = byteBounded.Snapshot();
        Assert.False(byteSnapshot.IsReady);
        Assert.Equal(0, byteSnapshot.SessionEntries);
        Assert.Equal(0, byteSnapshot.PrincipalEntries);
        Assert.Equal(0, byteSnapshot.ResidentBytes);
    }

    [Fact]
    public void PrincipalVersion_RejectsStaleAndDuplicate_AndConflictingSameVersionMakesProjectionNotReady()
    {
        byte[] tokenHash = Hash("token");
        var projection = CreateProjection();
        Assert.Equal(
            AdminSessionProjectionApplyStatus.Applied,
            projection.Apply(Session("sid-1", 7, tokenHash, version: 10, generation: 10, principalVersion: 5)).Status);
        Assert.True(projection.MarkReady(10));

        var disabled = new AdminSessionProjectionPrincipalUpdate(
            7,
            AdminSessionProjectionPrincipalStatus.Disabled,
            Version: 6,
            Generation: 11);
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(disabled).Status);
        Assert.Equal(AdminSessionProjectionReasons.PrincipalInactive, projection.Validate("sid-1", 7, tokenHash).Reason);
        Assert.Equal(AdminSessionProjectionApplyStatus.Duplicate, projection.Apply(disabled).Status);

        var staleActive = new AdminSessionProjectionPrincipalUpdate(
            7,
            AdminSessionProjectionPrincipalStatus.Active,
            Version: 5,
            Generation: 12);
        Assert.Equal(AdminSessionProjectionApplyStatus.Stale, projection.Apply(staleActive).Status);
        Assert.Equal(AdminSessionProjectionReasons.PrincipalInactive, projection.Validate("sid-1", 7, tokenHash).Reason);

        var conflictingActive = disabled with
        {
            Status = AdminSessionProjectionPrincipalStatus.Active,
            Generation = 13
        };
        Assert.Equal(AdminSessionProjectionApplyStatus.Conflict, projection.Apply(conflictingActive).Status);
        Assert.False(projection.Snapshot().IsReady);
        Assert.Equal(AdminSessionProjectionReasons.NotReady, projection.Validate("sid-1", 7, tokenHash).Reason);
    }

    [Fact]
    public void SessionGeneration_AppliesDifferentEntitiesOutOfOrder_AndRejectsPerSessionStaleOrConflictingVersions()
    {
        byte[] tokenHash = Hash("token");
        var projection = CreateProjection();
        AdminSessionProjectionSessionUpdate laterGlobal = Session(
            "sid-b",
            2,
            tokenHash,
            version: 20,
            generation: 20,
            principalVersion: 20);
        AdminSessionProjectionSessionUpdate earlierGlobal = Session(
            "sid-a",
            1,
            tokenHash,
            version: 10,
            generation: 10,
            principalVersion: 10);

        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(laterGlobal).Status);
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(earlierGlobal).Status);
        Assert.Equal(20, projection.Snapshot().LastProcessedGeneration);
        Assert.Equal(AdminSessionProjectionApplyStatus.Duplicate, projection.Apply(earlierGlobal).Status);

        AdminSessionProjectionSessionUpdate newer = earlierGlobal with
        {
            Version = 11,
            Generation = 21,
            IdleExpiresAtUtc = s_now.AddMinutes(20)
        };
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(newer).Status);
        Assert.Equal(
            AdminSessionProjectionApplyStatus.Stale,
            projection.Apply(earlierGlobal with
            {
                Generation = 22
            }).Status);

        AdminSessionProjectionSessionUpdate conflict = newer with
        {
            AccessTokenHash = Hash("other-token"),
            Generation = 23
        };
        Assert.Equal(AdminSessionProjectionApplyStatus.Conflict, projection.Apply(conflict).Status);
        Assert.False(projection.Snapshot().IsReady);
    }

    [Fact]
    public void Validate_UsesFixedSizeHashAndChecksPrincipalRevocationAndExpiryLocally()
    {
        byte[] tokenHash = Hash("token");
        var clock = new MutableTimeProvider(s_now);
        var projection = CreateProjection(clock: clock);
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(Session("sid-1", 1, tokenHash)).Status);
        Assert.True(projection.MarkReady(1));

        AdminSessionProjectionValidationResult valid = projection.Validate("sid-1", 1, tokenHash);
        Assert.True(valid.IsValid);
        Assert.Equal(AdminSessionProjectionSources.LocalProjection, valid.Source);
        Assert.Equal(1, valid.SessionVersion);
        Assert.Equal(1, valid.PrincipalVersion);

        Assert.Equal(AdminSessionProjectionReasons.PrincipalMismatch, projection.Validate("sid-1", 2, tokenHash).Reason);
        Assert.Equal(AdminSessionProjectionReasons.TokenMismatch, projection.Validate("sid-1", 1, Hash("wrong")).Reason);
        Assert.Equal(AdminSessionProjectionReasons.TokenMismatch, projection.Validate("sid-1", 1, tokenHash.AsSpan(0, 31)).Reason);

        AdminSessionProjectionSessionUpdate revoked = Session(
            "sid-1",
            1,
            tokenHash,
            version: 2,
            generation: 2,
            principalVersion: 1) with
        {
            RevokedAtUtc = s_now
        };
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(revoked).Status);
        Assert.Equal(AdminSessionProjectionReasons.Revoked, projection.Validate("sid-1", 1, tokenHash).Reason);

        var idleProjection = CreateProjection(clock: clock);
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, idleProjection.Apply(Session("idle", 1, tokenHash)).Status);
        Assert.True(idleProjection.MarkReady(1));
        clock.Advance(TimeSpan.FromMinutes(11));
        Assert.Equal(AdminSessionProjectionReasons.IdleExpired, idleProjection.Validate("idle", 1, tokenHash).Reason);

        clock.Set(s_now);
        var absoluteProjection = CreateProjection(clock: clock);
        AdminSessionProjectionSessionUpdate absolute = Session("absolute", 1, tokenHash) with
        {
            IdleExpiresAtUtc = s_now.AddHours(3),
            AbsoluteExpiresAtUtc = s_now.AddHours(2)
        };
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, absoluteProjection.Apply(absolute).Status);
        Assert.True(absoluteProjection.MarkReady(1));
        clock.Advance(TimeSpan.FromHours(2));
        Assert.Equal(AdminSessionProjectionReasons.AbsoluteExpired, absoluteProjection.Validate("absolute", 1, tokenHash).Reason);
    }

    [Fact]
    public async Task OneThousandConcurrentHotReadsUseOnlyTheLocalProjection()
    {
        byte[] tokenHash = Hash("hot-token");
        var projection = CreateProjection();
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(Session("sid-hot", 1, tokenHash)).Status);
        Assert.True(projection.MarkReady(1));

        AdminSessionProjectionValidationResult[] results = await Task.WhenAll(
            Enumerable.Range(0, 1_000)
                .Select(_ => Task.Run(() => projection.Validate("sid-hot", 1, tokenHash))));

        Assert.All(results, result =>
        {
            Assert.True(result.IsValid, result.Reason);
            Assert.Equal(AdminSessionProjectionSources.LocalProjection, result.Source);
        });
        AdminSessionProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(1_000, snapshot.ValidationCount);
        Assert.Equal(1_000, snapshot.ProjectionReadCount);
        Assert.Equal(0, snapshot.AuthorityReadCount);
        Assert.DoesNotContain(
            typeof(AdminSessionProjection).GetConstructors().Single().GetParameters(),
            parameter => parameter.ParameterType.Name.Contains("Redis", StringComparison.OrdinalIgnoreCase)
                || parameter.ParameterType.Name.Contains("Sql", StringComparison.OrdinalIgnoreCase)
                || parameter.ParameterType.Name.Contains("Source", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void OneHundredThousandExpiredHistoricalSessionsAreRecycledWithinBudgets()
    {
        byte[] tokenHash = Hash("history-token");
        var projection = CreateProjection(maxSessions: 8, maxPrincipals: 8, maxBytes: 8 * 1_024);

        for (int index = 1; index <= 100_000; index++)
        {
            AdminSessionProjectionSessionUpdate expired = Session(
                $"history-{index:D6}",
                index,
                tokenHash,
                version: index,
                generation: index,
                principalVersion: index) with
            {
                IdleExpiresAtUtc = s_now.AddMinutes(-2),
                AbsoluteExpiresAtUtc = s_now.AddMinutes(-1)
            };
            Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(expired).Status);
        }

        int finalPruned = projection.PruneExpiredAndRevoked();
        AdminSessionProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(1, finalPruned);
        Assert.Equal(0, snapshot.SessionEntries);
        Assert.Equal(0, snapshot.PrincipalEntries);
        Assert.Equal(0, snapshot.ResidentBytes);
        Assert.Equal(0, snapshot.CapacityRejectedCount);
        Assert.Equal(100_000, snapshot.AppliedCount);
        Assert.Equal(100_000, snapshot.PrunedSessionCount);
        Assert.InRange(snapshot.SessionEntries, 0, snapshot.MaxSessionEntries);
        Assert.InRange(snapshot.PrincipalEntries, 0, snapshot.MaxPrincipalEntries);
        Assert.InRange(snapshot.ResidentBytes, 0, snapshot.MaxResidentBytes);
    }

    private static AdminSessionProjection CreateProjection(
        int maxSessions = 128,
        int maxPrincipals = 128,
        long maxBytes = 1024 * 1024,
        TimeProvider? clock = null)
        => new(
            new AdminSessionProjectionLimits(maxSessions, maxPrincipals, maxBytes),
            clock ?? new MutableTimeProvider(s_now));

    private static AdminSessionProjectionSessionUpdate Session(
        string sessionId,
        long principalId,
        byte[] tokenHash,
        long version = 1,
        long generation = 1,
        long principalVersion = 1)
        => new(
            sessionId,
            principalId,
            tokenHash,
            RevokedAtUtc: null,
            IdleExpiresAtUtc: s_now.AddMinutes(10),
            AbsoluteExpiresAtUtc: s_now.AddHours(1),
            version,
            generation,
            new AdminSessionProjectionPrincipalUpdate(
                principalId,
                AdminSessionProjectionPrincipalStatus.Active,
                principalVersion,
                Generation: Math.Min(principalVersion, generation)));

    private static byte[] Hash(string value)
        => SHA256.HashData(Encoding.UTF8.GetBytes(value));

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now = _now.Add(duration);

        public void Set(DateTimeOffset value) => _now = value;
    }
}
