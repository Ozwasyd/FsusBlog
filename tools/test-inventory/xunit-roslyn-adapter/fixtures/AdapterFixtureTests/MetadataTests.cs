using Xunit;

namespace FsusBlog.AdapterFixture;

[Trait("Category", "Unit")]
[Trait("Platform", "linux")]
[Trait("Layer", "class-level")]
public sealed class MetadataTests
{
    [Fact]
    [Trait("Layer", "method-level")]
    [Trait("Category", "Override")]
    public void TraitMerge_MethodWins()
    {
        Assert.True(true);
    }

    [Fact(Skip = "not ready")]
    public void SkippedFact_CarriesReason()
    {
        Assert.True(true);
    }

    [Fact(Timeout = 1500)]
    [Trait("Explicit", "true")]
    public void ExplicitTimedFact_CarriesMetadata()
    {
        Assert.True(true);
    }
}

public sealed class FixtureTests : IClassFixture<SharedFixture>
{
    [Fact]
    public void FixtureFact_CarriesFixture()
    {
        Assert.True(true);
    }
}

public sealed class SharedFixture
{
    public bool Ready => true;
}

public sealed class HelperTests
{
    public void NotATest_HelperMethod()
    {
        Assert.True(true);
    }

    [Fact]
    public void RealFact_CallsHelper()
    {
        Assert.True(new HelperTests().NotATest_HelperMethodInvoked());
    }

    internal bool NotATest_HelperMethodInvoked() => true;
}
