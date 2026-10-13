using System.Text;
using System.Text.Json;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "LinuxArticleVaultPreparationNative")]
public sealed class LinuxVaultPreparationNativeTests
{
    [Fact]
    public void RealTreeRescanFindsUnknownSourceAndKeepsExactFailuresAndAdmissionBlock()
    {
        using TestRoot root = new();
        File.WriteAllText(System.IO.Path.Combine(root.Path, "articles/unknown.md"), "unregistered source");
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        LinuxVaultRescanResult result = new LinuxVaultRescanReader(scope, root.Manifest).Scan(Running(scope), "agent", [], []);
        Assert.True(result.TreeEnumerationCompleted);
        Assert.Contains(result.Tree, static entry => entry.RelativePath == "articles/unknown.md");
        Assert.Equal(VaultRescanState.Failed, result.Obligation.State);
        Assert.Contains("vault_path_unknown_artifact", result.Obligation.ReasonCodes);
        Assert.Contains("vault_snapshot_completion_unproven", result.Obligation.ReasonCodes);
        Assert.False(result.CanAdmitSynchronization);
        Assert.Null(result.Obligation.NativeTerminalReceiptSha256);
    }

    [Fact]
    public void RealDirectoryCountBoundFailsWithoutCompleteInventoryOrTerminalReceipt()
    {
        using TestRoot root = new();
        for (int index = 0; index < LinuxVaultRescanReader.MaximumDirectories; index++)
        {
            Directory.CreateDirectory(System.IO.Path.Combine(root.Path, $"directory{index}"));
        }

        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        LinuxVaultRescanResult result = new LinuxVaultRescanReader(scope, root.Manifest).Scan(Running(scope), "agent", [], []);
        Assert.False(result.TreeEnumerationCompleted);
        Assert.Equal("vault_rescan_directory_count_bound_exceeded", result.ReasonCode);
        Assert.Equal(VaultRescanState.Failed, result.Obligation.State);
        Assert.True(result.Obligation.BlocksSynchronization);
    }

    [Fact]
    public void RealCreatePreparesFlushedExactTemporaryWithoutCreatingFinalSourceOrBase()
    {
        using TestRoot root = new();
        File.Delete(System.IO.Path.Combine(root.Path, "articles/first.md"));
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        byte[] desired = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("private desired  \r\n")];
        ArticleVaultMaterializationInstruction instruction = Instruction(root.Manifest, desired, null);
        LinuxVaultTemporarySourcePreparation result = new LinuxVaultTemporarySourcePreparer(scope).Prepare(instruction, null, desired);
        Assert.Equal(LinuxVaultTemporaryPreparationStage.ReadbackVerified, result.Stage);
        Assert.True(result.TemporaryArtifactMayExist);
        Assert.Equal(desired, File.ReadAllBytes(System.IO.Path.Combine(root.Path, result.TemporaryRelativePath!)));
        Assert.False(File.Exists(System.IO.Path.Combine(root.Path, "articles/first.md")));
        Assert.False(result.CanExecuteConditionalReplacement);
        Assert.False(result.CanCommitBase);
        Assert.DoesNotContain("private desired", JsonSerializer.Serialize(result), StringComparison.Ordinal);
    }

    [Fact]
    public void RealUpdatePreparationLeavesSourceUntouchedAndRejectsLaterConcurrentEdit()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        VaultFileMetadataObservation metadata = new LinuxVaultSnapshotReader(scope, root.Manifest)
            .Read("articles/first.md", ["articles/first.md"]).Assessment!.Metadata!;
        byte[] desired = Encoding.UTF8.GetBytes("new exact source  \r\n");
        ArticleVaultMaterializationInstruction instruction = Instruction(root.Manifest, desired, root.OldBytes);
        var preparer = new LinuxVaultTemporarySourcePreparer(scope);
        LinuxVaultTemporarySourcePreparation result = preparer.Prepare(instruction, metadata, desired);
        Assert.True(result.TemporaryReadbackVerified);
        Assert.Equal(root.OldBytes, File.ReadAllBytes(System.IO.Path.Combine(root.Path, "articles/first.md")));
        File.WriteAllText(System.IO.Path.Combine(root.Path, "articles/first.md"), "user concurrent edit");
        LinuxVaultTemporarySourcePreparation changed = preparer.Prepare(instruction, metadata, desired);
        Assert.Equal(LinuxVaultTemporaryPreparationStage.NotCreated, changed.Stage);
        Assert.False(changed.TemporaryReadbackVerified);
        Assert.False(changed.CanCommitBase);
        Assert.Equal("linux_vault_mutation_old_metadata_changed", changed.ReasonCode);
        Assert.Equal("user concurrent edit", File.ReadAllText(System.IO.Path.Combine(root.Path, "articles/first.md")));
    }

    private static VaultRescanObligation Running(LinuxVaultRootPathScope scope)
    {
        var binding = new VaultObservationBinding(scope.Scope, "watch");
        var watermark = new VaultObservationWatermark("watch", 0,
            ArticleVaultEventNormalizer.ComputeSnapshotSha256([]), null);
        return ArticleVaultRescanTracker.Begin(ArticleVaultRescanTracker.Require(binding, "agent", watermark, ["native_overflow"]), "agent");
    }

    private static ArticleVaultMaterializationInstruction Instruction(ArticleVaultRootManifest manifest,
        byte[] desired, byte[]? oldBytes)
    {
        const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var instruction = new ArticleVaultMaterializationInstruction(
            ArticleVaultMaterializationInstructionCodec.Schema, 1, "site", "vault", "device", "agent", "plan-ref", Digest,
            manifest.ContentSha256, "result-ref", Digest, "group", "operation", "portable-a", new("articles/first.md",
                ArticleVaultManifestCodec.ComputeProjectionSha256("articles/first.md")),
            oldBytes is null ? VaultMaterializationSourceAction.Create : VaultMaterializationSourceAction.Update,
            oldBytes is null ? null : ArticleVaultManifestCodec.CaptureSourceBytes(oldBytes),
            ArticleVaultManifestCodec.CaptureSourceBytes(desired), null, Digest, "journal", string.Empty);
        return instruction with
        {
            ContentSha256 = ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
        };
    }

    private sealed class TestRoot : IDisposable
    {
        internal TestRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-vault-preparation-{Guid.NewGuid():N}");
            Manifest = ArticleVaultSnapshotAssessmentTests.CreateRoot();
            OldBytes = Encoding.UTF8.GetBytes("original source  \r\n");
            Directory.CreateDirectory(System.IO.Path.Combine(Path, ".fsus"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "articles"));
            File.WriteAllBytes(System.IO.Path.Combine(Path, ArticleVaultSchemas.RootManifestPath), ArticleVaultManifestCodec.Serialize(Manifest));
            File.WriteAllBytes(System.IO.Path.Combine(Path, "articles/first.md"), OldBytes);
        }

        internal string Path
        {
            get;
        }
        internal ArticleVaultRootManifest Manifest
        {
            get;
        }
        internal byte[] OldBytes
        {
            get;
        }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
