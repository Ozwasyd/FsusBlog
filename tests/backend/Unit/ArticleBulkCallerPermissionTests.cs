using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

// Ordinary source controls only. No native/auth/runtime execution or qualification is claimed.
public sealed class ArticleBulkCallerPermissionTests
{
    [Theory]
    [InlineData("lifecycle.archive")]
    [InlineData("lifecycle.restore")]
    [InlineData("lifecycle.inbox-to-draft")]
    [InlineData("lifecycle.draft-to-inbox")]
    public void OriginalWriteAloneDoesNotSupplyExplicitOperationPermission(string operation)
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, "article.write", operation));
    }

    [Fact]
    public void ExplicitOperationPermissionAloneDoesNotReplaceOriginalWriterPermission()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalArticleWriteAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, "article.lifecycle.write", "lifecycle.restore"));
    }

    [Fact]
    public void OriginalRootRuleDoesNotInventBulkOperationRootBypass()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "", "lifecycle.archive"));
    }

    [Fact]
    public void ExactPersistedPermissionsAreDistinctFactsOnly()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false,
                "article.write; article.lifecycle.write\r\narticle.read", "lifecycle.restore"));
    }

    [Fact]
    public void RootStillRequiresTheExplicitPersistedOperationPermission()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "article.lifecycle.write", "lifecycle.restore"));
    }

    [Theory]
    [InlineData("article.write,ARTICLE.LIFECYCLE.WRITE")]
    [InlineData("article.write,article.lifecycle.write.extra")]
    [InlineData("article.write,*")]
    public void CasePrefixAndWildcardDoNotSupplyOperationPermission(string permissions)
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, permissions, "lifecycle.archive"));
    }

    [Theory]
    [InlineData("schedule.change")]
    [InlineData("category.add")]
    [InlineData("lifecycle.archive.extra")]
    public void OtherOperationOwnersAreNotReinterpreted(string operation)
    {
        Assert.Throws<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "article.lifecycle.write", operation));
    }

    [Fact]
    public async Task FabricatedPermissionObjectHasNoOriginalCustody()
    {
        var fabricated = new ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation(1, "https://site.invalid",
            "lifecycle.restore", "article.lifecycle.write",
            ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent);
        await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.RevalidateBulkCallerPermissionAfterLockAsync(
                null!, null!, null!, null!, fabricated, CancellationToken.None));
    }

    [Fact]
    public void RecreatedTicketEnvelopeRetainsOriginalFacts()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity([], "ordinary-source-control"));
        AuthenticationProperties properties = TicketProperties();
        var original = new AuthenticationTicket(principal, properties, JwtBearerDefaults.AuthenticationScheme);
        var recreated = new AuthenticationTicket(principal, properties, JwtBearerDefaults.AuthenticationScheme);
        Assert.NotSame(original, recreated);
        ArticleLifecycleTransitionWriter.RequireBulkCallerTicketFacts(recreated, properties, principal,
            SHA256.HashData(Encoding.UTF8.GetBytes("ordinary-source-token")),
            properties.IssuedUtc!.Value, properties.ExpiresUtc!.Value);
    }

    [Fact]
    public void CopiedPropertiesAreNotOriginalCustodyEvenWithSameData()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity([], "ordinary-source-control"));
        AuthenticationProperties original = TicketProperties();
        var copied = new AuthenticationTicket(principal, TicketProperties(), JwtBearerDefaults.AuthenticationScheme);
        Assert.Throws<ArticleWriteValidationException>(() => ArticleLifecycleTransitionWriter.RequireBulkCallerTicketFacts(
            copied, original, principal, SHA256.HashData(Encoding.UTF8.GetBytes("ordinary-source-token")),
            original.IssuedUtc!.Value, original.ExpiresUtc!.Value));
    }

    [Fact]
    public void SavedTokenDriftCannotReuseOriginalProperties()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity([], "ordinary-source-control"));
        AuthenticationProperties properties = TicketProperties();
        var ticket = new AuthenticationTicket(principal, properties, JwtBearerDefaults.AuthenticationScheme);
        byte[] originalHash = SHA256.HashData(Encoding.UTF8.GetBytes("ordinary-source-token"));
        properties.UpdateTokenValue("access_token", "changed-ordinary-source-token");
        Assert.Throws<ArticleWriteValidationException>(() => ArticleLifecycleTransitionWriter.RequireBulkCallerTicketFacts(
            ticket, properties, principal, originalHash, properties.IssuedUtc!.Value, properties.ExpiresUtc!.Value));
    }

    private static AuthenticationProperties TicketProperties()
    {
        var properties = new AuthenticationProperties
        {
            IssuedUtc = new DateTimeOffset(2026, 10, 13, 0, 0, 0, TimeSpan.Zero),
            ExpiresUtc = new DateTimeOffset(2026, 10, 13, 0, 15, 0, TimeSpan.Zero)
        };
        properties.StoreTokens([new AuthenticationToken { Name = "access_token", Value = "ordinary-source-token" }]);
        return properties;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task OriginalProjectionWaitCannotCarryJwtAcrossItsOwnDeadline(int secondsAfterDeadline)
    {
        var now = new DateTimeOffset(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);
        var clock = new DeadlineClock(now);
        const string token = "ordinary-deadline-source-token";
        var projection = new AdminSessionProjection(new(128, 128, 1024 * 1024), clock);
        projection.Apply(new("deadline-sid", 1, SHA256.HashData(Encoding.UTF8.GetBytes(token)), null,
            now.AddMinutes(10), now.AddHours(1), 2, 4,
            new(1, AdminSessionProjectionPrincipalStatus.Active, 3, 3)));
        projection.MarkReady(4);
        var sessions = new AdminSessionValidationService(projection, Substitute.For<IAdminSessionTouchScheduler>());
        var principal = new ClaimsPrincipal(new ClaimsIdentity([
            new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", "1"), new("admin_sid", "deadline-sid")], "ordinary-source-control"));
        var observation = await sessions.CaptureCurrentSessionObservationAsync(principal, token, CancellationToken.None);
        Assert.NotNull(observation);
        DateTimeOffset jwtExpiry = now.AddSeconds(1);
        ArticleLifecycleTransitionWriter.RequireBulkCallerSessionAndJwtCurrent(sessions, observation,
            principal, clock, now, jwtExpiry, CancellationToken.None);
        object gate = typeof(AdminSessionProjection).GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(projection)!;
        Exception? failure = null;
        var worker = new Thread(() =>
        {
            try
            {
                ArticleLifecycleTransitionWriter.RequireBulkCallerSessionAndJwtCurrent(sessions, observation,
                    principal, clock, now, jwtExpiry, CancellationToken.None);
            }
            catch (Exception exception)
            {
                failure = exception;
            }
        })
        {
            IsBackground = true
        };
        Monitor.Enter(gate);
        try
        {
            worker.Start();
            Assert.True(SpinWait.SpinUntil(() => (worker.ThreadState & System.Threading.ThreadState.WaitSleepJoin) != 0,
                TimeSpan.FromSeconds(2)));
            // Real original projection lock blocks the production final check; no synthetic validator returns true.
            clock.Advance(TimeSpan.FromSeconds(1 + secondsAfterDeadline));
        }
        finally
        {
            Monitor.Exit(gate);
        }
        Assert.True(worker.Join(TimeSpan.FromSeconds(2)));
        Assert.True(sessions.IsCurrentSessionObservation(observation, principal, CancellationToken.None));
        Assert.Equal("article_bulk_caller_permission_jwt_lifetime_not_current",
            Assert.IsType<ArticleWriteValidationException>(failure).Code);
    }

    private sealed class DeadlineClock(DateTimeOffset now) : TimeProvider
    {
        private long _utcTicks = now.UtcTicks;
        public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref _utcTicks), TimeSpan.Zero);
        internal void Advance(TimeSpan duration) => Interlocked.Add(ref _utcTicks, duration.Ticks);
    }
}
