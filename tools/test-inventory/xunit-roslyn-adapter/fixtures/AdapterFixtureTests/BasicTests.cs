using Xunit;

namespace FsusBlog.AdapterFixture;

public sealed class BasicTests
{
    [Fact]
    public void PlainFact_ReturnsExpectedValue()
    {
        Assert.Equal(4, Add(2, 2));
    }

    [Theory]
    [InlineData(1, 2, 3)]
    [InlineData(4, 5, 9)]
    public void SumTheory_IsCommutative(int left, int right, int expected)
    {
        Assert.Equal(expected, left + right);
    }

    [Theory]
    [InlineData("row", 7, true)]
    [InlineData("other", 8, false)]
    public void MixedRowTheory_AcceptsRows(string label, int number, bool flag)
    {
        Assert.True(flag || label == "other");
        Assert.Contains(label, "rowother");
    }

    private static int Add(int left, int right) => left + right;
}
