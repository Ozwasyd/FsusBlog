using Xunit;

using System.Collections;

namespace FsusBlog.AdapterFixture;

public static class TheoryData
{
    public static IEnumerable<object[]> Rows => new[]
    {
        new object[] { 1, 2 },
        new object[] { 3, 4 }
    };
}

public sealed class CustomData : IEnumerable<object[]>
{
    public IEnumerator<object[]> GetEnumerator()
    {
        yield return new object[] { 5, 6 };
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public sealed class DataDrivenTests
{
    [Theory]
    [MemberData(nameof(TheoryData.Rows), MemberType = typeof(TheoryData))]
    public void MemberDataTheory_IsDynamic(int left, int right)
    {
        Assert.NotEqual(left, right);
    }

    [Theory]
    [ClassData(typeof(CustomData))]
    public void ClassDataTheory_IsDynamic(int left, int right)
    {
        Assert.NotEqual(left, right);
    }
}
