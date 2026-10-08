using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultRecoveryStorageContractTests
{
    [Fact]
    public void CompiledStorageAndPlanOwners_HaveNoNativeOrParallelOperationWriter()
    {
        Type[] owners = [typeof(PostgresArticleVaultRecoveryStorage), typeof(ArticleVaultResolutionOperationPlanner),
            typeof(ArticleVaultRecoveryStorageVerifier)];
        RuntimeMetadataInspection.RuntimeMemberSite[] references = owners
            .SelectMany(static owner => new[] { owner }.Concat(owner.GetNestedTypes(System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic)))
            .SelectMany(static type => RuntimeMetadataInspection.ReadMemberSites(type)).ToArray();
        Assert.NotEmpty(references);
        Assert.DoesNotContain(references, static site =>
        {
            Type? owner = site.Member as Type ?? site.Member.DeclaringType;
            string name = owner?.FullName ?? string.Empty;
            return name.StartsWith("System.IO.", StringComparison.Ordinal) && !typeof(Exception).IsAssignableFrom(owner!)
                || name.StartsWith("System.Diagnostics.Process", StringComparison.Ordinal)
                || name.StartsWith("System.Net.", StringComparison.Ordinal)
                || name.Contains("IArticleVaultCanonicalGroupWriter", StringComparison.Ordinal)
                || name.Contains("IArticleVaultSyncPlanExecutor", StringComparison.Ordinal)
                || site.Member.Name is "AppendAsync" or "RegisterAsync" or "SaveResultAsync" or "ExecuteGroupAsync" or "ExecuteAsync";
        });
        Assert.Contains(references, static site => site.Member.DeclaringType == typeof(IArticleVaultOperationCheckpointStore)
            && site.Member.Name == nameof(IArticleVaultOperationCheckpointStore.ReadThroughAsync));
        Assert.Contains(references, static site => site.Member.DeclaringType == typeof(IArticleVaultRecoveryBackupProtectionAuthority)
            && site.Member.Name == nameof(IArticleVaultRecoveryBackupProtectionAuthority.VerifyAsync));
    }
}
