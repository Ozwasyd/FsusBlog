using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class MySqlDdlFixtureContractTests
{
    [Fact]
    public async Task MissingSchedulerAdmission_RejectsBeforeAnyConnection()
    {
        var fixture = new MySqlDdlFixture(_ => null);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(fixture.InitializeAsync);

        Assert.Contains("FSUSBLOG_MYSQL_FIXTURE_CLIENT_FILE", failure.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("relative/client.cnf")]
    [InlineData("/not-an-admitted-mysql-client.cnf")]
    public async Task UnownedClientPath_RejectsBeforeAnyConnection(string clientFile)
    {
        var fixture = new MySqlDdlFixture(name => name == "FSUSBLOG_MYSQL_FIXTURE_CLIENT_FILE" ? clientFile : null);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(fixture.InitializeAsync);

        Assert.Contains("regular, absolute private client file", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MalformedPrivateClientFile_RejectsBeforeAnyConnection()
    {
        string clientFile = Path.Combine(Path.GetTempPath(), $"fsus-mysql-client-{Guid.NewGuid():N}");
        try
        {
            File.WriteAllText(clientFile, "[client]\npassword=not-an-admitted-secret\n");
            if (OperatingSystem.IsLinux())
            {
                File.SetUnixFileMode(clientFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            var fixture = new MySqlDdlFixture(name => name == "FSUSBLOG_MYSQL_FIXTURE_CLIENT_FILE" ? clientFile : null);

            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(fixture.InitializeAsync);

            Assert.Contains("unexpected shape", failure.Message, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(clientFile);
        }
    }
}
