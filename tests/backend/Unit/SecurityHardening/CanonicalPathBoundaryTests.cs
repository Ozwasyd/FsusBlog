using System.Reflection;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints;

namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class CanonicalPathBoundaryTests
{
    [Fact]
    public void LocalFixtureScriptValidator_AcceptsOnlyNamedScriptInsideFixtureDirectory()
    {
        using var sandbox = PathSandbox.Create();
        string fixtures = Path.Combine(sandbox.Root, "tests", "frontend", "fixtures");
        Directory.CreateDirectory(fixtures);
        string expected = Path.Combine(fixtures, "prepare-auth-smoke-users.mjs");
        string wrongName = Path.Combine(fixtures, "other.mjs");
        string outside = Path.Combine(sandbox.Root, "prepare-auth-smoke-users.mjs");
        File.WriteAllText(expected, string.Empty);
        File.WriteAllText(wrongName, string.Empty);
        File.WriteAllText(outside, string.Empty);
        MethodInfo validator = Assert.IsAssignableFrom<MethodInfo>(typeof(LocalAuthFixtureEndpoints).GetMethod(
            "ValidateLocalAuthFixtureScriptPath",
            BindingFlags.NonPublic | BindingFlags.Static));

        Assert.True(InvokePathValidator(validator, sandbox.Root, expected));
        Assert.False(InvokePathValidator(validator, sandbox.Root, wrongName));
        Assert.False(InvokePathValidator(validator, sandbox.Root, outside));
    }

    [Theory]
    [InlineData("../outside.txt")]
    [InlineData("..\\outside.txt")]
    [InlineData("%2e%2e%2foutside.txt")]
    [InlineData("%252e%252e%252foutside.txt")]
    [InlineData("nested/%2e%2e/%2e%2e/outside.txt")]
    public void TryResolveRelative_RejectsTraversalAndEncodedSeparators(string candidate)
    {
        using var sandbox = PathSandbox.Create();

        bool resolved = CanonicalPathBoundary.TryResolveRelative(sandbox.Root, candidate, out string path);

        Assert.False(resolved);
        Assert.Equal(string.Empty, path);
    }

    [Fact]
    public void TryResolveRelative_RejectsAbsolutePath()
    {
        using var sandbox = PathSandbox.Create();
        string absolute = Path.Combine(Path.GetTempPath(), $"outside-{Guid.NewGuid():N}.txt");

        bool resolved = CanonicalPathBoundary.TryResolveRelative(sandbox.Root, absolute, out string path);

        Assert.False(resolved);
        Assert.Equal(string.Empty, path);
    }

    [Fact]
    public void TryResolveRelative_ResolvesExistingPathInsidePhysicalRoot()
    {
        using var sandbox = PathSandbox.Create();
        string directory = Path.Combine(sandbox.Root, "nested");
        Directory.CreateDirectory(directory);
        string expected = Path.Combine(directory, "payload.aeds");
        File.WriteAllBytes(expected, [1, 2, 3]);

        bool resolved = CanonicalPathBoundary.TryResolveRelative(
            sandbox.Root,
            "nested/payload.aeds",
            out string path);

        Assert.True(resolved);
        Assert.Equal(Path.GetFullPath(expected), path);
    }

    [Fact]
    public void TryResolveCandidate_ResolvesExistingPathInsideSymbolicLinkRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var sandbox = PathSandbox.Create();
        string physicalRoot = Path.Combine(sandbox.Root, "physical");
        string directory = Path.Combine(physicalRoot, "nested");
        Directory.CreateDirectory(directory);
        string expected = Path.Combine(directory, "payload.aeds");
        File.WriteAllBytes(expected, [1, 2, 3]);
        string rootLink = Path.Combine(sandbox.Root, "root-link");
        Directory.CreateSymbolicLink(rootLink, physicalRoot);

        bool relativeResolved = CanonicalPathBoundary.TryResolveRelative(
            rootLink,
            "nested/payload.aeds",
            out string relativePath);
        bool candidateResolved = CanonicalPathBoundary.TryResolveCandidate(
            rootLink,
            Path.Combine(rootLink, "nested", "payload.aeds"),
            out string candidatePath);

        Assert.True(relativeResolved);
        Assert.Equal(Path.GetFullPath(expected), relativePath);
        Assert.True(candidateResolved);
        Assert.Equal(Path.GetFullPath(expected), candidatePath);
    }

    [Fact]
    public void TryResolveCandidate_RejectsEscapingChildSymbolicLinkInsideSymbolicLinkRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var sandbox = PathSandbox.Create();
        string physicalRoot = Path.Combine(sandbox.Root, "physical");
        Directory.CreateDirectory(physicalRoot);
        string outside = Path.Combine(sandbox.Root, "outside");
        Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside, "secret.txt"), "secret");
        string childLink = Path.Combine(physicalRoot, "linked");
        Directory.CreateSymbolicLink(childLink, outside);
        string rootLink = Path.Combine(sandbox.Root, "root-link");
        Directory.CreateSymbolicLink(rootLink, physicalRoot);

        bool relativeResolved = CanonicalPathBoundary.TryResolveRelative(
            rootLink,
            "linked/secret.txt",
            out string relativePath);
        bool candidateResolved = CanonicalPathBoundary.TryResolveCandidate(
            rootLink,
            Path.Combine(rootLink, "linked", "secret.txt"),
            out string candidatePath);

        Assert.False(relativeResolved);
        Assert.Equal(string.Empty, relativePath);
        Assert.False(candidateResolved);
        Assert.Equal(string.Empty, candidatePath);
    }

    [Fact]
    public void TryResolveRelative_RejectsSymbolicLinkThatEscapesPhysicalRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var sandbox = PathSandbox.Create();
        string outside = Path.Combine(Path.GetTempPath(), $"fsusblog-path-outside-{Guid.NewGuid():N}");
        Directory.CreateDirectory(outside);
        string link = Path.Combine(sandbox.Root, "linked");
        Directory.CreateSymbolicLink(link, outside);
        try
        {
            bool resolved = CanonicalPathBoundary.TryResolveRelative(
                sandbox.Root,
                "linked/secret.txt",
                out string path);

            Assert.False(resolved);
            Assert.Equal(string.Empty, path);
        }
        finally
        {
            Directory.Delete(link);
            Directory.Delete(outside, recursive: true);
        }
    }

    private static bool InvokePathValidator(MethodInfo validator, string root, string candidate)
        => Assert.IsType<bool>(validator.Invoke(null, [root, candidate]));

    private sealed class PathSandbox : IDisposable
    {
        private PathSandbox(string root) => Root = root;

        internal string Root
        {
            get;
        }

        internal static PathSandbox Create()
        {
            string root = Path.Combine(Path.GetTempPath(), $"fsusblog-canonical-path-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            return new PathSandbox(root);
        }

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }
}
