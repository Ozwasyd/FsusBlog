using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class SystemServiceTests
{
    [Fact]
    public void ConfigLoadQueries_DoNotCapturePrivateKeyFieldsInSqlSugarWhere()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Services", "SystemService.cs"));

        Assert.DoesNotContain(".Where(c => SeoConfigKeys.Contains(c.Key))", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".Where(c => ComplianceConfigKeys.Contains(c.Key))", source, StringComparison.Ordinal);
        Assert.Contains(".In(c => c.Key, SeoConfigKeys)", source, StringComparison.Ordinal);
        Assert.Contains(".In(c => c.Key, ComplianceConfigKeys)", source, StringComparison.Ordinal);
    }
}
