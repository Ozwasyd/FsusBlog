using System.Globalization;

using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class NativeMigrationSourceIntegrationTests
{
    [Theory]
    [InlineData(1, "1743e0fbea1a9f2d2dbb8bc7e2e75450cc83522d46866154558cb1b1d06a05f2")]
    [InlineData(42, "da018bf36eb430e6e22047195bd6b6d309996e89b2390d3a25a9927fad37b720")]
    [InlineData(int.MaxValue, "e6dde1d7c7b9f56ba43c4af41eecc277e5394dc1cf8faf54d22d2262824d6e76")]
    public void LegacyAnonymousSubjects_RetainCanonicalPasswordEraHashAcrossCultures(int accountId, string expected)
    {
        CultureInfo original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("ar-SA");
            Assert.Equal(expected, AccountSubjectHashOnlineBackfillHandler.ComputeLegacyAnonymousAccountSubject(accountId));
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Theory]
    [InlineData("string", "active", "'active'")]
    [InlineData("string", "NULL", "NULL")]
    [InlineData("int32", "-2", "-2")]
    [InlineData("bool", "false", "false")]
    public void LegacyPreparation_ReusesTypedEntityDefaultInterpretation(string dataType, string value, string expected)
    {
        var column = new SchemaColumnModel("probe", false, false, false, null, dataType, DefaultValue: value);
        Assert.Equal(expected, CurrentSchemaBootstrapCompiler.EntityDefaultValue(column));
    }

    [Theory]
    [InlineData("string", "active; DROP TABLE probe")]
    [InlineData("int32", "1 + 2")]
    [InlineData("bool", "custom_function()")]
    public void LegacyPreparation_RefusesUnsupportedDefaultsThroughOriginalCompiler(string dataType, string value)
    {
        var column = new SchemaColumnModel("probe", false, false, false, null, dataType, DefaultValue: value);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.EntityDefaultValue(column));
        Assert.Equal("current_schema_bootstrap_default_capability_unavailable", error.Message);
    }
}
