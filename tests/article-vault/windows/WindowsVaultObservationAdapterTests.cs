using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Windows.Tests;

[Xunit.Trait("Category", "WindowsArticleVaultWatcherContract")]
public sealed class WindowsVaultObservationAdapterTests
{
    [Xunit.Fact]
    public void ProjectionPreservesCaseOrderDuplicatesAndOriginalNativeDigest()
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        VaultObservationBinding binding = Binding(root);
        WindowsVaultRawFact[] facts =
        [
            Fact(identity, 5, "Folder\\New.md"),
            Fact(identity, 3, "Folder\\New.md"),
            Fact(identity, 3, "Folder\\New.md"),
            Fact(identity, 4, "Folder\\OLD.md")
        ];
        IReadOnlyList<VaultRawObservation> projected = WindowsVaultObservationAdapter.Convert(
            root, binding, identity, facts);
        Xunit.Assert.Equal(new[] { VaultRawObservationClass.MovedTo, VaultRawObservationClass.Modified,
            VaultRawObservationClass.Modified, VaultRawObservationClass.MovedFrom },
            projected.Select(fact => fact.Class));
        Xunit.Assert.Equal("Folder/New.md", projected[0].RelativePath);
        Xunit.Assert.Equal("Folder/OLD.md", projected[3].RelativePath);
        Xunit.Assert.Equal(facts.Select(fact => fact.ContentDigest), projected.Select(fact => fact.NativeFactSha256));
        Xunit.Assert.All(projected, fact =>
        {
            Xunit.Assert.Null(fact.MoveCookie);
            Xunit.Assert.False(fact.WatermarkValid);
        });
        Xunit.Assert.Equal("Folder\\New.md", facts[0].RawNewRelativePath);
        Xunit.Assert.Equal("Folder\\OLD.md", facts[3].RawOldRelativePath);
    }

    [Xunit.Theory]
    [Xunit.InlineData(WindowsVaultFactClass.WatcherRestarted, VaultRawObservationClass.Restarted)]
    [Xunit.InlineData(WindowsVaultFactClass.BufferOverflow, VaultRawObservationClass.Overflow)]
    [Xunit.InlineData(WindowsVaultFactClass.PermissionBlocked, VaultRawObservationClass.PermissionBlocked)]
    [Xunit.InlineData(WindowsVaultFactClass.SharingBlocked, VaultRawObservationClass.PermissionBlocked)]
    [Xunit.InlineData(WindowsVaultFactClass.RootLost, VaultRawObservationClass.RootLost)]
    [Xunit.InlineData(WindowsVaultFactClass.WatchInvalidated, VaultRawObservationClass.WatchInvalidated)]
    public void NativeFailuresRemainRescanFacts(WindowsVaultFactClass nativeClass, VaultRawObservationClass kind)
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        var buffer = new WindowsVaultFactBuffer(identity, 8);
        _ = buffer.Drain();
        buffer.Failure(nativeClass, "native_failure", 32);
        WindowsVaultRawFact raw = Xunit.Assert.Single(buffer.Drain());
        VaultRawObservation result = Xunit.Assert.Single(WindowsVaultObservationAdapter.Convert(root,
            Binding(root), identity, [raw]));
        Xunit.Assert.Equal(kind, result.Class);
        Xunit.Assert.Equal("native_failure", result.ReasonCode);
        Xunit.Assert.True(result.RescanRequired);
        Xunit.Assert.False(result.WatermarkValid);
        Xunit.Assert.Equal(raw.ContentDigest, result.NativeFactSha256);
    }

    [Xunit.Theory]
    [Xunit.InlineData("..\\outside.md")]
    [Xunit.InlineData("C:\\outside.md")]
    [Xunit.InlineData("\\\\host\\share\\outside.md")]
    [Xunit.InlineData("Folder\\file:stream")]
    [Xunit.InlineData("Folder\\bad%2fname.md")]
    public void UnsafePortableProjectionRetainsFailureDigestWithoutForwardingEscape(string path)
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        WindowsVaultRawFact raw = Fact(identity, 3, path);
        VaultRawObservation result = Xunit.Assert.Single(WindowsVaultObservationAdapter.Convert(root,
            Binding(root), identity, [raw]));
        Xunit.Assert.Equal(VaultRawObservationClass.WatchInvalidated, result.Class);
        Xunit.Assert.Null(result.RelativePath);
        Xunit.Assert.True(result.RescanRequired);
        Xunit.Assert.Equal(raw.ContentDigest, result.NativeFactSha256);
        Xunit.Assert.Equal(path, raw.RawNewRelativePath);
    }

    [Xunit.Fact]
    public void PathlessAdmissionFailureRetainsItsRescanDigest()
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        var buffer = new WindowsVaultFactBuffer(identity, 8);
        _ = buffer.Drain();
        buffer.Failure(WindowsVaultFactClass.SecurityBlocked, "windows_vault_admission_unavailable");
        WindowsVaultRawFact raw = Xunit.Assert.Single(buffer.Drain());
        VaultRawObservation result = Xunit.Assert.Single(WindowsVaultObservationAdapter.Convert(root,
            Binding(root), identity, [raw]));
        Xunit.Assert.Equal(VaultRawObservationClass.WatchInvalidated, result.Class);
        Xunit.Assert.Null(result.RelativePath);
        Xunit.Assert.True(result.RescanRequired);
        Xunit.Assert.False(result.WatermarkValid);
        Xunit.Assert.Equal(raw.ContentDigest, result.NativeFactSha256);
    }

    [Xunit.Fact]
    public void ScopeDriftTamperAndInconsistentNativeActionAreRejected()
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        VaultObservationBinding binding = Binding(root);
        WindowsVaultRawFact raw = Fact(identity, 3, "Folder\\Article.md");
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding, identity with
            {
                AgentIdentity = "other"
            }, [raw]));
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding with
            {
                WatchInstanceIdentity = "other"
            }, identity, [raw]));
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding with
            {
                Scope = binding.Scope with
                {
                    ComparisonPolicy = VaultPathComparisonPolicy.Ordinal
                }
            },
            identity, [raw]));
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding, identity, [raw with { Sequence = 123 }]));
        WindowsVaultRawFact inconsistent = raw with
        {
            NativeAction = 1
        };
        inconsistent = inconsistent with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(inconsistent)
        };
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding, identity, [inconsistent]));
        WindowsVaultRawFact bothPaths = raw with
        {
            RawOldRelativePath = "Folder\\Previous.md"
        };
        bothPaths = bothPaths with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(bothPaths)
        };
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            binding, identity, [bothPaths]));
    }

    [Xunit.Fact]
    public void OversizedWindowRequiresSplitBeforeAnyOutput()
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        WindowsVaultRawFact raw = Fact(identity, 3, "Folder\\Article.md");
        Xunit.Assert.Throws<InvalidDataException>(() => WindowsVaultObservationAdapter.Convert(root,
            Binding(root), identity, Enumerable.Repeat(raw, ArticleVaultEventNormalizer.MaxRawFacts + 1).ToArray()));
    }

    [Xunit.Fact]
    public void CanonicalNormalizerConsumesProjectionAndStillCannotAdmitSync()
    {
        ArticleVaultRootManifest root = Root();
        WindowsVaultWatchIdentity identity = Identity(root);
        VaultObservationBinding binding = Binding(root);
        var buffer = new WindowsVaultFactBuffer(identity, 8);
        IReadOnlyList<WindowsVaultRawFact> facts = buffer.Drain();
        IReadOnlyList<VaultRawObservation> projected = WindowsVaultObservationAdapter.Convert(
            root, binding, identity, facts);
        VaultFilesystemObservation[] inventory = [new("Folder/Article.md", false, null)];
        var before = new VaultObservationWatermark(identity.WatchInstanceIdentity, 0,
            ArticleVaultEventNormalizer.ComputeSnapshotSha256(inventory), null);
        VaultObservationBatch batch = ArticleVaultEventNormalizer.Normalize(root, binding, before,
            projected, inventory, inventory, []);
        Xunit.Assert.False(batch.CanAdmitSynchronization);
        Xunit.Assert.True(batch.RequiresNativeAdmission);
        Xunit.Assert.All(batch.RescanObligations, obligation => Xunit.Assert.True(obligation.BlocksSynchronization));
        Xunit.Assert.NotEmpty(batch.RescanObligations);
        Xunit.Assert.Equal(Xunit.Assert.Single(facts).ContentDigest,
            Xunit.Assert.Single(Xunit.Assert.Single(batch.RawCoverage).NativeFactSha256s));
        Xunit.Assert.True(ArticleVaultEventNormalizer.Verify(root, binding, before, projected,
            inventory, inventory, [], batch).IsValid);
    }

    private static WindowsVaultRawFact Fact(WindowsVaultWatchIdentity identity, uint action, string path)
    {
        var buffer = new WindowsVaultFactBuffer(identity, 8);
        _ = buffer.Drain();
        buffer.Receive(new(action, path), new(WindowsVaultPathDisposition.MissingEntry, null));
        return Xunit.Assert.Single(buffer.Drain());
    }

    private static ArticleVaultRootManifest Root()
    {
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1,
            ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory), "site-test", "vault-test", "device-test",
            [new("portable-a", ".fsus/articles/portable-a.json", new string('b', 64), "Folder/Article.md")],
            [], string.Empty);
        return root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
    }

    private static WindowsVaultWatchIdentity Identity(ArticleVaultRootManifest root)
        => WindowsVaultRawFactContractTests.Identity() with
        {
            RootManifestSha256 = root.ContentSha256
        };

    private static VaultObservationBinding Binding(ArticleVaultRootManifest root)
        => new(new(root.SiteIdentity, root.VaultIdentity, root.DeviceIdentity, "agent-test",
            new string('a', 64), root.ContentSha256, VaultPathComparisonPolicy.OrdinalIgnoreCase), "watch-test");
}
