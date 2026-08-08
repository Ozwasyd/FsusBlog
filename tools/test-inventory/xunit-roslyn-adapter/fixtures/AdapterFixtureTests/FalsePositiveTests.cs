using Xunit;

namespace FsusBlog.AdapterFixture;

public sealed class FalsePositiveTests
{
    [Fact]
    public void RawString_AttributeText_IsNotATest()
    {
        const string template = """
            [Fact]
            public void FakeMethod() { }
            [Theory]
            public void FakeTheory() { }
            """;
        Assert.Contains("[Fact]", template);
    }

    [Fact]
    public void Lambda_And_LocalFunction_DoNotCreateCases()
    {
        void LocalFunction()
        {
            Assert.True(true);
        }
        Func<bool> lambda = () =>
        {
            Assert.True(true);
            return true;
        };
        LocalFunction();
        Assert.True(lambda());
    }

    [Fact]
    public void CallsOtherTest_CarriesSymbolRelation()
    {
        PlainFactTarget();
    }

    [Fact]
    public void PlainFactTarget()
    {
        Assert.True(true);
    }
}
