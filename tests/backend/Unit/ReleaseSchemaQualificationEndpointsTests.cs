using FsusBlog.Server.Modules.Endpoints;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReleaseSchemaQualificationEndpointsTests
{
    [Theory]
    [InlineData("Test", true, true)]
    [InlineData("Test", false, false)]
    [InlineData("Development", true, false)]
    [InlineData("Production", true, false)]
    public void QualificationRoutes_AreTestOnlyAndRequireExplicitEnablement(
        string environment,
        bool configured,
        bool expected)
        => Assert.Equal(expected, ReleaseSchemaQualificationEndpoints.IsEnabled(environment, configured));

    [Theory]
    [InlineData("source-write", 1, true)]
    [InlineData("target.write_2", 1_000_000, true)]
    [InlineData("x", 1, false)]
    [InlineData("contains/slash", 1, false)]
    [InlineData("valid", 0, false)]
    [InlineData("valid", 1_000_001, false)]
    public void BridgeWrite_UsesBoundedDeterministicInput(string id, int sequence, bool expected)
    {
        bool actual = ReleaseSchemaQualificationEndpoints.TryNormalizeWrite(
            new ReleaseSchemaBridgeWriteRequest(id, sequence),
            out string normalized,
            out int normalizedSequence);

        Assert.Equal(expected, actual);
        Assert.Equal(id, normalized);
        Assert.Equal(sequence, normalizedSequence);
    }
}
