using FsusBlog.Server.Tests.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

[Collection(nameof(EnvironmentVariableCollection))]
public sealed class ScopedEnvironmentVariablesTests
{
    [Fact]
    public void Dispose_RestoresMissingVariable()
    {
        string name = NewVariableName();

        ScopedEnvironmentVariables.Run([name], outer =>
        {
            outer.Set(name, null);
            using (var scope = new ScopedEnvironmentVariables([name]))
            {
                scope.Set(name, "temporary");
            }

            Assert.Null(Environment.GetEnvironmentVariable(name));
        });
    }

    [Fact]
    public void Dispose_RestoresPresentEmptyVariable()
    {
        string name = NewVariableName();

        ScopedEnvironmentVariables.Run([name], outer =>
        {
            outer.Set(name, string.Empty);
            using (var scope = new ScopedEnvironmentVariables([name]))
            {
                scope.Set(name, "temporary");
            }

            Assert.Equal(string.Empty, Environment.GetEnvironmentVariable(name));
            Assert.True(Environment.GetEnvironmentVariables().Contains(name));
        });
    }

    [Fact]
    public void Dispose_RestoresPresentValue()
    {
        string name = NewVariableName();

        ScopedEnvironmentVariables.Run([name], outer =>
        {
            outer.Set(name, "original");
            using (var scope = new ScopedEnvironmentVariables([name]))
            {
                scope.Set(name, "temporary");
            }

            Assert.Equal("original", Environment.GetEnvironmentVariable(name));
        });
    }

    [Fact]
    public void Run_RestoresVariableWhenBodyThrows()
    {
        string name = NewVariableName();

        ScopedEnvironmentVariables.Run([name], outer =>
        {
            outer.Set(name, "original");

            InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
                ScopedEnvironmentVariables.Run([name], scope =>
                {
                    scope.Set(name, "temporary");
                    throw new InvalidOperationException("body failed");
                }));

            Assert.Equal("body failed", failure.Message);
            Assert.Equal("original", Environment.GetEnvironmentVariable(name));
        });
    }

    [Fact]
    public void Dispose_RestoresMultipleVariables()
    {
        string first = NewVariableName();
        string second = NewVariableName();

        ScopedEnvironmentVariables.Run([first, second], outer =>
        {
            outer.Set(first, "first-original");
            outer.Set(second, null);
            using (var scope = new ScopedEnvironmentVariables([first, second]))
            {
                scope.Set(first, "first-temporary");
                scope.Set(second, "second-temporary");
            }

            Assert.Equal("first-original", Environment.GetEnvironmentVariable(first));
            Assert.Null(Environment.GetEnvironmentVariable(second));
        });
    }

    private static string NewVariableName()
        => $"FSUSBLOG_TEST_SCOPED_ENV_{Guid.NewGuid():N}";
}
