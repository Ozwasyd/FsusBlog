using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Hosting;

using NSubstitute;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class CanonicalPathBoundaryTests(ITestOutputHelper output)
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

    [Fact]
    public void LocalFixtureRepoRoot_UsesExplicitRuntimeBinding()
    {
        using var sandbox = PathSandbox.Create();
        string fixtures = Path.Combine(sandbox.Root, "tests", "frontend", "fixtures");
        Directory.CreateDirectory(fixtures);
        File.WriteAllText(Path.Combine(fixtures, "prepare-auth-smoke-users.mjs"), string.Empty);
        string isolatedContentRoot = Path.Combine(sandbox.Root, "release-derived", "runtime");
        Directory.CreateDirectory(isolatedContentRoot);
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.ContentRootPath.Returns(isolatedContentRoot);

        string resolved = LocalAuthFixtureEndpoints.ResolveRepoRoot(environment, sandbox.Root);

        Assert.Equal(Path.GetFullPath(sandbox.Root), resolved);
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
    [Trait("Platform", "Unix")]
    [Trait("PlatformEvidence", "UnixSymlinkBoundary")]
    [UnsupportedOSPlatform("windows")]
    public void TryResolveRelative_RejectsSymbolicLinkThatEscapesPhysicalRoot()
    {
        using var sandbox = PathSandbox.Create();
        string escapeRoot = Path.Combine(sandbox.Root, "escape-root");
        string outside = Path.Combine(sandbox.Root, "outside");
        string positiveRoot = Path.Combine(sandbox.Root, "positive-root");
        string positiveTarget = Path.Combine(positiveRoot, "inside");
        Directory.CreateDirectory(escapeRoot);
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(positiveTarget);
        string outsideSecret = Path.Combine(outside, "secret.txt");
        string positiveSecret = Path.Combine(positiveTarget, "secret.txt");
        File.WriteAllText(outsideSecret, "outside");
        File.WriteAllText(positiveSecret, "inside");
        string escapeLink = Path.Combine(escapeRoot, "linked");
        string positiveLink = Path.Combine(positiveRoot, "linked");
        Directory.CreateSymbolicLink(escapeLink, outside);
        Directory.CreateSymbolicLink(positiveLink, positiveTarget);

        bool escapeRootExists = Directory.Exists(escapeRoot);
        bool outsideTargetExists = Directory.Exists(outside) && File.Exists(outsideSecret);
        bool escapeLinkExists = Directory.Exists(escapeLink);
        Assert.True(escapeRootExists);
        Assert.True(outsideTargetExists);
        Assert.True(escapeLinkExists);
        FileSystemInfo? actualEscapeTarget = Directory.ResolveLinkTarget(escapeLink, returnFinalTarget: true);
        Assert.NotNull(actualEscapeTarget);
        bool escapeTargetMatchesExpected =
            string.Equals(Path.GetFullPath(outside), Path.GetFullPath(actualEscapeTarget.FullName), StringComparison.Ordinal);
        bool escapeTargetOutsideRoot = !IsInsideRoot(escapeRoot, outside);
        Assert.True(escapeTargetMatchesExpected);
        Assert.True(escapeTargetOutsideRoot);

        bool escapeResolved = CanonicalPathBoundary.TryResolveRelative(
            escapeRoot,
            "linked/secret.txt",
            out string escapePath);

        Assert.False(escapeResolved);
        Assert.Equal(string.Empty, escapePath);

        bool positiveRootExists = Directory.Exists(positiveRoot);
        bool positiveTargetExists = Directory.Exists(positiveTarget) && File.Exists(positiveSecret);
        bool positiveLinkExists = Directory.Exists(positiveLink);
        Assert.True(positiveRootExists);
        Assert.True(positiveTargetExists);
        Assert.True(positiveLinkExists);
        FileSystemInfo? actualPositiveTarget = Directory.ResolveLinkTarget(positiveLink, returnFinalTarget: true);
        Assert.NotNull(actualPositiveTarget);
        bool positiveTargetMatchesExpected =
            string.Equals(Path.GetFullPath(positiveTarget), Path.GetFullPath(actualPositiveTarget.FullName), StringComparison.Ordinal);
        Assert.True(positiveTargetMatchesExpected);

        bool positiveResolved = CanonicalPathBoundary.TryResolveRelative(
            positiveRoot,
            "linked/secret.txt",
            out string positivePath);

        Assert.True(positiveResolved);
        Assert.Equal(Path.GetFullPath(positiveSecret), positivePath);
        bool positiveResolvedInsideRoot = IsInsideRoot(positiveRoot, positivePath);
        Assert.True(positiveResolvedInsideRoot);

        Directory.Delete(escapeLink);
        Directory.Delete(positiveLink);
        bool cleanupCompleted =
            !Directory.Exists(escapeLink) &&
            !Directory.Exists(positiveLink) &&
            Directory.Exists(outside) &&
            Directory.Exists(positiveTarget);
        Assert.True(cleanupCompleted);

        output.WriteLine(
            "backend-platform-runtime-evidence {0}",
            JsonSerializer.Serialize(new
            {
                schema = "fsusblog.backend-platform-unix-symlink-boundary-evidence.v1",
                evidenceContract = "unix-symlink-boundary",
                fullyQualifiedName =
                    $"{typeof(CanonicalPathBoundaryTests).FullName}.{nameof(TryResolveRelative_RejectsSymbolicLinkThatEscapesPhysicalRoot)}",
                root = new
                {
                    identity = PathIdentity(escapeRoot),
                    exists = escapeRootExists
                },
                escapeLink = new
                {
                    identity = PathIdentity(escapeLink),
                    targetIdentity = PathIdentity(outside),
                    exists = escapeLinkExists,
                    targetExists = outsideTargetExists,
                    targetOutsideRoot = escapeTargetOutsideRoot,
                    targetMatchesExpected = escapeTargetMatchesExpected
                },
                rejection = new
                {
                    resolved = escapeResolved,
                    pathEmpty = escapePath.Length == 0
                },
                positiveControl = new
                {
                    rootIdentity = PathIdentity(positiveRoot),
                    linkIdentity = PathIdentity(positiveLink),
                    targetIdentity = PathIdentity(positiveTarget),
                    rootExists = positiveRootExists,
                    linkExists = positiveLinkExists,
                    targetExists = positiveTargetExists,
                    targetMatchesExpected = positiveTargetMatchesExpected,
                    resolved = positiveResolved,
                    resolvedInsideRoot = positiveResolvedInsideRoot,
                    resolvedPathMatchesExpected =
                        string.Equals(positivePath, Path.GetFullPath(positiveSecret), StringComparison.Ordinal)
                },
                cleanupCompleted
            }));
    }

    private static string PathIdentity(string path)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(path))));

    private static bool IsInsideRoot(string root, string candidate)
    {
        string relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(candidate));
        return !Path.IsPathRooted(relative) &&
            !string.Equals(relative, "..", StringComparison.Ordinal) &&
            !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal);
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
