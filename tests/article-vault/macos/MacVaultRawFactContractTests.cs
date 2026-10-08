using FsusBlog.ArticleVault.MacOS;
using FsusBlog.Shared.Contracts.ArticleVault;

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

    [Fact]
    public void CanonicalObservationAdapterRetainsNativeDigestWithoutPromotingAdmission()
    {
        MacVaultRawFact fact = Fact();
        VaultObservationBinding binding = MacVaultObservationAdapter.Binding(Identity());
        VaultRawObservation observation = Assert.Single(MacVaultObservationAdapter.Convert(binding, Identity(), [fact]));
        Assert.Equal(VaultRawObservationClass.Created, observation.Class);
        Assert.Equal(fact.Sequence, observation.Sequence);
        Assert.Equal(fact.ContentSha256, observation.NativeFactSha256);
        Assert.True(observation.RescanRequired);
        Assert.False(observation.WatermarkValid);
        Assert.Null(observation.MoveCookie);
        Assert.Equal(VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase, binding.Scope.ComparisonPolicy);
    }

    [Fact]
    public void CanonicalObservationAdapterRejectsCrossWatchComparisonAndResealedIdentity()
    {
        VaultObservationBinding binding = MacVaultObservationAdapter.Binding(Identity());
        Assert.Throws<InvalidDataException>(() => MacVaultObservationAdapter.Convert(
            binding with
            {
                WatchInstanceIdentity = "other-watch"
            }, Identity(), [Fact()]));
        Assert.Throws<InvalidDataException>(() => MacVaultObservationAdapter.Convert(
            binding with
            {
                Scope = binding.Scope with
                {
                    ComparisonPolicy = VaultPathComparisonPolicy.Ordinal
                }
            }, Identity(), [Fact()]));
        MacVaultRawFact changed = MacVaultRawFactCodec.Seal(Fact() with
        {
            Identity = Identity() with
            {
                AgentIdentity = "other-agent"
            }
        });
        Assert.Throws<InvalidDataException>(() => MacVaultObservationAdapter.Convert(binding, Identity(), [changed]));
    }

    [Fact]
    public void CanonicalObservationAdapterKeepsUnpairedRenameAndCoalescedOperationsUnknown()
    {
        VaultObservationBinding binding = MacVaultObservationAdapter.Binding(Identity());
        MacVaultRawFact rename = MacVaultRawFactCodec.Seal(Fact() with
        {
            NativeFlags = 0x800,
            RawNewRelativePath = null
        });
        MacVaultRawFact coalesced = MacVaultRawFactCodec.Seal(Fact(2) with
        {
            NativeFlags = 0x1100
        });
        IReadOnlyList<VaultRawObservation> observations = MacVaultObservationAdapter.Convert(binding, Identity(), [rename, coalesced]);
        Assert.All(observations, static observation => Assert.Equal(VaultRawObservationClass.Unknown, observation.Class));
        Assert.All(observations, static observation => Assert.Null(observation.MoveCookie));
        Assert.Equal(rename.ContentSha256, observations[0].NativeFactSha256);
        Assert.Equal(coalesced.ContentSha256, observations[1].NativeFactSha256);
    }

    [Fact]
    public void CanonicalObservationAdapterRefusesOverBoundDeliveryAndMapsLoss()
    {
        VaultObservationBinding binding = MacVaultObservationAdapter.Binding(Identity());
        MacVaultRawFact[] overBound = Enumerable.Range(1, ArticleVaultEventNormalizer.MaxRawFacts + 1)
            .Select(static sequence => Fact(sequence)).ToArray();
        Assert.Throws<InvalidDataException>(() => MacVaultObservationAdapter.Convert(binding, Identity(), overBound));
        MacVaultRawFact gap = MacVaultRawFactCodec.Seal(Fact() with
        {
            NativeFlags = 0x101,
            ErrorCode = "mac_vault_native_gap"
        });
        VaultRawObservation observed = Assert.Single(MacVaultObservationAdapter.Convert(binding, Identity(), [gap]));
        Assert.Equal(VaultRawObservationClass.WatchInvalidated, observed.Class);
        Assert.True(observed.RescanRequired);
        Assert.False(observed.WatermarkValid);
    }

    [Theory]
    [InlineData(0x100u, VaultRawObservationClass.Created)]
    [InlineData(0x1000u, VaultRawObservationClass.Modified)]
    [InlineData(0x400u, VaultRawObservationClass.AttributesChanged)]
    [InlineData(0x400000u, VaultRawObservationClass.Unknown)]
    [InlineData(0x80000100u, VaultRawObservationClass.WatchInvalidated)]
    public void CanonicalObservationAdapterMapsOnlyFiniteUnambiguousRoles(uint flags, VaultRawObservationClass expected)
    {
        MacVaultRawFact fact = MacVaultRawFactCodec.Seal(Fact() with
        {
            NativeFlags = flags
        });
        VaultRawObservation observation = Assert.Single(MacVaultObservationAdapter.Convert(
            MacVaultObservationAdapter.Binding(Identity()), Identity(), [fact]));
        Assert.Equal(expected, observation.Class);
        Assert.Equal(fact.ContentSha256, observation.NativeFactSha256);
        Assert.True(observation.RescanRequired);
        Assert.False(observation.WatermarkValid);
    }
}
