using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleEmbedHostSourceReaderTests(PostgresSchemaMigrationFixture fixture)
{
    private const string RawSource = "\uFEFF# Host\r\n\r\n::embed[article:01991e72-a611-7d16-9fd4-38f7d2e65498]\r\n";

    [Fact]
    public async Task ReadsRealOwnerDraftAndLivePermissionThroughProductionRegistrationsWithoutWrites()
    {
        using EnvironmentScope env = await CreateAsync();
        var commands = new List<string>();
        env.Db.Aop.OnLogExecuting = (sql, _) => commands.Add(sql);

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Available, result.Status);
        ArticleEmbedHostSourceObservation source = Assert.IsType<ArticleEmbedHostSourceObservation>(result.Source);
        Assert.Equal(1, source.OwnerAdminPrincipalId);
        Assert.Equal(1, source.ArticleId);
        Assert.Equal(4, source.ServerRevision);
        Assert.Equal(Encoding.UTF8.GetBytes(RawSource), source.SourceUtf8.ToArray());
        Assert.False(source.HasCompleteDependencyRoster);
        Assert.True(await env.VerifyAsync(source));
        Assert.NotEmpty(commands);
        Assert.All(commands, sql => Assert.StartsWith("SELECT", sql.TrimStart(), StringComparison.OrdinalIgnoreCase));
        Assert.Equal(RawSource, (await env.Db.Queryable<ArticleDraft>().SingleAsync()).MarkdownContent);
        Assert.Equal(4, (await env.Db.Queryable<ArticleDraft>().SingleAsync()).ServerRevision);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("revoked")]
    [InlineData("expired")]
    [InlineData("inactive")]
    [InlineData("deleted")]
    [InlineData("archived")]
    public async Task DeniesFromRealCurrentDatabaseStateDespiteOldWriteClaim(string change)
    {
        using EnvironmentScope env = await CreateAsync();
        switch (change)
        {
            case "permission":
                await env.Db.Updateable<AdminPrincipal>().SetColumns(x => x.Permissions == "").Where(x => x.Id == 1).ExecuteCommandAsync();
                break;
            case "revoked":
                await env.Db.Updateable<AdminSession>().SetColumns(x => x.RevokedAtUtc == env.Now).Where(x => x.SessionId == "embed-session").ExecuteCommandAsync();
                break;
            case "expired":
                await env.Db.Ado.ExecuteCommandAsync(
                    "UPDATE admin_session SET absoluteexpiresatutc = createdatutc - INTERVAL '1 minute' WHERE sessionid = @SessionId",
                    new SugarParameter("@SessionId", "embed-session"));
                break;
            case "inactive":
                await env.Db.Updateable<AdminPrincipal>().SetColumns(x => x.Status == "disabled").Where(x => x.Id == 1).ExecuteCommandAsync();
                break;
            case "deleted":
                await env.Db.Updateable<Article>().SetColumns(x => x.IsDeleted == true).Where(x => x.Id == 1).ExecuteCommandAsync();
                break;
            default:
                await env.Db.Updateable<Article>().SetColumns(x => x.Status == ArticleStatus.Archived).Where(x => x.Id == 1).ExecuteCommandAsync();
                break;
        }
        bool readDraft = false;
        env.Db.Aop.OnLogExecuting = (sql, _) => readDraft |= sql.Contains("article_draft", StringComparison.OrdinalIgnoreCase);

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Unavailable, result.Status);
        Assert.Null(result.Source);
        Assert.False(readDraft);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("article")]
    [InlineData("missing")]
    [InlineData("alias")]
    [InlineData("revision")]
    public async Task RequiresExactPersistedOwnerArticleKeyAndRevision(string change)
    {
        using EnvironmentScope env = await CreateAsync();
        ArticleEmbedHostSourceSelector selector = new(1, "edit:1", 4);
        switch (change)
        {
            case "owner":
                await env.Db.Updateable<ArticleDraft>().SetColumns(x => x.OwnerAdminPrincipalId == 8).Where(x => x.DraftKey == "edit:1").ExecuteCommandAsync();
                break;
            case "article":
                await env.Db.Updateable<ArticleDraft>().SetColumns(x => x.ArticleId == 2).Where(x => x.DraftKey == "edit:1").ExecuteCommandAsync();
                break;
            case "missing":
                selector = selector with
                {
                    DraftKey = "missing"
                };
                break;
            case "alias":
                selector = selector with
                {
                    DraftKey = " edit:1 "
                };
                break;
            default:
                selector = selector with
                {
                    ExpectedServerRevision = 3
                };
                break;
        }

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync(selector);

        Assert.Equal(change == "revision" ? ArticleEmbedHostSourceReadStatus.Stale : ArticleEmbedHostSourceReadStatus.Unavailable, result.Status);
        Assert.Null(result.Source);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IndependentVerificationRereadsRealSourceOrPermission(bool permission)
    {
        using EnvironmentScope env = await CreateAsync();
        ArticleEmbedHostSourceObservation source = (await env.ReadAsync()).Source!;
        if (permission)
        {
            await env.Db.Updateable<AdminPrincipal>().SetColumns(x => x.Permissions == "").Where(x => x.Id == 1).ExecuteCommandAsync();
        }
        else
        {
            // Same server revision deliberately tests that source digest is checked independently.
            await env.Db.Updateable<ArticleDraft>().SetColumns(x => x.MarkdownContent == "changed").Where(x => x.DraftKey == "edit:1").ExecuteCommandAsync();
        }

        Assert.False(await env.VerifyAsync(source));
    }

    [Fact]
    public async Task IndependentVerificationRejectsObservationBackingMemoryTamper()
    {
        using EnvironmentScope env = await CreateAsync();
        ArticleEmbedHostSourceObservation source = (await env.ReadAsync()).Source!;
        ImmutableCollectionsMarshal.AsArray(source.SourceUtf8)![0] ^= 1;

        Assert.False(await env.VerifyAsync(source));
        Assert.Equal(RawSource, (await env.Db.Queryable<ArticleDraft>().SingleAsync()).MarkdownContent);
    }

    [Fact]
    public async Task DetectsRealDatabaseDriftBetweenItsTwoCanonicalReads()
    {
        using EnvironmentScope env = await CreateAsync();
        using SqlSugarClient rival = PostgresSqlSugarTestClient.Create(env.ConnectionString);
        int reads = 0;
        env.Db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("article_draft", StringComparison.OrdinalIgnoreCase) && ++reads == 1)
            {
                rival.Updateable<ArticleDraft>().SetColumns(x => x.MarkdownContent == "racing source").Where(x => x.DraftKey == "edit:1").ExecuteCommand();
            }
        };

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Stale, result.Status);
        Assert.Null(result.Source);
    }

    [Fact]
    public async Task CancellationDoesNotReadOrReturnSource()
    {
        using EnvironmentScope env = await CreateAsync();
        using var cancel = new CancellationTokenSource();
        cancel.Cancel();
        bool queried = false;
        env.Db.Aop.OnLogExecuting = (_, _) => queried = true;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => env.ReadAsync(cancellationToken: cancel.Token));
        Assert.False(queried);
    }

    [Fact]
    public async Task RejectsPermissionRevocationDuringTheRealRead()
    {
        using EnvironmentScope env = await CreateAsync();
        using SqlSugarClient rival = PostgresSqlSugarTestClient.Create(env.ConnectionString);
        int reads = 0;
        env.Db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("article_draft", StringComparison.OrdinalIgnoreCase) && ++reads == 1)
            {
                rival.Updateable<AdminPrincipal>().SetColumns(x => x.Permissions == "").Where(x => x.Id == 1).ExecuteCommand();
            }
        };

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Unavailable, result.Status);
        Assert.Null(result.Source);
    }

    [Fact]
    public async Task EnforcesTheUtf8ByteLimitWithoutChangingStoredSource()
    {
        using EnvironmentScope env = await CreateAsync();
        string content = string.Concat(Enumerable.Repeat("😀", ArticleEmbedHostSourceReader.MaxSourceBytes / 4 + 1));
        Assert.True(content.Length < ArticleEmbedHostSourceReader.MaxSourceBytes);
        await env.Db.Updateable<ArticleDraft>().SetColumns(x => x.MarkdownContent == content).Where(x => x.DraftKey == "edit:1").ExecuteCommandAsync();

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Unavailable, result.Status);
        Assert.Null(result.Source);
        Assert.Equal(content, (await env.Db.Queryable<ArticleDraft>().SingleAsync()).MarkdownContent);
    }

    [Fact]
    public async Task PlainSourceDoesNotManufactureAnEmptyCompleteRoster()
    {
        using EnvironmentScope env = await CreateAsync();
        await env.Db.Updateable<ArticleDraft>().SetColumns(x => x.MarkdownContent == "plain source").Where(x => x.DraftKey == "edit:1").ExecuteCommandAsync();

        ArticleEmbedHostSourceReadResult result = await env.ReadAsync();

        Assert.Equal(ArticleEmbedHostSourceReadStatus.Available, result.Status);
        Assert.False(result.Source!.HasCompleteDependencyRoster);
    }

    private async Task<EnvironmentScope> CreateAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession), typeof(Article), typeof(ArticleDraft));
        TestTemporalContext temporal = TestTemporalContext.FromEnvironment();
        DateTime now = temporal.BusinessEpochUtc.UtcDateTime;
        await db.Insertable(new AdminPrincipal { Handle = "embed-owner", Permissions = AdminPermissions.ArticleWrite, CreatedAtUtc = now }).ExecuteCommandAsync();
        // Identity principal id is obtained from the actual inserted database row.
        long owner = await db.Queryable<AdminPrincipal>().Select(x => x.Id).SingleAsync();
        await db.Insertable(new AdminSession { SessionId = "embed-session", AdminPrincipalId = owner, AccessTokenHash = "test", CreatedAtUtc = now, IdleExpiresAtUtc = now.AddHours(1), AbsoluteExpiresAtUtc = now.AddHours(2) }).ExecuteCommandAsync();
        int article = await db.Insertable(new Article { Title = "host", Status = ArticleStatus.Draft, CreateTime = now, MetadataUpdatedAt = now }).ExecuteReturnIdentityAsync();
        await db.Insertable(new ArticleDraft { OwnerAdminPrincipalId = owner, ArticleId = article, DraftKey = "edit:1", MarkdownContent = RawSource, ServerRevision = 4, CreatedAt = now, UpdatedAt = now }).ExecuteCommandAsync();
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddLogging();
        services.AddSingleton<ISqlSugarClient>(db);
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = "embed-test-site" }).Build());
        services.AddSingleton<TimeProvider>(temporal.BusinessClock);
        var accessor = new HttpContextAccessor();
        services.AddSingleton<IHttpContextAccessor>(accessor);
        // These canonical constructor ports are unused by GetDraftAsync; neither source nor permission is mocked.
        services.AddSingleton(Substitute.For<IArticleCoreService>());
        services.AddSingleton(Substitute.For<IArticlePublicationValidator>());
        services.AddSingleton(Substitute.For<IAuthoringAuditWriter>());
        ServiceProvider provider = services.BuildServiceProvider();
        IServiceScope scope = provider.CreateScope();
        var context = new DefaultHttpContext
        {
            RequestServices = scope.ServiceProvider,
            User = new ClaimsPrincipal(new ClaimsIdentity([
                new("identity_kind", "admin_principal"), new("admin_id", owner.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                new("admin_sid", "embed-session"), new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            ], "test"))
        };
        Assert.Equal(1, owner);
        Assert.Equal(1, article);
        return new(db, connection, provider, scope, accessor, context, now);
    }

    private sealed record EnvironmentScope(SqlSugarClient Db, string ConnectionString, ServiceProvider Provider,
        IServiceScope Scope, HttpContextAccessor Accessor, HttpContext Context, DateTime Now) : IDisposable
    {
        public Task<ArticleEmbedHostSourceReadResult> ReadAsync(ArticleEmbedHostSourceSelector? selector = null,
            CancellationToken cancellationToken = default)
        {
            Accessor.HttpContext = Context;
            return ArticleEmbedHostSourceReader.ReadAsync(Context, selector ?? new(1, "edit:1", 4), cancellationToken);
        }

        public Task<bool> VerifyAsync(ArticleEmbedHostSourceObservation source)
        {
            Accessor.HttpContext = Context;
            return ArticleEmbedHostSourceReader.VerifyAsync(Context, source);
        }

        public void Dispose()
        {
            Scope.Dispose();
            Provider.Dispose();
            Db.Dispose();
        }
    }
}
