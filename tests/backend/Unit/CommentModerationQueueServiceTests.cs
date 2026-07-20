using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationQueueServiceTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-20T00:00:00Z");
    private const string FirstToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private const string SecondToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void Migration_IsAdditiveNonTransactionalAndUsesConcurrentRollbackSafeIndexes()
    {
        ISchemaMigrationDescriptor descriptor = CommentModerationQueueMigrationDefinitions.BuildMigration();
        Assert.False(descriptor.Transactional);
        Assert.Contains(descriptor.Steps, static step => step is EnsureTableStep table
            && table.TableName == "comment_moderation_queue_claim");
        RawSqlStep[] indexes = [.. descriptor.Steps.OfType<RawSqlStep>()];
        Assert.Equal(4, indexes.Length);
        Assert.All(indexes, static step => Assert.Contains("CREATE INDEX CONCURRENTLY", step.Sql, StringComparison.OrdinalIgnoreCase));
        Assert.Contains("DROP INDEX CONCURRENTLY", CommentModerationQueueMigrationDefinitions.RollbackSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DROP TABLE", CommentModerationQueueMigrationDefinitions.RollbackSql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ClaimEntity_UsesOneCurrentRowPerCommentAndNeverStoresPlainToken()
    {
        SugarTable table = Assert.Single(typeof(CommentModerationQueueClaim).GetCustomAttributes<SugarTable>());
        Assert.Equal("comment_moderation_queue_claim", table.TableName);
        PropertyInfo commentId = typeof(CommentModerationQueueClaim).GetProperty(nameof(CommentModerationQueueClaim.CommentId))!;
        SugarColumn column = Assert.Single(commentId.GetCustomAttributes<SugarColumn>());
        Assert.True(column.IsPrimaryKey);
        Assert.DoesNotContain(typeof(CommentModerationQueueClaim).GetProperties(), property =>
            property.Name.Equals("ClaimToken", StringComparison.Ordinal));
        Assert.Contains(typeof(CommentModerationQueueClaim).GetCustomAttributes<SugarIndexAttribute>(), index =>
            index.IndexName == "idx_comment_moderation_claim_lease");
    }

    [Fact]
    public void KeysetPage_IsStableAcrossAppealRiskWaitAndId()
    {
        var service = Service();
        CommentModerationQueueCandidate[] candidates =
        [
            new(40, 0, 900, s_now.AddMinutes(-30).UtcDateTime),
            new(30, 1, 10, s_now.AddMinutes(-5).UtcDateTime),
            new(20, 1, 10, s_now.AddMinutes(-20).UtcDateTime),
            new(21, 1, 10, s_now.AddMinutes(-20).UtcDateTime),
            new(10, 2, 0, s_now.UtcDateTime)
        ];

        IReadOnlyList<CommentModerationQueueCandidate> first = service.Page(candidates, null, 3);
        Assert.Equal([10L, 20L, 21L], first.Select(static item => item.CommentId));
        Assert.True(CommentModerationQueueService.TryDecodeCursor(
            CommentModerationQueueService.EncodeCursor(first[^1]),
            out CommentModerationQueueCursor? cursor));

        IReadOnlyList<CommentModerationQueueCandidate> second = service.Page(candidates, cursor, 3);
        Assert.Equal([30L, 40L], second.Select(static item => item.CommentId));
        Assert.Empty(first.Select(static item => item.CommentId).Intersect(second.Select(static item => item.CommentId)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-base64")]
    [InlineData("djE6OToxOjYzODg4NTY2NDAwMDAwMDAwMDox")]
    public void Cursor_RejectsMalformedOrOutOfRangeValues(string value)
        => Assert.False(CommentModerationQueueService.TryDecodeCursor(value, out _));

    [Fact]
    public void ActiveLease_BlocksAnotherAdminAndExpiredLeaseCanBeTakenOver()
    {
        var clock = new MutableTimeProvider(s_now);
        var service = Service(clock, FirstToken, SecondToken);

        CommentModerationClaimCommandResult first = service.Claim(null, 101, 11, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30));
        CommentModerationClaimCommandResult conflict = service.Claim(first.Claim, 101, 12, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30));
        Assert.True(first.Success);
        Assert.Equal("comment_moderation_claim_conflict", conflict.Code);
        Assert.NotEqual(first.Claim!.ClaimTokenHash, first.ClaimToken);

        clock.Advance(TimeSpan.FromMinutes(3));
        CommentModerationClaimCommandResult takeover = service.Claim(first.Claim, 101, 12, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30));
        Assert.True(takeover.Success);
        Assert.Equal(2, takeover.Claim!.ClaimGeneration);
        Assert.Equal(12, takeover.Claim.OwnerAdminPrincipalId);
        Assert.NotEqual(first.Claim.ClaimTokenHash, takeover.Claim.ClaimTokenHash);
    }

    [Fact]
    public void RenewReleaseAndComplete_RequireExactOwnerAndToken()
    {
        var clock = new MutableTimeProvider(s_now);
        var service = Service(clock, FirstToken);
        CommentModerationClaimCommandResult claimed = service.Claim(
            null,
            201,
            21,
            TimeSpan.FromMinutes(2),
            TimeSpan.FromMinutes(30),
            "  needs legal review  ",
            CommentModerationEscalationStatuses.Escalated);

        Assert.False(service.Renew(claimed.Claim!, 22, FirstToken, TimeSpan.FromMinutes(3)).Success);
        Assert.False(service.Renew(claimed.Claim!, 21, SecondToken, TimeSpan.FromMinutes(3)).Success);
        clock.Advance(TimeSpan.FromSeconds(30));
        CommentModerationClaimCommandResult renewed = service.Renew(claimed.Claim!, 21, FirstToken, TimeSpan.FromMinutes(3));
        Assert.True(renewed.Success);
        Assert.Equal("needs legal review", renewed.Claim!.Note);
        Assert.Equal(CommentModerationEscalationStatuses.Escalated, renewed.Claim.EscalationStatus);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, renewed.Claim.RenewedAtUtc);

        CommentModerationClaimCommandResult released = service.Release(renewed.Claim, 21, FirstToken);
        Assert.True(released.Success);
        Assert.Equal(CommentModerationClaimStates.Released, released.Claim!.State);
        Assert.False(service.Complete(released.Claim, 21, FirstToken).Success);
    }

    [Fact]
    public void CompletedClaim_CannotBeSilentlyReclaimed()
    {
        var service = Service(tokenValues: [FirstToken]);
        CommentModerationClaimCommandResult claimed = service.Claim(null, 301, 31, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30));
        CommentModerationClaimCommandResult completed = service.Complete(claimed.Claim!, 31, FirstToken);
        CommentModerationClaimCommandResult reclaimed = service.Claim(completed.Claim, 301, 32, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30));

        Assert.True(completed.Success);
        Assert.Equal(CommentModerationClaimStates.Completed, completed.Claim!.State);
        Assert.Equal("comment_moderation_claim_completed", reclaimed.Code);
    }

    [Fact]
    public void ExpiredRecovery_DoesNotTouchLiveOrReleasedLease()
    {
        var clock = new MutableTimeProvider(s_now);
        var service = Service(clock, FirstToken);
        CommentModerationQueueClaim active = service.Claim(null, 401, 41, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(30)).Claim!;

        Assert.Same(active, service.RecoverExpired(active));
        clock.Advance(TimeSpan.FromMinutes(2));
        CommentModerationQueueClaim expired = service.RecoverExpired(active);
        Assert.Equal(CommentModerationClaimStates.Expired, expired.State);
        Assert.NotNull(expired.ReleasedAtUtc);
    }

    [Fact]
    public void ClaimBounds_FailClosedForUnsafeDurationsNotesAndEscalation()
    {
        var service = Service(tokenValues: [FirstToken]);
        Assert.False(service.Claim(null, 1, 1, TimeSpan.FromSeconds(14), TimeSpan.FromMinutes(30)).Success);
        Assert.False(service.Claim(null, 1, 1, TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(59)).Success);
        Assert.False(service.Claim(null, 1, 1, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), new string('x', 1001)).Success);
        Assert.False(service.Claim(null, 1, 1, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), escalationStatus: "urgent").Success);
    }

    private static CommentModerationQueueService Service(
        MutableTimeProvider? time = null,
        params string[] tokenValues)
    {
        time ??= new(s_now);
        var tokens = new Queue<string>(tokenValues.Length == 0 ? [FirstToken] : tokenValues);
        return new(time, () => tokens.Dequeue());
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan value) => _now = _now.Add(value);
    }
}
