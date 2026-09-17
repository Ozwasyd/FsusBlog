using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit.TestInfrastructure;

public sealed class BackendTestPathsTests
{
    [Fact]
    public void ResolveRepositoryRootCore_UsesEnvironmentOverride()
    {
        string root = CreateRepositoryFixture();

        string resolved = BackendTestPaths.ResolveRepositoryRootCore(
            environmentRoot: root,
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
        string invalidRoot = Path.Combine(
            Path.GetPathRoot(Path.GetTempPath()) ?? Path.DirectorySeparatorChar.ToString(),
            $"fsus-missing-backend-test-root-{Guid.NewGuid():N}");
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
