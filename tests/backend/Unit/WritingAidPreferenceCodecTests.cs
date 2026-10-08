using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.InteropServices;

using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class WritingAidPreferenceCodecTests
{
    private static readonly WritingAidPreferenceOwner s_owner = new("account:42", "site:test");
    private static readonly Guid s_operation = Guid.Parse("01234567-89ab-cdef-0123-456789abcdef");

    [Fact]
    public void PayloadLayouts_KeepExactPackedSizesAndOffsets()
    {
        Assert.Equal(96, Marshal.SizeOf<WritingAidPreferenceSnapshotPod>());
        Assert.Equal(80, Marshal.SizeOf<WritingAidPreferenceUpdateRequestPod>());
        Assert.Equal(8, Marshal.OffsetOf<WritingAidPreferenceSnapshotPod>(nameof(WritingAidPreferenceSnapshotPod.Revision)).ToInt32());
        Assert.Equal(16, Marshal.OffsetOf<WritingAidPreferenceSnapshotPod>(nameof(WritingAidPreferenceSnapshotPod.UserScope)).ToInt32());
        Assert.Equal(24, Marshal.OffsetOf<WritingAidPreferenceSnapshotPod>(nameof(WritingAidPreferenceSnapshotPod.SiteScope)).ToInt32());
        Assert.Equal(32, Marshal.OffsetOf<WritingAidPreferenceSnapshotPod>(nameof(WritingAidPreferenceSnapshotPod.ContentDigest)).ToInt32());
        Assert.Equal(16, Marshal.OffsetOf<WritingAidPreferenceUpdateRequestPod>(nameof(WritingAidPreferenceUpdateRequestPod.OperationId)).ToInt32());
    }

    [Fact]
    public void CSharpPayloadVectors_MatchIndependentLittleEndianGoldenBytes()
    {
        WritingAidPreferenceSnapshot snapshot = Snapshot(new(1, true, false, true), 7);
        Assert.Equal("4a979bb470024e92faf123866eac6809e60d1c93b7ad25dd83469a3a6f91a5bc", snapshot.ContentDigest);
        Assert.Equal(Convert.FromHexString(
            "01000000010001000700000000000000000000000a0000000a00000009000000"
            + "34613937396262343730303234653932666166313233383636656163363830396536306431633933623761643235646438333436396133613666393161356263"
            + "130000006163636f756e743a3432736974653a74657374"), Encode(snapshot));
        Assert.Equal(Convert.FromHexString(
            "07000000000000000100000001000100"
            + "30313233343536372d383961622d636465662d303132332d343536373839616263646566"
            + "00000000000000000000000000000000000000000000000000000000"), Encode(new WritingAidPreferenceUpdate(7, s_operation, snapshot.Values)));
    }

    [Fact]
    public void AllEightCombinations_RoundTripAsIndependentValues()
    {
        for (int mask = 0; mask < 8; mask++)
        {
            var values = new WritingAidPreferenceValues(1, (mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0);
            WritingAidPreferenceSnapshot snapshot = Snapshot(values, WritingAidPreferenceContract.MaximumExactRevision);
            Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(Encode(snapshot), s_owner, out var observed));
            Assert.Equal(snapshot, observed);
            var update = new WritingAidPreferenceUpdate(WritingAidPreferenceContract.MaximumExactRevision - 1, s_operation, values);
            Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(Encode(update), out var command));
            Assert.Equal(update, command);
        }
        WritingAidPreferenceSnapshot defaults = Snapshot(WritingAidPreferenceContract.Defaults, 0);
        Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(Encode(defaults), s_owner, out var defaultObserved));
        Assert.Equal(defaults, defaultObserved);
    }

    [Theory]
    [InlineData("account:43", "site:test")]
    [InlineData("admin:42", "site:test")]
    [InlineData("account:42", "site:other")]
    [InlineData("guest:42", "site:test")]
    public void Snapshot_RejectsAnotherOwnerOrSite(string userScope, string siteScope)
    {
        byte[] bytes = Encode(Snapshot(WritingAidPreferenceContract.Defaults, 1));
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(bytes, new(userScope, siteScope), out var observed));
        Assert.Null(observed);
    }

    [Fact]
    public void Snapshot_EverySingleByteSubstitutionRefusesWithoutExposingAValue()
    {
        byte[] bytes = Encode(Snapshot(new(1, true, false, true), 7));
        for (int offset = 0; offset < bytes.Length; offset++)
        {
            byte[] mutated = (byte[])bytes.Clone();
            mutated[offset] ^= 1;
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(mutated, s_owner, out var observed));
            Assert.Null(observed);
        }
    }

    [Fact]
    public void BothPayloads_RejectEveryTruncationAndTrailingData()
    {
        byte[] snapshot = Encode(Snapshot(WritingAidPreferenceContract.Defaults, 1));
        byte[] update = Encode(new WritingAidPreferenceUpdate(0, s_operation, WritingAidPreferenceContract.Defaults));
        for (int length = 0; length < snapshot.Length; length++)
        {
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(snapshot.AsMemory(0, length), s_owner, out _));
        }
        for (int length = 0; length < update.Length; length++)
        {
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(update.AsMemory(0, length), out _));
        }
        byte[] trailingSnapshot = [.. snapshot, 0];
        byte[] trailingUpdate = [.. update, 0];
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(trailingSnapshot, s_owner, out _));
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(trailingUpdate, out _));
    }

    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(513)]
    [InlineData(int.MaxValue)]
    public void Snapshot_HostileBlobLengthsRefuseBeforeCommonReaderArithmetic(int length)
    {
        byte[] bytes = Encode(Snapshot(WritingAidPreferenceContract.Defaults, 1));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(96), length);
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(bytes, s_owner, out _));
    }

    [Fact]
    public void Snapshot_InvalidUtf8InOwnerOrDigestRefuses()
    {
        foreach (int offset in new[] { 32, 100 })
        {
            byte[] bytes = Encode(Snapshot(WritingAidPreferenceContract.Defaults, 1));
            bytes[offset] = 0xff;
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(bytes, s_owner, out _));
        }
    }

    [Fact]
    public void Snapshot_UsesUtf8ByteSlicesForAnExactMaximumLengthSiteCoordinate()
    {
        var owner = new WritingAidPreferenceOwner("account:42", "site:" + new string('\u754c', 123));
        WritingAidPreferenceValues values = WritingAidPreferenceContract.Defaults;
        var snapshot = new WritingAidPreferenceSnapshot(owner, 1, values,
            WritingAidPreferenceValidator.ComputeDigest(owner, 1, values));
        byte[] bytes = Encode(snapshot);
        Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(bytes, owner, out var observed));
        Assert.Equal(snapshot, observed);
    }

    [Fact]
    public void Update_RejectsUnknownSchemaBooleansReservedIdentityAndUnsafeRevision()
    {
        byte[] valid = Encode(new WritingAidPreferenceUpdate(7, s_operation, WritingAidPreferenceContract.Defaults));
        foreach ((int offset, byte value) in new (int, byte)[]
        {
            (8, 2), (12, 2), (13, 2), (14, 2), (15, 1), (16, 0xff), (26, (byte)'A'), (52, 1), (79, 1)
        })
        {
            byte[] bytes = (byte[])valid.Clone();
            bytes[offset] = value;
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(bytes, out var observed));
            Assert.Null(observed);
        }
        foreach (long revision in new[] { -1L, WritingAidPreferenceContract.MaximumExactRevision, long.MaxValue })
        {
            byte[] bytes = (byte[])valid.Clone();
            BinaryPrimitives.WriteInt64LittleEndian(bytes, revision);
            Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(bytes, out _));
        }
        byte[] emptyIdentity = (byte[])valid.Clone();
        "00000000-0000-0000-0000-000000000000"u8.CopyTo(emptyIdentity.AsSpan(16));
        Assert.False(PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(emptyIdentity, out _));
    }

    [Fact]
    public void Writers_RejectInvalidFactsWithoutEmittingPartialPayloads()
    {
        WritingAidPreferenceSnapshot valid = Snapshot(WritingAidPreferenceContract.Defaults, 0);
        var destination = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteWritingAidPreferenceSnapshot(valid with { ContentDigest = new string('0', 64) }, destination));
        Assert.Equal(0, destination.WrittenCount);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteWritingAidPreferenceSnapshot(Snapshot(new(1, true, false, false), 0), destination));
        Assert.Equal(0, destination.WrittenCount);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteWritingAidPreferenceUpdateRequest(new(0, Guid.Empty, WritingAidPreferenceContract.Defaults), destination));
        Assert.Equal(0, destination.WrittenCount);
    }

    private static WritingAidPreferenceSnapshot Snapshot(WritingAidPreferenceValues values, long revision)
        => new(s_owner, revision, values, WritingAidPreferenceValidator.ComputeDigest(s_owner, revision, values));

    private static byte[] Encode(WritingAidPreferenceSnapshot snapshot)
    {
        var writer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteWritingAidPreferenceSnapshot(snapshot, writer);
        return writer.WrittenSpan.ToArray();
    }

    private static byte[] Encode(WritingAidPreferenceUpdate update)
    {
        var writer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteWritingAidPreferenceUpdateRequest(update, writer);
        return writer.WrittenSpan.ToArray();
    }
}
