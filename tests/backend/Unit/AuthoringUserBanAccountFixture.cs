using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

internal static class AuthoringUserBanAccountFixture
{
    internal static async Task SeedAsync(SqlSugarClient db, int userId)
    {
        Assert.True(AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled(),
            "The real account issuer requires FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1.");
        Assert.Equal(0, db.Queryable<User>().Count());
        db.CodeFirst.InitTables<AccountEnrollmentSession>();
        // Each caller owns an empty database; preserve the concurrency oracle's account ID.
        db.Ado.ExecuteCommand(
            "SELECT setval(pg_get_serial_sequence('sys_user', 'id'), @Id, false);",
            new SugarParameter("@Id", userId));
        var issuer = new AnonymousAccountBootstrapService(
            db,
            new ConfigurationBuilder().Build(),
            NullLogger<AnonymousAccountBootstrapService>.Instance);
        var issued = await issuer.BootstrapAnonymousAccountAsync($"user{userId}");
        Assert.True(issued.Success, issued.Message);
        Assert.NotNull(issued.User);
        Assert.Equal(userId, issued.User.Id);
        Assert.False(string.IsNullOrWhiteSpace(issued.EnrollmentToken));
        User persisted = db.Queryable<User>().InSingle(userId);
        Assert.True(AccountSubjectHashRequirement.TryResolve(persisted.AccountSubjectHash, out _));
        Assert.Equal(issued.User.AccountSubjectHash, persisted.AccountSubjectHash);
        Assert.Equal(1, db.Queryable<AccountEnrollmentSession>()
            .Count(session => session.AccountId == userId));
    }
}
