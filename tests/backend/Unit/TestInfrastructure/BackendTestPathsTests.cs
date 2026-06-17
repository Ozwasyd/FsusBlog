using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit.TestInfrastructure;

public sealed class BackendTestPathsTests : IDisposable
{
    private readonly string? _originalEnvironmentRoot =
        Environment.GetEnvironmentVariable(BackendTestPaths.RepositoryRootEnvironmentVariable);

    public void Dispose()
        => Environment.SetEnvironmentVariable(BackendTestPaths.RepositoryRootEnvironmentVariable, _originalEnvironmentRoot);

    [Fact]
    public void ResolveRepositoryRoot_UsesEnvironmentOverride()
    {
        string root = CreateRepositoryFixture();
        Environment.SetEnvironmentVariable(BackendTestPaths.RepositoryRootEnvironmentVariable, root);

        string resolved = BackendTestPaths.ResolveRepositoryRoot(
            callerFilePath: Path.Combine(Path.GetTempPath(), "outside", "Test.cs"),
            appBaseDirectory: Path.Combine(Path.GetTempPath(), "outside", "bin"));

        Assert.Equal(root, resolved);
    }

    [Fact]
    public void ResolveRepositoryRoot_UsesCallerFilePathAnchor()
    {
        string root = CreateRepositoryFixture();
        string callerFile = Path.Combine(root, "tests", "backend", "Unit", "SomeContractTest.cs");

        string resolved = BackendTestPaths.ResolveRepositoryRootCore(
            environmentRoot: null,
            callerFilePath: callerFile,
            appBaseDirectory: Path.Combine(Path.GetTempPath(), "outside", "bin"));

        Assert.Equal(root, resolved);
    }

    [Fact]
    public void ResolveRepositoryRoot_FallsBackFromOutputLikeDirectory()
    {
        string root = CreateRepositoryFixture();
        string outputLikeDirectory = Path.Combine(root, "tests", "backend", "bin", "Debug", "net10.0");
        Directory.CreateDirectory(outputLikeDirectory);

        string resolved = BackendTestPaths.ResolveRepositoryRootCore(
            environmentRoot: null,
            callerFilePath: null,
            appBaseDirectory: outputLikeDirectory);

        Assert.Equal(root, resolved);
    }

    [Fact]
    public void ResolveRepositoryRoot_FailureIncludesStartsAndAnchors()
    {
        string invalidRoot = CreateTempDirectory();
        string callerFile = Path.Combine(invalidRoot, "tests", "backend", "Unit", "Missing.cs");
        string appBase = Path.Combine(invalidRoot, "tests", "backend", "bin", "Debug", "net10.0");

        var error = Assert.Throws<DirectoryNotFoundException>(() =>
            BackendTestPaths.ResolveRepositoryRootCore(
                environmentRoot: null,
                callerFilePath: callerFile,
                appBaseDirectory: appBase));

        Assert.Contains("Checked start paths", error.Message, StringComparison.Ordinal);
        Assert.Contains("FsusBlog.slnx", error.Message, StringComparison.Ordinal);
        Assert.Contains(Path.Combine("src", "backend"), error.Message, StringComparison.Ordinal);
        Assert.Contains(Path.Combine("tests", "backend"), error.Message, StringComparison.Ordinal);
        Assert.Contains(invalidRoot, error.Message, StringComparison.Ordinal);
    }

    private static string CreateRepositoryFixture()
    {
        string root = CreateTempDirectory();
        File.WriteAllText(Path.Combine(root, "FsusBlog.slnx"), string.Empty);
        Directory.CreateDirectory(Path.Combine(root, "src", "backend"));
        Directory.CreateDirectory(Path.Combine(root, "tests", "backend"));
        return root;
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-backend-test-paths", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return new DirectoryInfo(path).FullName;
    }
}
