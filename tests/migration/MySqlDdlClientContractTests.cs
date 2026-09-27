using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class MySqlDdlClientContractTests
{
    [Theory]
    [InlineData("zero-port")]
    [InlineData("large-port")]
    [InlineData("empty-user")]
    [InlineData("root-user")]
    [InlineData("user-injection")]
    [InlineData("empty-password")]
    [InlineData("empty-prefix")]
    [InlineData("foreign-prefix")]
    [InlineData("unbounded-prefix")]
    [InlineData("long-prefix")]
    [InlineData("prefix-injection")]
    [InlineData("empty-uuid")]
    [InlineData("empty-version")]
    [InlineData("version-prefix")]
    [InlineData("version-suffix")]
    [InlineData("zero-timeout")]
    [InlineData("large-timeout")]
    public void Constructor_RejectsUnboundConnectionFactsBeforeNetworkAccess(string mutation)
    {
        Assert.ThrowsAny<ArgumentException>(() => new MySqlDdlClient(
            mutation == "zero-port" ? 0 : mutation == "large-port" ? 65536U : 23306,
            mutation == "empty-user" ? " " : mutation == "root-user" ? "root"
                : mutation == "user-injection" ? "fixture@localhost" : "fixture_user",
            mutation == "empty-password" ? " " : "controlled-fixture-value",
            mutation == "empty-prefix" ? " " : mutation == "foreign-prefix" ? "public_"
                : mutation == "unbounded-prefix" ? "ddl_contract"
                : mutation == "long-prefix" ? "ddl_" + new string('a', 30) + "_"
                : mutation == "prefix-injection" ? "ddl_contract`_" : "ddl_contract_",
            mutation == "empty-uuid" ? Guid.Empty : Guid.Parse("7b04c028-0d90-4a62-ac80-9cd923051a52"),
            mutation == "empty-version" ? " " : mutation == "version-prefix" ? "8.4"
                : mutation == "version-suffix" ? "8.4.11-unadmitted" : "8.4.11",
            mutation == "zero-timeout" ? 0 : mutation == "large-timeout" ? uint.MaxValue : 30));
    }

    [Theory]
    [InlineData("")]
    [InlineData("mysql")]
    [InlineData("ddl_other_1")]
    [InlineData("ddl_contract_")]
    [InlineData("ddl_contract_1`;DROP DATABASE mysql;")]
    public async Task ExecuteAsync_RejectsForeignDatabaseBeforeNetworkAccess(string database)
    {
        var client = new MySqlDdlClient(23306, "fixture_user", "controlled-fixture-value", "ddl_contract_",
            Guid.Parse("7b04c028-0d90-4a62-ac80-9cd923051a52"), "8.4.11", 30);

        await Assert.ThrowsAsync<ArgumentException>(() => client.ExecuteAsync(database, "SELECT 1;"));
    }

    [Fact]
    public void OwnedDatabaseSelection_AdmitsOnlyTheExactLowerOrUpperRunPrefix()
    {
        var client = new MySqlDdlClient(23306, "fixture_user", "controlled-fixture-value", "ddl_contract_",
            Guid.Parse("7b04c028-0d90-4a62-ac80-9cd923051a52"), "8.4.11", 30);

        Assert.True(client.IsOwnedDatabase("ddl_contract_1"));
        Assert.True(client.IsOwnedDatabase("DDL_CONTRACT_1"));
        Assert.False(client.IsOwnedDatabase("Ddl_contract_1"));
        Assert.False(client.IsOwnedDatabase("DDL_OTHER_1"));
        Assert.False(client.IsOwnedDatabase("DDL_CONTRACT_"));
    }

    [Theory]
    [InlineData(0, "client failure")]
    [InlineData(1062, "duplicate key")]
    [InlineData(-1, "operation timeout")]
    public void SqlResult_RejectsAnyErrorEvenWhenItsCodeIsZero(int code, string error)
    {
        var result = new MySqlDdlClient.SqlResult(code, string.Empty, error);

        Assert.Throws<InvalidOperationException>(() => result.RequireSuccess());
    }

    [Fact]
    public void SqlResult_PreservesEmptyRowsWithoutTrimmingSuccessfulOutput()
    {
        var result = new MySqlDdlClient.SqlResult(0, "\nafter\n", string.Empty);

        Assert.Equal("\nafter\n", result.RequireSuccess());
    }
}
