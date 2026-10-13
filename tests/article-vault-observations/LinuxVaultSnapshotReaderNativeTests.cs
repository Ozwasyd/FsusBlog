using System.Reflection;
using System.Text;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "LinuxArticleVaultSnapshotNative")]
public sealed class LinuxVaultSnapshotReaderNativeTests
{
    [Fact]
    public void RealRootBoundRead_EqualSamplesWithoutCompletionReturnNoBodyOrAdmission()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult result = reader.Read("articles/first.md", ["articles/first.md"]);
        Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, result.Assessment?.State);
        Assert.Equal("vault_snapshot_completion_unproven", result.ReasonCode);
        Assert.Empty(result.CandidateBytes);
        Assert.False(result.CanAdmitSynchronization);
        Assert.True(result.RequiresRetry);
    }

    [Fact]
    public void RealRootDisposedAndControlPath_ReturnStructuredDenialWithoutCachedBody()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult control = reader.Read(ArticleVaultSchemas.RootManifestPath, []);
        Assert.Null(control.Assessment);
        Assert.Empty(control.CandidateBytes);
        scope.Dispose();
        LinuxVaultSnapshotReadResult closed = reader.Read("articles/first.md", []);
        Assert.Equal("vault_snapshot_scope_or_descriptor_closed", closed.ReasonCode);
        Assert.Empty(closed.CandidateBytes);
        Assert.False(closed.CanAdmitSynchronization);
    }

    [Fact]
    public void RealEmptySourceAndPreCancelledRead_CannotYieldPartialSnapshot()
    {
        using TestRoot root = new();
        File.WriteAllBytes(System.IO.Path.Combine(root.Path, "articles/first.md"), []);
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult empty = reader.Read("articles/first.md", []);
        Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, empty.Assessment?.State);
        Assert.Empty(empty.CandidateBytes);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => reader.Read("articles/first.md", [], cancellationToken: cancelled.Token));
    }

    private sealed class TestRoot : IDisposable
    {
        internal TestRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-vault-snapshot-{Guid.NewGuid():N}");
            Manifest = ArticleVaultSnapshotAssessmentTests.CreateRoot();
            Directory.CreateDirectory(System.IO.Path.Combine(Path, ".fsus"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "articles"));
            File.WriteAllBytes(System.IO.Path.Combine(Path, ArticleVaultSchemas.RootManifestPath), ArticleVaultManifestCodec.Serialize(Manifest));
            File.WriteAllBytes(System.IO.Path.Combine(Path, "articles/first.md"), Encoding.UTF8.GetBytes("private source  \r\n"));
        }

        internal string Path
        {
            get;
        }

        internal ArticleVaultRootManifest Manifest
        {
            get;
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}

[Trait("Category", "ArticleVaultSnapshotAssessment")]
public sealed class LinuxVaultSnapshotReaderBoundaryTests
{
    [Fact]
    public void ReaderAcceptsCanonicalScopeAndRelativeProjectionsOnlyAndResultBodyIsNotSerialized()
    {
        Assert.Equal([typeof(LinuxVaultRootPathScope), typeof(ArticleVaultRootManifest)],
            Assert.Single(typeof(LinuxVaultSnapshotReader).GetConstructors()).GetParameters()
                .Select(static parameter => parameter.ParameterType));
        Assert.Empty(typeof(LinuxVaultSnapshotReadResult).GetConstructors());
        PropertyInfo body = typeof(LinuxVaultSnapshotReadResult).GetProperty(nameof(LinuxVaultSnapshotReadResult.CandidateBytes))!;
        Assert.NotNull(body.GetCustomAttribute<System.Text.Json.Serialization.JsonIgnoreAttribute>());
        Assert.Null(body.SetMethod);
        Assert.DoesNotContain(typeof(LinuxVaultSnapshotReader).GetMethods(BindingFlags.Public | BindingFlags.DeclaredOnly | BindingFlags.Instance),
            static method => method.Name is "Write" or "Open" or "Materialize" or "CommitBase");
    }
}
