using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultGit")]
public sealed class LinuxVaultGitObserverTests
{
    [Fact]
    public async Task AdmittedNativeRoot_NoGitObservationIsOptionalAndCurrentBound()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        LinuxVaultGitObserver observer = LinuxVaultGitObserver.Open(new(
            root.Path, root.Manifest, "git-test-agent", new LinuxVaultWatcherOptions()));
        ArticleVaultGitFacts facts = await observer.ObserveAsync([]);
        Assert.Equal(VaultGitAvailability.NotPresent, facts.Availability);
        Assert.Equal("git-not-present", facts.ReasonCode);
        Assert.True((await observer.VerifyCurrentAsync(facts, [])).IsValid);
        Assert.False((await observer.VerifyCurrentAsync(facts with
        {
            Scope = facts.Scope with
            {
                AgentIdentity = "other-agent"
            }
        }, [])).IsValid);
    }
}
