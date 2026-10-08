using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultSourceAdmissionTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void ActualThreeSourceSnapshots_BindOriginalBlockedPlanWithoutIncreasingAuthority()
    {
        ArticleVaultSourceAdmissionInput input = Input();
        ArticleVaultSourceAdmissionResult result = ArticleVaultAdmittedSource.AdmitCurrent(input);
        ArticleVaultAdmittedSource source = Assert.IsType<ArticleVaultAdmittedSource>(result.Source);
        Assert.Null(result.ReasonCode);
        Assert.Equal(input.Binding, source.Binding);
        Assert.Equal(input.BaseBytes.ToArray(), source.CopyBaseBytes());
        Assert.Equal(input.LocalBytes.ToArray(), source.CopyLocalBytes());
        Assert.Equal(input.ServerBytes.ToArray(), source.CopyServerBytes());
        Assert.Equal(VaultSyncPlanStatus.Blocked, input.Plan.Status);
        Assert.Empty(input.Plan.OperationOrder);
        Assert.Empty(typeof(ArticleVaultAdmittedSource).GetConstructors());
        Assert.DoesNotContain(typeof(ArticleVaultAdmittedSource).GetProperties(), static property => property.CanWrite);
    }

    [Fact]
    public void CallerBuffersAndReturnedCopies_CannotMutateProcessOwnedProof()
    {
        ArticleVaultSourceAdmissionInput input = Input();
        byte[] local = input.LocalBytes.ToArray();
        ArticleVaultAdmittedSource source = Assert.IsType<ArticleVaultAdmittedSource>(
            ArticleVaultAdmittedSource.AdmitCurrent(input with
            {
                LocalBytes = local
            }).Source);
        byte[] original = source.CopyLocalBytes();
        local[0] ^= 1;
        byte[] exported = source.CopyLocalBytes();
        exported[0] ^= 1;
        Assert.Equal(original, source.CopyLocalBytes());
    }

    [Fact]
    public void MissingTamperedCrossSnapshotAndInvalidUtf8Bytes_FailClosed()
    {
        ArticleVaultSourceAdmissionInput input = Input();
        foreach (ArticleVaultSourceAdmissionInput invalid in new[]
        {
            input with { BaseBytes = ReadOnlyMemory<byte>.Empty },
            input with { BaseBytes = input.LocalBytes },
            input with { LocalBytes = Encoding.UTF8.GetBytes("unplanned bytes") },
            input with { ServerBytes = new byte[] { 0xff } }
        })
        {
            ArticleVaultSourceAdmissionResult result = ArticleVaultAdmittedSource.AdmitCurrent(invalid);
            Assert.Null(result.Source);
            Assert.NotNull(result.ReasonCode);
        }
        Assert.Null(ArticleVaultAdmittedSource.AdmitCurrent(null).Source);
    }

    [Fact]
    public void ExactCurrentPlanOperationBindingAndCoordinateDrift_AreRechecked()
    {
        ArticleVaultSourceAdmissionInput input = Input();
        VaultConflictBinding[] bindings =
        [
            input.Binding with { SiteIdentity = "site-other" },
            input.Binding with { VaultIdentity = "vault-other" },
            input.Binding with { DeviceIdentity = "device-other" },
            input.Binding with { PortableArticleIdentity = "article-other" },
            input.Binding with { ServerArticleIdentity = "server-other" },
            input.Binding with { PlanSha256 = Digest },
            input.Binding with { GroupIdentity = "group-other" },
            input.Binding with { OperationIdentity = "operation-other" },
            input.Binding with { ArticleManifestSha256 = Digest },
            input.Binding with { ServerObservationSha256 = Digest },
            input.Binding with { Coordinates = input.Binding.Coordinates with
            {
                Base = Seal(input.Binding.Coordinates.Base with { ServerRevision = 2 })
            } }
        ];
        foreach (VaultConflictBinding binding in bindings)
        {
            Assert.Null(ArticleVaultAdmittedSource.AdmitCurrent(input with
            {
                Binding = binding
            }).Source);
        }
        ArticleVaultServerObservation changed = input.Observations[0] with
        {
            ServerCoordinate = Seal(input.Observations[0].ServerCoordinate with
            {
                ServerRevision = 6
            })
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(changed)
        };
        Assert.Equal("article_vault_plan_coordinate_drift", ArticleVaultAdmittedSource.AdmitCurrent(
            input with
            {
                Observations = [changed]
            }).ReasonCode);
        Assert.Equal("article_vault_plan_expired", ArticleVaultAdmittedSource.AdmitCurrent(
            input with
            {
                Context = input.Context with
                {
                    NowUnixMs = 1_800_000_060_001
                }
            }).ReasonCode);
    }

    private static ArticleVaultSourceAdmissionInput Input()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("\uFEFFFirst 😀 paragraph.  \r\n\r\nSecond paragraph.\r\n");
        byte[] local = Encoding.UTF8.GetBytes("\uFEFFLocal 😀 paragraph.  \r\n\r\nSecond paragraph.\r\n");
        byte[] server = Encoding.UTF8.GetBytes("\uFEFFFirst 😀 paragraph.  \r\n\r\nRemote paragraph.\r\n");
        VaultArticleCoordinate baseCoordinate = Seal(new(ArticleVaultSchemas.Coordinate, 1, true, false, 4,
            ArticleVaultManifestCodec.CaptureSourceBytes(baseline), Digest, Digest, "draft", Digest, string.Empty));
        VaultArticleCoordinate localCoordinate = Seal(baseCoordinate with
        {
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(local)
        });
        VaultArticleCoordinate serverCoordinate = Seal(baseCoordinate with
        {
            ServerRevision = 5,
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(server)
        });
        const string Path = "articles/article-primary.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1, "site-primary", "vault-primary", "device-primary",
            "article-primary", "server-primary", new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
            new(baseCoordinate, localCoordinate, baseCoordinate), new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultServerObservation observation = new(ArticleVaultPlanSchemas.ServerObservation, 1, article.SiteIdentity,
            article.VaultIdentity, article.DeviceIdentity, article.PortableArticleIdentity, article.ServerArticleIdentity, serverCoordinate, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            [new(article.PortableArticleIdentity, ".fsus/articles/article-primary.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-primary", [article.PortableArticleIdentity], [])], VaultSyncDirection.Sync,
            1_800_000_000_000, 1_800_000_060_000, false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
            item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity, item.OperationIdentity,
            article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server));
        return new(plan, root, [article], [observation], new(1_800_000_000_000, VaultSyncDirection.Sync, false), binding, baseline, local, server);
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };
}
