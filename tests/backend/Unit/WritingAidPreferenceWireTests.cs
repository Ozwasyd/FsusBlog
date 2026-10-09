using System.Buffers;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class WritingAidPreferenceWireTests
{
    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = ReadGolden();
        return golden.RootElement.GetProperty("cases").EnumerateArray().Select(row => new object[]
        {
            row.GetProperty("name").GetString()!,
            row.GetProperty("frameType").GetInt32(),
            row.GetProperty("payloadHex").GetString()!,
            row.GetProperty("valid").GetBoolean(),
            row.GetProperty("expectedOwner").GetProperty("userScope").GetString()!,
            row.GetProperty("expectedOwner").GetProperty("siteScope").GetString()!
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void CrossStackGolden_UsesExistingDomainValidatorAndExactPayloadBytes(
        string name,
        int frameType,
        string payloadHex,
        bool expectedValid,
        string userScope,
        string siteScope)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        var owner = new WritingAidPreferenceOwner(userScope, siteScope);
        var destination = new ArrayBufferWriter<byte>();
        bool valid;
        if (frameType == (int)AedsFrameType.WritingAidPreferenceSnapshotResponse)
        {
            valid = PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(bytes, owner, out var snapshot);
            if (valid)
            {
                PodBinaryCodec.WriteWritingAidPreferenceSnapshot(snapshot!, destination);
            }
        }
        else if (frameType == (int)AedsFrameType.WritingAidPreferenceUpdateRequest)
        {
            valid = PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(bytes, out var update);
            if (valid)
            {
                PodBinaryCodec.WriteWritingAidPreferenceUpdateRequest(update!, destination);
            }
        }
        else
        {
            Assert.Equal(274, frameType);
            valid = PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(bytes, owner, out var receipt);
            if (valid)
            {
                Assert.True(WritingAidPreferenceReceiptValidator.Validate(receipt, owner), name);
                PodBinaryCodec.WriteWritingAidPreferenceReceipt(receipt!, destination);
            }
        }

        Assert.True(valid == expectedValid, name);
        if (valid)
        {
            Assert.Equal(bytes, destination.WrittenSpan.ToArray());
        }
        else
        {
            Assert.Equal(0, destination.WrittenCount);
        }
    }

    [Fact]
    public void Receipt_EveryTruncationAndSingleByteBitSubstitutionRefusesWithoutExposingValue()
    {
        byte[] bytes = ReadBytes("receipt-values-5");
        var owner = new WritingAidPreferenceOwner("account:42", "site:test");
        for (int end = 0; end < bytes.Length; end++)
        {
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(bytes.AsMemory(0, end), owner, out var receipt));
            Assert.Null(receipt);
        }

        for (int offset = 0; offset < bytes.Length; offset++)
        {
            byte[] mutated = (byte[])bytes.Clone();
            mutated[offset] ^= 1;
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(mutated, owner, out var receipt));
            Assert.Null(receipt);
        }

        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(new byte[1435], owner, out _));
    }

    [Theory]
    [InlineData("account:43", "site:test")]
    [InlineData("admin:42", "site:test")]
    [InlineData("account:42", "site:other")]
    public void Receipt_RejectsAnExplicitDifferentExpectedOwner(string userScope, string siteScope)
    {
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(
            ReadBytes("receipt-values-5"), new(userScope, siteScope), out var receipt));
        Assert.Null(receipt);
    }

    [Fact]
    public void Receipt_WriterRejectsInvalidDomainFactsBeforeEmittingAnyBytes()
    {
        var owner = new WritingAidPreferenceOwner("account:42", "site:test");
        Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceReceipt(ReadBytes("receipt-initialize"), owner, out var receipt));
        var destination = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteWritingAidPreferenceReceipt(receipt! with
        {
            ContentDigest = new string('0', 64)
        }, destination));
        Assert.Equal(0, destination.WrittenCount);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteWritingAidPreferenceReceipt(receipt! with
        {
            Action = "migrate-legacy"
        }, destination));
        Assert.Equal(0, destination.WrittenCount);
    }

    private static JsonDocument ReadGolden()
        => JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot("tests/fixtures/protocol/writing-aid-preference-wire-golden.json"));

    private static byte[] ReadBytes(string name)
    {
        using JsonDocument golden = ReadGolden();
        return Convert.FromHexString(golden.RootElement.GetProperty("cases").EnumerateArray()
            .Single(row => row.GetProperty("name").GetString() == name).GetProperty("payloadHex").GetString()!);
    }
}
