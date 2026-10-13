using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRelationSourceCoordinateAuthorityTests
{
    private readonly ArticleRelationSourceCoordinateAuthority _authority = new();
    private const string PortableIdentity = "article:dd90413e-7d50-4264-9910-d89294ac2f18";

    [Fact]
    public async Task InvalidNumericCoordinatesFailBeforeDatabaseAccess()
    {
        foreach ((int article, long revision) in new (int, long)[] { (0, 1), (-1, 1), (1, 0), (1, -1) })
        {
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ReadRevisionAsync(null!, article, revision));
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionRevisionAsync(null!, article, revision));
            if (article <= 0)
            {
                await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                    () => _authority.ProvisionImportedArticleAsync(null!, article, PortableIdentity));
            }
        }
    }

    [Fact]
    public async Task LookupRejectsNoncanonicalArticleIdentityBeforeDatabaseAccess()
    {
        foreach (string identity in InvalidIdentities())
        {
            ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.FindArticleAsync(null!, identity));
            Assert.Equal("article_relation_article_identity_invalid", exception.Message);
        }
    }

    [Fact]
    public async Task ImportRejectsNoncanonicalArticleIdentityBeforeDatabaseAccess()
    {
        foreach (string identity in InvalidIdentities())
        {
            ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionImportedRevisionAsync(null!, 1, 1, identity));
            Assert.Equal("article_relation_article_identity_invalid", exception.Message);
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionImportedArticleAsync(null!, 1, identity));
        }
    }

    [Fact]
    public async Task CancellationStopsEveryOperationBeforeNativeAccess()
    {
        using SqlSugarClient db = CreateClient(SqlSugar.DbType.PostgreSQL);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _authority.ReadRevisionAsync(db, 1, 1, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _authority.FindArticleAsync(db, PortableIdentity, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _authority.ProvisionRevisionAsync(db, 1, 1, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _authority.ProvisionImportedRevisionAsync(db, 1, 1, PortableIdentity, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _authority.ProvisionImportedArticleAsync(db, 1, PortableIdentity, cancellation.Token));
    }

    [Fact]
    public async Task ProvisioningRequiresCallerTransactionWithoutOpeningConnection()
    {
        using SqlSugarClient db = CreateClient(SqlSugar.DbType.PostgreSQL);
        ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionRevisionAsync(db, 1, 1));
        Assert.Equal("article_relation_caller_transaction_required", exception.Message);
        Assert.Equal(System.Data.ConnectionState.Closed, db.Ado.Connection.State);
        // The original codec accepts this positive identity before transaction admission refuses it.
        exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionImportedRevisionAsync(db, 1, 1, PortableIdentity));
        Assert.Equal("article_relation_caller_transaction_required", exception.Message);
        exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionImportedArticleAsync(db, 1, PortableIdentity));
        Assert.Equal("article_relation_caller_transaction_required", exception.Message);
    }

    [Fact]
    public async Task UnsupportedProviderCannotAcquireSourceAuthority()
    {
        using SqlSugarClient db = CreateClient(SqlSugar.DbType.Sqlite);
        ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionRevisionAsync(db, 1, 1));
        Assert.Equal("article_relation_postgres_connection_required", exception.Message);
    }

    private static string[] InvalidIdentities() =>
    [
        "", "article:1", "revision:dd90413e-7d50-4264-9910-d89294ac2f18",
        "article:DD90413E-7D50-4264-9910-D89294AC2F18",
        "article:00000000-0000-0000-0000-000000000000",
        " article:dd90413e-7d50-4264-9910-d89294ac2f18"
    ];

    private static SqlSugarClient CreateClient(SqlSugar.DbType provider) => new(new ConnectionConfig
    {
        DbType = provider,
        ConnectionString = provider == SqlSugar.DbType.Sqlite
            ? "Data Source=:memory:"
            : "Host=127.0.0.1;Port=1;Database=coordinate_unit;Username=coordinate_unit;Pooling=false",
        InitKeyType = InitKeyType.Attribute,
        IsAutoCloseConnection = true
    });
}
