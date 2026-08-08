using Xunit;

namespace FsusBlog.AdapterFixture;

public sealed partial class StructureTests
{
    [Fact]
    public void OuterPartialFact_IsExtracted()
    {
        Assert.True(true);
    }

    public sealed class NestedTests
    {
        [Fact]
        public void NestedFact_IsOwnedByNestedClass()
        {
            Assert.True(true);
        }
    }
}

public sealed partial class StructureTests
{
    [Fact]
    public void SecondPartialFact_IsExtracted()
    {
        Assert.True(true);
    }
}

public sealed class GenericTests<T>
{
    [Fact]
    public void GenericFact_IsExtracted()
    {
        Assert.True(true);
    }
}
