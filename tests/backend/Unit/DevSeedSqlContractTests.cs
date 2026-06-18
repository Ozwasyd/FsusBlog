using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DevSeedSqlContractTests
{
    [Fact]
    public void DemoSeedSql_UsesCurrentLowercaseSchemaIdentifiers()
    {
        string seedSql = BackendTestPaths.ReadAllTextFromRoot("tools/dev/demo-seed.sql");

        Assert.Contains("insert into sys_user (username, password, role, createtime, status, lastloginip, lastlogintime)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into category (name)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into tag (name)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into article_tag (articleid, tagid)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into comment (id, article_id, content, create_time, user_id, author_mode,", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Username\"", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Category\"", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"ArticleId\"", seedSql, StringComparison.Ordinal);
    }
}
