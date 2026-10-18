using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringExtensions;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class AuthoringExtensionApprovalTransportWireTests
{
    public static IEnumerable<object[]> Cases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/authoring-extension-approval-wire-golden.json"));
        return golden.RootElement.GetProperty("cases").EnumerateArray().Select(row => new object[]
        {
            row.GetProperty("record").GetString()!, row.GetProperty("name").GetString()!,
            row.GetProperty("payloadHex").GetString()!, row.GetProperty("valid").GetBoolean()
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void OriginalCanonicalCodec_RefusesMalformedFramesAndEveryTruncatedPrefix(
        string record, string name, string payloadHex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        var decoder = typeof(PodBinaryCodec).GetMethod("TryDecode" + record)!;
        object?[] args = [new ReadOnlyMemory<byte>(bytes), null];
        bool valid = (bool)decoder.Invoke(null, args)!;
        Assert.True(valid == expectedValid, name);
        if (!valid)
        {
            return;
        }
        Assert.Equal(bytes, (byte[])typeof(PodBinaryCodec).GetMethod("Encode" + record)!.Invoke(null, [args[1]])!);
        for (int length = 0; length < bytes.Length; length++)
        {
            Assert.False((bool)decoder.Invoke(null, [new ReadOnlyMemory<byte>(bytes, 0, length), null])!, name);
        }
    }

    [Fact]
    public void TransportRecords_ContainNoHostClaimsActualResultsOrCallerPermissions()
    {
        Type[] records = [typeof(AuthoringExtensionApprovalDecisionRequest),
            typeof(AuthoringExtensionApprovalConfirmationRequest), typeof(AuthoringExtensionApprovalPreviewResponse)];
        Assert.All(records, type => Assert.DoesNotContain(type.GetProperties(), property =>
            property.Name is "Actor" or "Permissions" or "ApprovedClaim" or "ExecutionResult" or "AppliedSnapshot"));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeAuthoringExtensionApprovalDecisionRequest(new(1, new string('a', 64))));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeAuthoringExtensionApprovalDecisionRequest(new(2, new string('A', 64))));
    }
}
