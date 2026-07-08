using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DevSeedSqlContractTests
{
    [Fact]
    public void DemoSeedSql_UsesAnonymousAccountsAndAdminPrincipalPlane()
    {
        string seedSql = BackendTestPaths.ReadAllTextFromRoot("tools/dev/demo-seed.sql");

        Assert.Contains("insert into sys_user (public_handle, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at,", seedSql, StringComparison.Ordinal);
        Assert.Contains("'anonymous_account'", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into admin_principal (handle, displayname, status, isroot, permissions, createdatutc)", seedSql, StringComparison.Ordinal);
        Assert.Contains("'disabled', false", seedSql, StringComparison.Ordinal);
        Assert.Contains("on conflict (handle) do nothing", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into category (name)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into tag (name)", seedSql, StringComparison.Ordinal);
        Assert.Contains("insert into article_tag (articleid, tagid)", seedSql, StringComparison.Ordinal);
        Assert.Contains("id, article_id, content, create_time, author_mode,", seedSql, StringComparison.Ordinal);
        Assert.Contains("anonymous_display_name", seedSql, StringComparison.Ordinal);
        Assert.Contains("anonymous_scope", seedSql, StringComparison.Ordinal);
        Assert.Contains("moderation_subject_hash", seedSql, StringComparison.Ordinal);
        Assert.Contains("credential_level", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("insert into sys_user (username, password, role", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("role = excluded.role", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("role = 'admin'", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("lastloginip", seedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("lastlogintime", seedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("create_time, user_id, author_mode", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("reply_to_user_id", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("moderated_by_user_id", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("from sys_user", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Username\"", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Category\"", seedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"ArticleId\"", seedSql, StringComparison.Ordinal);
    }

    [Fact]
    public void DemoDataDocs_DescribeAnonymousSeedAndAdminBootstrapOnly()
    {
        string docs = BackendTestPaths.ReadAllTextFromRoot("docs/development/demo-data.md");
        string seedScript = BackendTestPaths.ReadAllTextFromRoot("tools/dev/seed-demo-data.sh");

        Assert.Contains("anonymous account container", docs, StringComparison.Ordinal);
        Assert.Contains("admin principal", docs, StringComparison.Ordinal);
        Assert.Contains("Passkey", docs, StringComparison.Ordinal);
        Assert.DoesNotContain("ChangeMe123!", docs, StringComparison.Ordinal);
        Assert.DoesNotContain("| Admin |", docs, StringComparison.Ordinal);
        Assert.DoesNotContain("| User |", docs, StringComparison.Ordinal);
        Assert.Contains("Admin principal handle: demo-admin", seedScript, StringComparison.Ordinal);
        Assert.DoesNotContain("Admin password", seedScript, StringComparison.Ordinal);
    }

    [Fact]
    public void DevStart_SeedsAnonymousCommentPrivacyFixtureForLocalDemo()
    {
        string startScript = BackendTestPaths.ReadAllTextFromRoot("tools/dev/start.sh");

        Assert.Contains("AnonymousIdentity__ZkAnonymousCommentsEnabled", startScript, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentity__ZkVerifier__Enabled", startScript, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentity__ZkVerifier__LocalDevFixture__Enabled", startScript, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentity__ZkProd__Enabled", startScript, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentity__ZkVerifier__NativeGroth16__LibraryPath", startScript, StringComparison.Ordinal);
        Assert.Contains("tests/fixtures/zk/comment-v2/mcl-pairing/comment_v2_mcl_pairing.vk", startScript, StringComparison.Ordinal);
        Assert.Contains("tools/dev/bootstrap-anonymous-comment-fixture.sh", startScript, StringComparison.Ordinal);
    }

    [Fact]
    public void HistoricalResidueBlocksLegacyDemoPasswordSeed()
    {
        string residue = BackendTestPaths.ReadAllTextFromRoot("tools/check-historical-residue.sh");

        Assert.Contains("legacy demo seed password user model", residue, StringComparison.Ordinal);
        Assert.Contains("tools/dev/demo-seed.sql", residue, StringComparison.Ordinal);
        Assert.Contains("docs/development/demo-data.md", residue, StringComparison.Ordinal);
    }
}
