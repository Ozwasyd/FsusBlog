using System.Buffers.Binary;
using System.Reflection;
using System.Text;
using System.Text.Json;

using Xunit;

namespace FsusBlog.ArticleVault.Windows.Tests;

[Trait("Category", "WindowsArticleVaultWatcherContract")]
public sealed class WindowsVaultRawFactContractTests
{
    [Fact]
    public void RawActionsRetainDuplicatesNativeOrderAndSeparateRenameNames()
    {
        byte[] bytes = Records((5, "Folder\\new.md"), (3, "Folder\\new.md"),
            (3, "Folder\\new.md"), (4, "Folder\\OLD.md"), (2, "gone.md"), (1, "temp~"));
        var buffer = new WindowsVaultFactBuffer(Identity(), 32);
        _ = buffer.Drain();
        WindowsVaultNotifyDecoder.Decode(bytes, record => buffer.Receive(record,
            new(WindowsVaultPathDisposition.MissingEntry, null)));
        IReadOnlyList<WindowsVaultRawFact> facts = buffer.Drain();
        Assert.Equal(new uint[] { 5, 3, 3, 4, 2, 1 }, facts.Select(fact => fact.NativeAction));
        Assert.Equal("Folder\\new.md", facts[0].RawNewRelativePath);
        Assert.Equal("Folder\\OLD.md", facts[3].RawOldRelativePath);
        Assert.Null(facts[3].RawNewRelativePath);
        Assert.All(facts, fact =>
        {
            Assert.Null(fact.FileIdDiagnostic);
            Assert.Null(fact.CookieDiagnostic);
            Assert.Null(fact.SourceContentDigest);
            Assert.False(fact.WatermarkValid);
            Assert.True(WindowsVaultRawFactCodec.Verify(fact, Identity()));
        });
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(8, 3)]
    [InlineData(8, 4096)]
    [InlineData(0, 16)]
    [InlineData(0, 14)]
    public void MalformedOffsetOrNameCannotBeAdmitted(int fieldOffset, uint value)
    {
        byte[] bytes = Records((1, "a.md"));
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(fieldOffset), value);
        Assert.Throws<InvalidDataException>(() => WindowsVaultNotifyDecoder.Decode(bytes, _ =>
            Assert.Fail("Malformed first record must not be delivered.")));
    }

    [Fact]
    public void InvalidUtf16AndTruncatedHeaderFailClosed()
    {
        byte[] bytes = Records((1, "a.md"));
        bytes[12] = 0;
        bytes[13] = 0xD8;
        Assert.Throws<InvalidDataException>(() => WindowsVaultNotifyDecoder.Decode(bytes, _ =>
        {
        }));
        Assert.Throws<InvalidDataException>(() => WindowsVaultNotifyDecoder.Decode(new byte[11], _ =>
        {
        }));
    }

    [Fact]
    public void QueueOverflowPreservesFirstFactsAndReportsLossAndSequenceGap()
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        _ = buffer.Drain();
        for (int index = 0; index < 1000; index++)
        {
            buffer.Receive(new(3, $"{index}.md"), new(WindowsVaultPathDisposition.MissingEntry, null));
        }

        IReadOnlyList<WindowsVaultRawFact> first = buffer.Drain();
        Assert.Equal(8, first.Count);
        Assert.Equal("0.md", first[0].RawNewRelativePath);
        Assert.Equal("6.md", first[6].RawNewRelativePath);
        Assert.Equal(WindowsVaultFactClass.BufferOverflow, first[7].FactClass);
        Assert.True(first[7].RescanRequired);
        Assert.False(buffer.Watermark.IsValid);
        Assert.Equal("windows_vault_managed_queue_overflow", buffer.Watermark.ReasonCode);
        buffer.Receive(new(3, "next.md"), new(WindowsVaultPathDisposition.MissingEntry, null));
        Assert.True(Assert.Single(buffer.Drain()).Sequence > first[^1].Sequence + 1);
    }

    [Theory]
    [InlineData("..\\escape.md", "root_escape")]
    [InlineData("C:\\outside.md", "absolute_drive")]
    [InlineData("\\\\host\\share\\outside.md", "unc_escape")]
    [InlineData(".fsus\\vault.json", "control_tree")]
    [InlineData("junction\\private.md", "reparse")]
    [InlineData("A.md", "case_collision")]
    public void CanonicalAdmissionRejectionsRemainRawSecurityFacts(string path, string reason)
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        _ = buffer.Drain();
        buffer.Receive(new(3, path), new(WindowsVaultPathDisposition.Blocked, reason));
        WindowsVaultRawFact fact = Assert.Single(buffer.Drain());
        Assert.Equal(path, fact.RawNewRelativePath);
        Assert.Equal(WindowsVaultFactClass.SecurityBlocked, fact.FactClass);
        Assert.Equal(3u, fact.NativeAction);
        Assert.Equal(reason, fact.ReasonCode);
        Assert.True(fact.RescanRequired);
        Assert.False(buffer.Watermark.IsValid);
    }

    [Theory]
    [InlineData(WindowsVaultFactClass.BufferOverflow, 1022)]
    [InlineData(WindowsVaultFactClass.PermissionBlocked, 5)]
    [InlineData(WindowsVaultFactClass.SharingBlocked, 32)]
    [InlineData(WindowsVaultFactClass.WatchInvalidated, 6)]
    [InlineData(WindowsVaultFactClass.RootLost, 3)]
    public void FailureAndRestartAlwaysInvalidateWatermark(WindowsVaultFactClass factClass, int error)
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        WindowsVaultRawFact restart = Assert.Single(buffer.Drain());
        Assert.True(restart.RescanRequired);
        Assert.False(restart.WatermarkValid);
        buffer.Failure(factClass, "required_rescan", error);
        WindowsVaultRawFact failure = Assert.Single(buffer.Drain());
        Assert.Equal(error, failure.NativeError);
        Assert.True(failure.Sequence > restart.Sequence);
        Assert.True(failure.RescanRequired);
        Assert.False(buffer.Watermark.IsValid);
    }

    [Fact]
    public void UnsafeProducerProjectionAndPrivateReasonBecomeVerifiableBlockedFacts()
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        _ = buffer.Drain();
        buffer.Receive(new(3, "..\\outside.md"), new(WindowsVaultPathDisposition.MissingEntry, null));
        buffer.Receive(new(3, "article.md"), new(WindowsVaultPathDisposition.Blocked, "private token\ntext"));
        IReadOnlyList<WindowsVaultRawFact> facts = buffer.Drain();
        Assert.Equal("..\\outside.md", facts[0].RawNewRelativePath);
        Assert.Equal("windows_vault_observation_projection_invalid", facts[0].ReasonCode);
        Assert.Equal("windows_vault_path_blocked", facts[1].ReasonCode);
        Assert.All(facts, fact =>
        {
            Assert.Equal(WindowsVaultFactClass.SecurityBlocked, fact.FactClass);
            Assert.Equal(WindowsVaultPathDisposition.Blocked, fact.PathDisposition);
            Assert.True(fact.RescanRequired);
            Assert.True(WindowsVaultRawFactCodec.Verify(fact, Identity()));
        });
        Assert.DoesNotContain("private token", JsonSerializer.Serialize(facts));
        buffer.Failure(WindowsVaultFactClass.SecurityBlocked, "private token\ntext");
        WindowsVaultRawFact failure = Assert.Single(buffer.Drain());
        Assert.Equal("windows_vault_failure_reason_invalid", failure.ReasonCode);
        Assert.True(WindowsVaultRawFactCodec.Verify(failure, Identity()));
    }

    [Fact]
    public void MissingOrUndefinedAdmissionCannotProduceSourceFacts()
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        _ = buffer.Drain();
        buffer.Receive(new(3, "article.md"), new(WindowsVaultPathDisposition.None, null));
        buffer.Receive(new(3, "article.md"), new((WindowsVaultPathDisposition)99, null));
        Assert.All(buffer.Drain(), fact =>
        {
            Assert.Equal(WindowsVaultFactClass.SecurityBlocked, fact.FactClass);
            Assert.Equal(WindowsVaultPathDisposition.Blocked, fact.PathDisposition);
            Assert.True(fact.RescanRequired);
        });
    }

    [Fact]
    public void ReceiptMutationScopeDriftAndCleanPromotionAreRejected()
    {
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        WindowsVaultRawFact fact = Assert.Single(buffer.Drain());
        Assert.False(WindowsVaultRawFactCodec.Verify(fact with
        {
            Sequence = 999
        }, Identity()));
        Assert.False(WindowsVaultRawFactCodec.Verify(fact, Identity() with
        {
            VaultIdentity = "other"
        }));
        WindowsVaultRawFact clean = fact with
        {
            WatermarkValid = true
        };
        clean = clean with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(clean)
        };
        Assert.False(WindowsVaultRawFactCodec.Verify(clean, Identity()));
        WindowsVaultRawFact bodyDigest = fact with
        {
            SourceContentDigest = new string('a', 64)
        };
        bodyDigest = bodyDigest with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(bodyDigest)
        };
        Assert.False(WindowsVaultRawFactCodec.Verify(bodyDigest, Identity()));
    }

    [Theory]
    [InlineData(0, 8)]
    [InlineData(65540, 8)]
    [InlineData(4097, 8)]
    [InlineData(4096, int.MaxValue)]
    [InlineData(4096, 0)]
    public void UnboundedOrUnalignedResourcesAreRejected(int bytes, int capacity)
        => Assert.Throws<ArgumentOutOfRangeException>(() =>
            new WindowsVaultWatcherOptions(bytes, capacity).Validate());

    [Fact]
    public void RawFactsExposeNoWriterRootFactoryOrDigestOnlyRescanAdmission()
    {
        Type type = typeof(WindowsVaultWatcherSession);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        Assert.Empty(type.GetMethods(BindingFlags.Public | BindingFlags.Static));
        Assert.DoesNotContain(type.GetMethods(), method =>
            method.Name.Contains("Save", StringComparison.Ordinal)
                || method.Name.Contains("Acknowledge", StringComparison.Ordinal)
                || method.Name.Contains("Write", StringComparison.Ordinal));
        var buffer = new WindowsVaultFactBuffer(Identity(), 8);
        string json = JsonSerializer.Serialize(Assert.Single(buffer.Drain()));
        Assert.DoesNotContain("Token", json);
        Assert.DoesNotContain("Body", json);
        Assert.DoesNotContain("CanonicalRootPath", json);
    }

    internal static WindowsVaultWatchIdentity Identity(string instance = "watch-test")
        => new("site-test", "vault-test", "device-test", "agent-test", new string('a', 64),
            new string('b', 64), instance, "NTFS", 0, false);

    internal static byte[] Records(params (uint Action, string Path)[] records)
    {
        var bytes = new List<byte>();
        for (int index = 0; index < records.Length; index++)
        {
            byte[] name = Encoding.Unicode.GetBytes(records[index].Path);
            int length = (12 + name.Length + 3) & ~3;
            var record = new byte[length];
            BinaryPrimitives.WriteUInt32LittleEndian(record, index == records.Length - 1 ? 0 : (uint)length);
            BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(4), records[index].Action);
            BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(8), (uint)name.Length);
            name.CopyTo(record, 12);
            bytes.AddRange(record);
        }

        return bytes.ToArray();
    }
}
