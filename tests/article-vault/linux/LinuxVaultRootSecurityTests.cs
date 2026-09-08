using FsusBlog.ArticleVault.Linux;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultWatcher")]
public sealed class LinuxVaultRootSecurityTests
{
    [Fact]
    public void RootSymlink_IsRejectedBeforeWatchCreation()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string link = root.Path + "-link";
        Directory.CreateSymbolicLink(link, root.Path);
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() => root.Open(link));
            Assert.Equal("linux_vault_root_symlink_rejected", error.ReasonCode);
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    [Fact]
    public void NestedSymlink_ProducesBlockedRescanFactWithoutFollowingIt()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateSymbolicLink(Path.Combine(root.Path, "escape"), Path.GetDirectoryName(root.Path)!);

        using LinuxVaultWatcherSession session = root.Open();
        IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();

        LinuxVaultRawFact blocked = Assert.Single(facts, item => item.ErrorCode == "linux_vault_symlink_rejected");
        Assert.Equal("escape", blocked.RawNewRelativePath);
        Assert.Equal(LinuxVaultPathDisposition.Blocked, blocked.PathDisposition);
        Assert.True(blocked.RescanRequired);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void ControlTreeMutation_IsAuditedAndInvalidatesWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        string receipt = Path.Combine(root.Path, ".fsus", "receipts", "operation.json");
        File.WriteAllBytes(receipt, [1, 2, 3]);
        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == ".fsus/receipts/operation.json");

        Assert.Contains(facts, item => item.PathDisposition == LinuxVaultPathDisposition.ControlTree && item.RescanRequired);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void CaseCollidingControlDirectory_IsBlocked()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateDirectory(Path.Combine(root.Path, ".FSUS"));

        using LinuxVaultWatcherSession session = root.Open();
        IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();

        Assert.Contains(facts, item => item.ErrorCode == "linux_vault_control_tree_case_collision"
            && item.PathDisposition == LinuxVaultPathDisposition.Blocked
            && item.RescanRequired);
    }
}
