using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Integration")]
[Trait("Category", "Security")]
[Trait("Category", "Migration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DevSeedSqlContractTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task DemoSeedSql_ExecutesTwiceAgainstEmptyProductionSchemaAndPreservesDataInvariants()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(AdminPrincipal),
            typeof(AdminPasskeyCredential),
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Comment),
            typeof(AuditLog));
        string seedPath = BackendTestPaths.FromRoot("tools", "dev", "demo-seed.sql");

        Assert.Equal(0, await db.Queryable<User>().CountAsync());
        Assert.Equal(0, await db.Queryable<Article>().CountAsync());
        Assert.Equal(0, await db.Queryable<Comment>().CountAsync());

        await fixture.ExecuteSqlFileAsync(connectionString, seedPath);
        SeedSnapshot first = await ReadSnapshotAsync(connectionString, db);
        await AssertSeedSemanticsAsync(connectionString, db, first);

        await fixture.ExecuteSqlFileAsync(connectionString, seedPath);
        SeedSnapshot second = await ReadSnapshotAsync(connectionString, db);
        await AssertSeedSemanticsAsync(connectionString, db, second);

        Assert.Equal(first, second);
    }

    private async Task AssertSeedSemanticsAsync(
        string connectionString,
        SqlSugarClient db,
        SeedSnapshot snapshot)
    {
        Assert.Equal(new SeedSnapshot(
            Users: 1,
            AdminPrincipals: 1,
            AdminPasskeys: 0,
            Categories: 2,
            Tags: 4,
            Articles: 2,
            ArticleBodies: 2,
            ArticleTags: 4,
            Comments: 2,
            AuditEvents: 2), snapshot);

        User user = await db.Queryable<User>().SingleAsync(item => item.PublicHandle == "demo-reader");
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, user.IdentityKind);
        Assert.False(user.PasskeyEnabled);
        Assert.False(user.RecoveryEnabled);
        Assert.NotNull(user.PrivacyInitializedAt);
        Assert.Equal("basic", user.AnonymousCredentialLevel);
        Assert.Equal("active", user.AnonymousCredentialStatus);

        AdminPrincipal admin = await db.Queryable<AdminPrincipal>().SingleAsync(item => item.Handle == "demo-admin");
        Assert.Equal(AdminPrincipalStatus.Disabled, admin.Status);
        Assert.False(admin.IsRoot);
        Assert.Empty(admin.Permissions);
        Assert.Equal(0, await db.Queryable<AdminPasskeyCredential>()
            .Where(item => item.AdminPrincipalId == admin.Id)
            .CountAsync());
        Assert.Equal(0, await db.Queryable<User>()
            .Where(item => item.PublicHandle == "demo-admin")
            .CountAsync());

        Assert.Equal(0, await fixture.QueryScalarAsync<long>(
            connectionString,
            """
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'sys_user'
              AND lower(column_name) IN ('username', 'password', 'role', 'lastloginip', 'lastlogintime');
            """));

        Assert.Equal(2, await fixture.QueryScalarAsync<long>(
            connectionString,
            """
            SELECT COUNT(*)
            FROM article a
            JOIN category c ON c.id = a.categoryid
            WHERE a.id IN (910001, 910002)
              AND c.name IN ('Public Preview', 'Operations Notes');
            """));
        Assert.Equal(4, await fixture.QueryScalarAsync<long>(
            connectionString,
            """
            SELECT COUNT(*)
            FROM article_tag at
            JOIN article a ON a.id = at.articleid
            JOIN tag t ON t.id = at.tagid
            WHERE a.id IN (910001, 910002)
              AND t.name IN ('demo', 'aeds', 'public-aot');
            """));
        Assert.Equal(2, await fixture.QueryScalarAsync<long>(
            connectionString,
            """
            SELECT COUNT(*)
            FROM comment c
            JOIN article a ON a.id = c.article_id
            WHERE c.id IN (9100001, 9100002)
              AND c.author_mode = 'anonymous'
              AND c.user_id IS NULL
              AND c.public_handle IS NULL
              AND nullif(c.anonymous_handle, '') IS NOT NULL
              AND nullif(c.anonymous_display_name, '') IS NOT NULL
              AND nullif(c.anonymous_nullifier_hash, '') IS NOT NULL
              AND nullif(c.anonymous_scope, '') IS NOT NULL
              AND nullif(c.moderation_subject_hash, '') IS NOT NULL
              AND nullif(c.credential_level, '') IS NOT NULL;
            """));
    }

    private async Task<SeedSnapshot> ReadSnapshotAsync(string connectionString, SqlSugarClient db)
        => new(
            Users: await db.Queryable<User>().CountAsync(),
            AdminPrincipals: await db.Queryable<AdminPrincipal>().CountAsync(),
            AdminPasskeys: await db.Queryable<AdminPasskeyCredential>().CountAsync(),
            Categories: await db.Queryable<Category>().CountAsync(),
            Tags: await db.Queryable<Tag>().CountAsync(),
            Articles: await db.Queryable<Article>().CountAsync(),
            ArticleBodies: await db.Queryable<ArticleBody>().CountAsync(),
            ArticleTags: await db.Queryable<ArticleTag>().CountAsync(),
            Comments: await db.Queryable<Comment>().CountAsync(),
            AuditEvents: await fixture.QueryScalarAsync<int>(
                connectionString,
                "SELECT COUNT(*) FROM sys_audit_log WHERE source = 'demo-seed';"));

    private sealed record SeedSnapshot(
        int Users,
        int AdminPrincipals,
        int AdminPasskeys,
        int Categories,
        int Tags,
        int Articles,
        int ArticleBodies,
        int ArticleTags,
        int Comments,
        int AuditEvents);
}
