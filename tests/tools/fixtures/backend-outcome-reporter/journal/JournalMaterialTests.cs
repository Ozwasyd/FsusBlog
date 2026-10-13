#nullable enable

using Xunit;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace FsusBlog.BackendOutcomeReporterFixture;

[TestCaseOrderer("FsusBlog.BackendOutcomeReporterFixture.JournalCallbackOrderer", "FsusBlog.XunitJournalFixture")]
public sealed class JournalMaterialTests
{
    [Fact]
    public void AlphaPass()
    {
        Assert.Equal(1, 1);
    }

    [Fact]
    public void BravoFailure()
    {
        Assert.Equal(1, 2);
    }

    [Fact(Skip = "ordinary journal fixture skip")]
    public void CharlieSkip()
    {
        Assert.Fail("skipped fixture must not execute");
    }

    [Fact]
    public void DeltaWait()
    {
        Thread.Sleep(Timeout.Infinite);
    }

    [Fact]
    public void EchoLargeFailure()
    {
        Assert.True(false, new string('x', 200000));
    }
}

public sealed class JournalCallbackOrderer : ITestCaseOrderer
{
    public IEnumerable<TTestCase> OrderTestCases<TTestCase>(IEnumerable<TTestCase> testCases)
        where TTestCase : ITestCase
    {
        return testCases.OrderBy(test => test.TestMethod.Method.Name, StringComparer.Ordinal);
    }
}

public sealed class JournalSuccessTests
{
    [Fact]
    public void NativeSuccess()
    {
        Assert.Equal(1, 1);
    }
}

public sealed class JournalFailureTests
{
    [Fact]
    public void NativeFailure()
    {
        Assert.Equal(1, 2);
    }
}
