using System.Collections.Immutable;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

internal static class VaultResolutionTestInputs
{
    internal const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal const long Now = 1_800_000_000_000;

    internal static ArticleVaultResolutionPlanInput Create()
    {
        ArticleVaultMetadataManifest baseline = Seal(new ArticleVaultMetadataManifest(ArticleVaultSchemas.MetadataManifest, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", "base title", "base summary", "base-slug", Digest, Digest, string.Empty));
        ArticleVaultMetadataManifest local = Seal(baseline with
        {
            Title = "local title"
        });
        ArticleVaultMetadataManifest server = Seal(baseline with
        {
            Summary = "server summary"
        });
        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes("source\n"u8);
        VaultArticleCoordinate ancestor = Seal(new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, 1, true, false, 4, source,
            baseline.ContentSha256, Digest, "draft", Digest, string.Empty));
        VaultArticleCoordinate localCoordinate = Seal(ancestor with
        {
            MetadataManifestSha256 = local.ContentSha256
        });
        VaultArticleCoordinate serverCoordinate = Seal(ancestor with
        {
            ServerRevision = 5,
            MetadataManifestSha256 = server.ContentSha256
        });
        const string Path = "articles/article-one.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
            new(ancestor, localCoordinate, ancestor), new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1, "site-one", "vault-one", "device-one",
            "article-one", "server-one", serverCoordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site-one", "vault-one", "device-one", [new("article-one", ".fsus/articles/article-one.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultSyncPlan plan = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-one", ["article-one"], [])], VaultSyncDirection.Sync, Now, Now + 60_000, false)).Plan!;
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
            item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity,
            article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
        ArticleVaultScalarMetadataInput metadata = new(plan, root, [article], [observation], new(Now, VaultSyncDirection.Sync, false), binding,
            ArticleVaultManifestCodec.Serialize(baseline), ArticleVaultManifestCodec.Serialize(local), ArticleVaultManifestCodec.Serialize(server));
        ArticleVaultScalarMetadataCandidate candidate = ArticleVaultScalarMetadataMerge.Build(metadata).Candidate!;
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(VaultConflictType.MetadataDisjoint)!;
        ArticleVaultConflictEvidence evidence = new(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
            binding, [new(entry.Type, entry.Disposition, entry.AllowedActions, new(entry.Type, null, candidate.Facts, null))], string.Empty);
        evidence = evidence with
        {
            ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
        };
        ArticleVaultGitFacts git = ArticleVaultGitFactsTests.Facts("source\n"u8);
        git = git with
        {
            Scope = git.Scope with
            {
                RootManifestSha256 = root.ContentSha256
            }
        };
        git = git with
        {
            ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git)
        };
        return new(metadata, evidence, git,
            [new(entry.Type, VaultConflictAction.PrepareMetadataCandidate, entry.Disposition, candidate.ContentSha256)],
            candidate, new("confirmation-one", "actor-one", Now), Now + 30_000);
    }

    internal static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };

    internal static ArticleVaultMetadataManifest Seal(ArticleVaultMetadataManifest metadata)
        => metadata with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(metadata)
        };
}
