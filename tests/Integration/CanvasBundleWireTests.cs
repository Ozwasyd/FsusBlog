namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasBundleWireTests
{
    private const long SourceRevision = 9_007_199_254_740_993;

    [Fact]
    public void SharedBundleVectorsBindExactBytesAndPreserveReferenceRequirements()
    {
        var intake = CanvasFixture.ProtocolFixture("canvas-bundle-intake");
        var raw = Wire.DecodeCanvasBundleIntake(intake);
        BytesEqual("{\"kind\":\"authoring-canvas\",\"demo\":\"检验\"}\n"u8, raw);
        BytesEqual(intake, Wire.EncodeCanvasBundleIntake(raw));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleIntake([]));

        var planBytes = CanvasFixture.ProtocolFixture("canvas-bundle-plan");
        var plan = Wire.DecodeCanvasBundlePlan(planBytes);
        Assert.Equal((Convert.ToHexStringLower(SHA256.HashData(raw)), SourceRevision, "Private notes 猫", 3, 1,
            new CanvasBundleReference(1, 0, false, null), new CanvasBundleReference(2, 2, true, "named-block")),
            (plan.Digest, plan.SourceRevision, plan.Title, plan.NodeCount, plan.EdgeCount, plan.References[0], plan.References[1]));
        BytesEqual(planBytes, Wire.EncodeCanvasBundlePlan(plan));
        foreach (var bad in new[]
        {
            plan with { SourceRevision = 0 }, plan with { References = [plan.References[1]] },
            plan with { Digest = plan.Digest.ToUpperInvariant() },
        })
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundlePlan(bad));

        var executeBytes = CanvasFixture.ProtocolFixture("canvas-bundle-execute");
        var execute = Wire.DecodeCanvasBundleExecute(executeBytes);
        Assert.Equal((Guid.Parse("7a7a7a7a-0000-4000-8000-000000000001"), Guid.Parse("7a7a7a7a-0000-4000-8000-000000000002"),
            plan.Digest, new CanvasBundleMapping(1, 17, null), new CanvasBundleMapping(2, 21, SourceRevision + 1)),
            (execute.CanvasId, execute.CommandId, execute.Digest, execute.Mappings[0], execute.Mappings[1]));
        BytesEqual(raw, execute.Bundle);
        BytesEqual(executeBytes, Wire.EncodeCanvasBundleExecute(execute));
        foreach (var bad in new[]
        {
            execute with { CanvasId = Guid.Empty }, execute with { Mappings = [execute.Mappings[1]] }, execute with { Bundle = [] },
        })
            Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleExecute(bad));
    }

    [Fact]
    public void BundleExecuteDecoderRejectsMalformedRawLengthAndFallsWithinFrameBudget()
    {
        var executeBytes = CanvasFixture.ProtocolFixture("canvas-bundle-execute");
        var payload = Aeds.Decode(executeBytes, FrameType.CanvasBundleExecute).ToArray();
        const int rawLengthOffset = 16 * 2 + (4 + 64) + 4 + (4 + 4 + 8) * 2;
        var rawLength = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(rawLengthOffset));
        foreach (var length in new[] { -1, 0, rawLength - 1, rawLength + 1, WireLimits.CanvasBundleBytes + 1 })
        {
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(rawLengthOffset), length);
            Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasBundleExecute(Aeds.Encode(FrameType.CanvasBundleExecute, payload)));
        }

        var maximum = Wire.DecodeCanvasBundleExecute(executeBytes) with
        {
            Mappings = Enumerable.Range(1, WireLimits.CanvasBundleMaxReferences).Select(slot => new CanvasBundleMapping(slot, 21, null)).ToArray(),
            Bundle = new byte[WireLimits.CanvasBundleBytes],
        };
        var maxFrame = Wire.EncodeCanvasBundleExecute(maximum);
        Assert.Equal((WireLimits.CanvasBundleExecuteFrameBytes, WireLimits.CanvasBundleBytes),
            (maxFrame.Length, Wire.DecodeCanvasBundleExecute(maxFrame).Bundle.Length));
    }

    private static void BytesEqual(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual) =>
        Assert.True(expected.SequenceEqual(actual), "Canvas bundle AEDS bytes differ.");
}
