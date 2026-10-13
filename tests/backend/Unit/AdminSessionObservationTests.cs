using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminSessionObservationTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);
    private const string Token = "source-control-token";

    [Fact]
    public async Task CaptureRetainsActualVersionsGenerationAndDeadlines()
    {
        var clock = new Clock(s_now);
        AdminSessionProjection projection = Projection(clock);
        var service = new AdminSessionValidationService(projection, Substitute.For<IAdminSessionTouchScheduler>());
        ClaimsPrincipal principal = Principal();
        var observation = await service.CaptureCurrentSessionObservationAsync(principal, Token, CancellationToken.None);
        Assert.NotNull(observation);
        Assert.Equal(1, observation.AdminPrincipalId);
        Assert.Equal(2, observation.Facts.SessionVersion);
        Assert.Equal(3, observation.Facts.PrincipalVersion);
        Assert.Equal(4, observation.Facts.Generation);
        Assert.Equal(s_now.AddMinutes(10), observation.Facts.IdleExpiresAtUtc);
        Assert.Equal(s_now.AddHours(1), observation.Facts.AbsoluteExpiresAtUtc);
        Assert.True(service.IsCurrentSessionObservation(observation, principal, CancellationToken.None));
        Assert.False(service.IsCurrentSessionObservation(observation, Principal(), CancellationToken.None));
        var other = new AdminSessionValidationService(projection, Substitute.For<IAdminSessionTouchScheduler>());
        Assert.False(other.IsCurrentSessionObservation(observation, principal, CancellationToken.None));
        var fake = new AdminSessionValidationService.CurrentSessionObservation(1, observation.Facts);
        Assert.False(service.IsCurrentSessionObservation(fake, principal, CancellationToken.None));
    }

    [Fact]
    public async Task ExpiredRevokedOrChangedProjectionCannotKeepAnObservationCurrent()
    {
        var clock = new Clock(s_now);
        AdminSessionProjection projection = Projection(clock);
        var service = new AdminSessionValidationService(projection, Substitute.For<IAdminSessionTouchScheduler>());
        ClaimsPrincipal principal = Principal();
        var observation = await service.CaptureCurrentSessionObservationAsync(principal, Token, CancellationToken.None);
        Assert.NotNull(observation);
        clock.Advance(TimeSpan.FromMinutes(11));
        Assert.False(service.IsCurrentSessionObservation(observation, principal, CancellationToken.None));
        Assert.Null(await service.CaptureCurrentSessionObservationAsync(principal, Token, CancellationToken.None));

        clock = new Clock(s_now);
        projection = Projection(clock);
        service = new(projection, Substitute.For<IAdminSessionTouchScheduler>());
        observation = await service.CaptureCurrentSessionObservationAsync(principal, Token, CancellationToken.None);
        Assert.NotNull(observation);
        projection.Apply(Session() with
        {
            Version = 3,
            Generation = 5,
            RevokedAtUtc = s_now
        });
        projection.MarkReady(5);
        Assert.False(service.IsCurrentSessionObservation(observation, principal, CancellationToken.None));
    }

    [Fact]
    public async Task OriginalTouchReentryAndTokenOrIdentityMismatchRefuseCapture()
    {
        var clock = new Clock(s_now);
        AdminSessionProjection projection = Projection(clock);
        var scheduler = Substitute.For<IAdminSessionTouchScheduler>();
        scheduler.When(value => value.TrySchedule(Arg.Any<AdminSessionTouchRequest>())).Do(_ =>
        {
            projection.Apply(Session() with
            {
                Version = 3,
                Generation = 5,
                RevokedAtUtc = s_now
            });
            projection.MarkReady(5);
        });
        var service = new AdminSessionValidationService(projection, scheduler);
        Assert.Null(await service.CaptureCurrentSessionObservationAsync(Principal(), Token, CancellationToken.None));
        service = new(Projection(clock), Substitute.For<IAdminSessionTouchScheduler>());
        Assert.Null(await service.CaptureCurrentSessionObservationAsync(Principal(), "wrong-token", CancellationToken.None));
        Assert.Null(await service.CaptureCurrentSessionObservationAsync(new ClaimsPrincipal(), Token, CancellationToken.None));
    }

    private static ClaimsPrincipal Principal()
        => new(new ClaimsIdentity([new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", "1"), new("admin_sid", "sid-1")], "source-control"));

    private static AdminSessionProjection Projection(Clock clock)
    {
        var projection = new AdminSessionProjection(new(128, 128, 1024 * 1024), clock);
        projection.Apply(Session());
        projection.MarkReady(4);
        return projection;
    }

    private static AdminSessionProjectionSessionUpdate Session()
        => new("sid-1", 1, SHA256.HashData(Encoding.UTF8.GetBytes(Token)), null, s_now.AddMinutes(10), s_now.AddHours(1), 2, 4,
            new(1, AdminSessionProjectionPrincipalStatus.Active, 3, 3));

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        internal void Advance(TimeSpan duration) => _now += duration;
    }
}
