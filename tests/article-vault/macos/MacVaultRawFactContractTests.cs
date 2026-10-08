using FsusBlog.ArticleVault.MacOS;

using Xunit;

namespace FsusBlog.ArticleVault.MacOS.Tests;

[Trait("Category", "MacArticleVaultRawFactContract")]
public sealed class MacVaultRawFactContractTests
{
    internal static MacVaultWatchIdentity Identity() => new("site-a", "vault-a", "device-a", "agent-a",
        new string('a', 64), new string('b', 64), "watch-a",
        new("apfs", "volume-a", false, "canonical-equivalence", 1, 2));

    internal static MacVaultRawFact Fact(long sequence = 1) => MacVaultRawFactCodec.Seal(new(
        MacVaultWatcherSchemas.RawFact, 1, "macos", Identity(), sequence, 101, 0x100,
        MacVaultFactClass.NativeEvent, "article.md", null, "article.md", 7, 1, 1,
        MacVaultPathDisposition.SourceProjection, "mac_vault_rescan_pending", true, false, string.Empty));

    [Fact]
    public void NativeFactRequiresExactIndependentWatchBindingAndDigest()
    {
        MacVaultRawFact fact = Fact();
        Assert.True(MacVaultRawFactCodec.Validate(fact, Identity()));
        Assert.False(MacVaultRawFactCodec.Validate(fact with
        {
            NativeFlags = 0x200
        }, Identity()));
        Assert.False(MacVaultRawFactCodec.Validate(fact, Identity() with
        {
            WatchInstanceIdentity = "other-watch"
        }));
        Assert.False(MacVaultRawFactCodec.Validate(fact, Identity() with
        {
            SiteIdentity = "other-site"
        }));
    }

    [Theory]
    [InlineData(0x1u)]
    [InlineData(0x2u)]
    [InlineData(0x4u)]
    [InlineData(0x8u)]
    public void NativeLossFlagsInvalidateWatermarkWithoutGuessingOperation(uint flags)
    {
        Assert.Equal("mac_vault_native_gap", MacVaultWatcherSession.RawReason(flags, 200, 100));
    }

    [Theory]
    [InlineData(0x20u, "mac_vault_root_changed")]
    [InlineData(0x40u, "mac_vault_mount_changed")]
    [InlineData(0x80u, "mac_vault_unmounted")]
    [InlineData(0x80000000u, "mac_vault_native_flags_unknown")]
    public void RootAndUnknownFlagsRequireRescan(uint flags, string reason)
    {
        Assert.Equal(reason, MacVaultWatcherSession.RawReason(flags, 0, 100));
    }

    [Fact]
    public void GlobalEventIdsAreNotConsecutiveButDuplicatesAndOutOfOrderStayAuditable()
    {
        Assert.Equal("mac_vault_rescan_pending", MacVaultWatcherSession.RawReason(0x100, 10000, 100));
        Assert.Equal("mac_vault_event_id_nonmonotonic", MacVaultWatcherSession.RawReason(0x100, 100, 100));
        Assert.Equal("mac_vault_event_id_nonmonotonic", MacVaultWatcherSession.RawReason(0x100, 99, 100));
    }

    [Fact]
    public void BoundedQueuePreservesPriorAuditsAndOneReservedOverflowSlot()
    {
        var buffer = new MacVaultRawFactBuffer(8);
        for (long sequence = 1; sequence <= 8; sequence++)
        {
            Assert.True(buffer.TryAppend(Fact(sequence)));
        }

        Assert.False(buffer.TryAppend(Fact(9)));
        MacVaultRawFact overflow = MacVaultRawFactCodec.Seal(Fact(10) with
        {
            FactClass = MacVaultFactClass.DeliveryOverflow,
            NativeEventId = null,
            NativeFlags = 0,
            RawObservedRelativePath = null,
            RawNewRelativePath = null,
            FileIdDiagnostic = null,
            PathDisposition = MacVaultPathDisposition.None,
            ErrorCode = "mac_vault_delivery_overflow"
        });
        buffer.RecordOverflow(overflow);
        buffer.RecordOverflow(Fact(11));
        Assert.False(buffer.TryAppend(Fact(12)));
        IReadOnlyList<MacVaultRawFact> facts = buffer.Drain();
        Assert.Equal(9, facts.Count);
        Assert.Equal(Enumerable.Range(1, 8).Select(static item => (long)item), facts.Take(8).Select(static item => item.Sequence));
        Assert.Equal(overflow, facts[^1]);
        Assert.True(MacVaultRawFactCodec.Validate(facts[^1], Identity()));
        Assert.True(buffer.TryAppend(Fact(13)));
    }

    [Fact]
    public void RenameCannotAcquireInventedOldNewPairOrFileIdentityAuthority()
    {
        MacVaultRawFact rename = MacVaultRawFactCodec.Seal(Fact() with
        {
            NativeFlags = 0x800,
            RawNewRelativePath = null
        });
        Assert.True(MacVaultRawFactCodec.Validate(rename, Identity()));
        Assert.False(MacVaultRawFactCodec.Validate(MacVaultRawFactCodec.Seal(rename with
        {
            RawOldRelativePath = "old.md",
            RawNewRelativePath = "new.md"
        }), Identity()));
        Assert.Equal(Identity(), rename.Identity);
    }

    [Theory]
    [InlineData("../outside.md")]
    [InlineData("/private/outside.md")]
    [InlineData("article.md\nprivate-body")]
    [InlineData("folder\\outside.md")]
    public void ReceiptCannotExposeUnsafeProjection(string path)
    {
        MacVaultRawFact fact = MacVaultRawFactCodec.Seal(Fact() with
        {
            RawObservedRelativePath = path,
            RawNewRelativePath = path
        });
        Assert.False(MacVaultRawFactCodec.Validate(fact, Identity()));
    }

    [Fact]
    public void ResealingCannotPromoteObservationToCleanOrHideFailure()
    {
        Assert.False(MacVaultRawFactCodec.Validate(MacVaultRawFactCodec.Seal(Fact() with
        {
            WatermarkValid = true,
            RescanRequired = false,
            ErrorCode = null
        }), Identity()));
        Assert.False(MacVaultRawFactCodec.Validate(MacVaultRawFactCodec.Seal(Fact() with
        {
            ErrorCode = "private body or token"
        }), Identity()));
    }

    [Fact]
    public void ResourceBoundsAndUnsupportedPlatformFailClosed()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new MacVaultWatcherOptions(0, 8).Validate());
        Assert.Throws<ArgumentOutOfRangeException>(() => new MacVaultWatcherOptions(8, 16385).Validate());
        if (!OperatingSystem.IsMacOS())
        {
            MacVaultWatcherException exception = Assert.Throws<MacVaultWatcherException>(() => MacVaultWatcherSession.Open(
                new("/unavailable", null!, "agent-a", new())));
            Assert.Equal("mac_vault_platform_required", exception.ReasonCode);
        }
    }
}
