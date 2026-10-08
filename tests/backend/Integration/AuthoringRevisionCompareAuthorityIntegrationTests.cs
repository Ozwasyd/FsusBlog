using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringRevisionCompareAuthorityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(73L, "primary", 204, true)] // Active root does not need an explicit permission entry.
    [InlineData(74L, "primary", 204, false)] // Active non-root with empty permissions.
    [InlineData(75L, "primary", 204, false)] // Disabled root, even with ArticleWrite.
    [InlineData(76L, "primary", 204, false)] // Any other non-active root status.
    [InlineData(999L, "primary", 204, false)] // Unknown principal.
    [InlineData(73L, "other-site", 204, false)]
    [InlineData(73L, "primary-site", 204, false)] // Canvas owner scope is not the package-reader scope.
    [InlineData(73L, "primary", 205, false)] // Deleted article.
    [InlineData(73L, "primary", 999, false)] // Unknown article.
    [InlineData(77L, "primary", 204, true)] // Exact ArticleWrite permission.
    [InlineData(78L, "primary", 204, true)] // First entry of a newline-delimited permission list.
    [InlineData(79L, "primary", 204, true)] // Last entry.
    [InlineData(80L, "primary", 204, true)] // Middle entry.
    [InlineData(81L, "primary", 204, false)] // Permission-name prefix is not a permission entry.
    [InlineData(82L, "primary", 204, false)] // Disabled non-root with ArticleWrite.
    public async Task ProductionAuthority_RequiresActivePrincipalAndExactSiteArticleAndPermission(
        long adminPrincipalId,
        string siteScope,
        int articleId,
        bool expectedAuthorized)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(
                id bigint PRIMARY KEY,
                status varchar(32) NOT NULL,
                isroot boolean NOT NULL,
                permissions text NOT NULL);
            CREATE TABLE article(
                id integer PRIMARY KEY,
                isdeleted boolean NOT NULL,
                current_revision_id bigint NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES
                (73, 'active', true, ''),
                (74, 'active', false, ''),
                (75, 'disabled', true, @ArticleWrite),
                (76, 'suspended', true, ''),
                (77, 'active', false, @ArticleWrite),
                (78, 'active', false, @FirstPermission),
                (79, 'active', false, @LastPermission),
                (80, 'active', false, @MiddlePermission),
                (81, 'active', false, @LookalikePermission),
                (82, 'disabled', false, @ArticleWrite);
            INSERT INTO article(id, isdeleted, current_revision_id)
            VALUES
                (204, false, 9002),
                (205, true, 9003);
            """,
            new SugarParameter("@ArticleWrite", AdminPermissions.ArticleWrite),
            new SugarParameter("@FirstPermission", AdminPermissions.ArticleWrite + "\narticle.publish"),
            new SugarParameter("@LastPermission", "article.publish\n" + AdminPermissions.ArticleWrite),
            new SugarParameter("@MiddlePermission", "article.publish\n" + AdminPermissions.ArticleWrite + "\narticle.delete"),
            new SugarParameter("@LookalikePermission", AdminPermissions.ArticleWrite + ".extra"));
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        var authority = new AuthoringRevisionCompareAuthority(db, authoring);
        var context = new RevisionCompareReadContext(adminPrincipalId, siteScope, Guid.CreateVersion7());

        AuthoringRevisionCompareArticle? result = await authority.GetAuthorizedArticleAsync(
            context,
            articleId,
            CancellationToken.None);

        if (expectedAuthorized)
        {
            Assert.Equal(new AuthoringRevisionCompareArticle(204, 9002), result);
        }
        else
        {
            Assert.Null(result);
        }
        Assert.Empty(authoring.ReceivedCalls());
    }
}
