using System.Security.Claims;

using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;

using static FsusBlog.Server.Services.Authoring.SqlAuthorRecentArticleHistoryPermissionAuthority;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure canonical encoding controls, never authorization grants.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchPermissionEncodingTests
{
    private static readonly DateTime s_idle = new(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void CanonicalPolicyHasOneByteExactGoldenVectorAndRawRevision()
    {
        var value = AuthorFullTextSearchContract.EncodePermissionIdentity(Observation());
        Assert.Equal(42, value.UserId);
        Assert.Equal(7, value.PermissionRevision);
        Assert.Equal("sha256:3f63160218cc95358d463a727575a97496f860e87d0dcbcd21cc5311d6fc2479", value.PermissionPolicyDigest);
        Assert.Equal(value, AuthorFullTextSearchContract.EncodePermissionIdentity(Observation(requestId: Guid.NewGuid(), articleId: 9)));
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("session-generation")]
    [InlineData("status")]
    [InlineData("root")]
    [InlineData("permissions")]
    [InlineData("revoked")]
    [InlineData("idle")]
    [InlineData("absolute")]
    [InlineData("session-id")]
    [InlineData("site")]
    [InlineData("actor")]
    public void EveryOriginalActorSessionPolicyCoordinateIsBound(string change)
    {
        FullTextQueryPermissionObservation initial = Observation();
        var state = initial.ActorState;
        state = change switch
        {
            "principal" => state with { PrincipalGeneration = 8 },
            "session-generation" => state with { SessionGeneration = 12 },
            "status" => state with { Status = "disabled" },
            "root" => state with { IsRoot = true },
            "permissions" => state with { Permissions = "article.write " },
            "revoked" => state with { RevokedAtUtc = s_idle.AddDays(-1) },
            "idle" => state with { IdleExpiresAtUtc = s_idle.AddTicks(1) },
            "absolute" => state with { AbsoluteExpiresAtUtc = s_idle.AddDays(2) },
            _ => state
        };
        var changed = Observation(change == "actor" ? 43 : 42,
            change == "site" ? "https://other.example.test" : "https://author.example.test/blog",
            change == "session-id" ? "session-b" : "session-a", state);
        var before = AuthorFullTextSearchContract.EncodePermissionIdentity(initial);
        var after = AuthorFullTextSearchContract.EncodePermissionIdentity(changed);
        Assert.NotEqual(before.PermissionPolicyDigest, after.PermissionPolicyDigest);
        Assert.Equal(change == "principal" ? 8 : 7, after.PermissionRevision);
    }

    [Theory]
    [InlineData(1L, true)]
    [InlineData(2147483647L, true)]
    [InlineData(2147483648L, false)]
    [InlineData(0L, false)]
    [InlineData(-1L, false)]
    public void AdminIdentityMappingIsExactOrRefuses(long actor, bool valid)
    {
        if (valid)
        {
            Assert.Equal(actor, AuthorFullTextSearchContract.EncodePermissionIdentity(Observation(actor)).UserId);
        }
        else
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.EncodePermissionIdentity(Observation(actor)));
        }
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("principal-generation")]
    [InlineData("session-generation")]
    [InlineData("utc")]
    public void MisboundOrInvalidRawCoordinatesNeverAcquireAnEncoding(string fault)
    {
        var original = Observation();
        var actor = original.ActorContext with
        {
            PrincipalId = fault == "owner" ? 43 : 42,
            SiteScope = fault == "site" ? "other" : original.Owner.SiteScope
        };
        var state = original.ActorState with
        {
            PrincipalGeneration = fault == "principal-generation" ? 0 : 7,
            SessionGeneration = fault == "session-generation" ? 0 : 11,
            IdleExpiresAtUtc = fault == "utc" ? DateTime.SpecifyKind(s_idle, DateTimeKind.Unspecified) : s_idle
        };
        var invalid = new FullTextQueryPermissionObservation(new object(), original.Owner, original.RequestId,
            original.ArticleIds, actor, state, original.Articles);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.EncodePermissionIdentity(invalid));
    }

    private static FullTextQueryPermissionObservation Observation(long actor = 42,
        string site = "https://author.example.test/blog", string session = "session-a", FullTextActorState? state = null,
        Guid? requestId = null, int articleId = 1)
        => new(new object(), new(actor, site), requestId ?? Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), [articleId],
            new(new DefaultHttpContext(), new ClaimsPrincipal(), actor, session, site),
            state ?? new(7, 11, "active", false, "article.write", null, s_idle, s_idle.AddDays(1)), []);
}
