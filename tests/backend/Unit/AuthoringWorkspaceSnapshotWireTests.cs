using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class AuthoringWorkspaceSnapshotWireTests
{
    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json"));
        return golden.RootElement.GetProperty("cases").EnumerateArray()
            .Select(row => new object[]
            {
                row.GetProperty("name").GetString()!,
                row.GetProperty("frameType").GetInt32(),
                row.GetProperty("payloadHex").GetString()!,
                row.GetProperty("valid").GetBoolean()
            }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void CrossStackGolden_UsesActualClosedCodec(string name, int frameType, string payloadHex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        if (frameType == 270)
        {
            bool valid = PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotRequest(bytes, out AuthoringWorkspaceSnapshotRequest value);
            Assert.True(valid == expectedValid, name);
            if (valid)
            {
                Assert.Equal(bytes, PodBinaryCodec.EncodeAuthoringWorkspaceSnapshotRequest(value));
            }
        }
        else
        {
            Assert.Equal(271, frameType);
            bool valid = PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotResponse(bytes, out AuthoringWorkspaceSnapshotResponse value);
            Assert.True(valid == expectedValid, name);
            if (valid)
            {
                Assert.Equal(bytes, PodBinaryCodec.EncodeAuthoringWorkspaceSnapshotResponse(value));
            }
        }
    }

    [Fact]
    public void EverySmallTruncationAndOversizedPayload_FailsClosed()
    {
        byte[] request = ReadBytes("write-1");
        for (int end = 0; end < request.Length; end++)
        {
            Assert.False(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotRequest(request.AsMemory(0, end), out _));
        }
        byte[] response = ReadBytes("current-1");
        for (int end = 0; end < response.Length; end++)
        {
            Assert.False(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotResponse(response.AsMemory(0, end), out _));
        }
        Assert.False(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotRequest(new byte[65537], out _));
        Assert.False(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotResponse(new byte[65537], out _));
    }

    [Fact]
    public void SourceAndReceiptBindings_AreTypedAndMandatory()
    {
        Assert.True(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotRequest(ReadBytes("write-0"), out AuthoringWorkspaceSnapshotRequest request));
        Assert.Throws<FormatException>(() => PodBinaryCodec.EncodeAuthoringWorkspaceSnapshotRequest(request with
        {
            SourceDigest = new string('A', 64)
        }));
        Assert.Throws<FormatException>(() => PodBinaryCodec.EncodeAuthoringWorkspaceSnapshotRequest(request with
        {
            ResetConfirmationDigest = new string('b', 64)
        }));
        Assert.True(PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotResponse(ReadBytes("current-1"), out AuthoringWorkspaceSnapshotResponse response));
        Assert.Throws<FormatException>(() => PodBinaryCodec.EncodeAuthoringWorkspaceSnapshotResponse(response with
        {
            Receipt = response.Receipt with
            {
                Scope = response.Receipt.Scope with
                {
                    UserId = response.Receipt.Scope.UserId + 1
                }
            }
        }));
    }

    private static byte[] ReadBytes(string name)
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json"));
        return Convert.FromHexString(golden.RootElement.GetProperty("cases").EnumerateArray()
            .Single(row => row.GetProperty("name").GetString() == name).GetProperty("payloadHex").GetString()!);
    }
}
