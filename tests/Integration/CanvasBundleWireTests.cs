namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasBundleWireTests
{
    private const long SourceRevision = 9_007_199_254_740_993;

    [Fact]
    public void SharedBundleVectorsBindExactBytesAndPreserveReferenceRequirements()
    {
        var intake = Fixture("intake");
        var raw = Wire.DecodeCanvasBundleIntake(intake);
        BytesEqual("{\"kind\":\"authoring-canvas\",\"demo\":\"检验\"}\n"u8, raw);
        BytesEqual(intake, Wire.EncodeCanvasBundleIntake(raw));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleIntake([]));

        var planBytes = Fixture("plan");
        var plan = Wire.DecodeCanvasBundlePlan(planBytes);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(raw)), plan.Digest);
        Assert.Equal(SourceRevision, plan.SourceRevision);
        Assert.Equal("Private notes 猫", plan.Title);
        Assert.Equal(3, plan.NodeCount);
        Assert.Equal(1, plan.EdgeCount);
        Assert.Equal(new CanvasBundleReference(1, 0, false, null), plan.References[0]);
        Assert.Equal(new CanvasBundleReference(2, 2, true, "named-block"), plan.References[1]);
        BytesEqual(planBytes, Wire.EncodeCanvasBundlePlan(plan));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundlePlan(plan with { SourceRevision = 0 }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundlePlan(plan with { References = [plan.References[1]] }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundlePlan(plan with { Digest = plan.Digest.ToUpperInvariant() }));

        var executeBytes = Fixture("execute");
        var execute = Wire.DecodeCanvasBundleExecute(executeBytes);
        Assert.Equal(Guid.Parse("7a7a7a7a-0000-4000-8000-000000000001"), execute.CanvasId);
        Assert.Equal(Guid.Parse("7a7a7a7a-0000-4000-8000-000000000002"), execute.CommandId);
        Assert.Equal(plan.Digest, execute.Digest);
        Assert.Equal(new CanvasBundleMapping(1, 17, null), execute.Mappings[0]);
        Assert.Equal(new CanvasBundleMapping(2, 21, SourceRevision + 1), execute.Mappings[1]);
        BytesEqual(raw, execute.Bundle);
        BytesEqual(executeBytes, Wire.EncodeCanvasBundleExecute(execute));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleExecute(execute with { CanvasId = Guid.Empty }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleExecute(execute with { Mappings = [execute.Mappings[1]] }));
        Assert.Throws<ProtocolException>(() => Wire.EncodeCanvasBundleExecute(execute with { Bundle = [] }));
    }

    [Fact]
    public void BundleExecuteDecoderRejectsMalformedRawLengthAndFallsWithinFrameBudget()
    {
        var payload = Aeds.Decode(Fixture("execute"), FrameType.CanvasBundleExecute).ToArray();
        const int rawLengthOffset = 16 * 2 + (4 + 64) + 4 + (4 + 4 + 8) * 2;
        var rawLength = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(rawLengthOffset));
        foreach (var length in new[] { -1, 0, rawLength - 1, rawLength + 1, WireLimits.CanvasBundleBytes + 1 })
        {
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(rawLengthOffset), length);
            Assert.Throws<ProtocolException>(() => Wire.DecodeCanvasBundleExecute(Aeds.Encode(FrameType.CanvasBundleExecute, payload)));
        }

        var execute = Wire.DecodeCanvasBundleExecute(Fixture("execute"));
        var maximum = execute with
        {
            Mappings = Enumerable.Range(1, WireLimits.CanvasBundleMaxReferences).Select(slot => new CanvasBundleMapping(slot, 21, null)).ToArray(),
            Bundle = new byte[WireLimits.CanvasBundleBytes],
        };
        var maxFrame = Wire.EncodeCanvasBundleExecute(maximum);
        Assert.Equal(WireLimits.CanvasBundleExecuteFrameBytes, maxFrame.Length);
        Assert.Equal(WireLimits.CanvasBundleBytes, Wire.DecodeCanvasBundleExecute(maxFrame).Bundle.Length);
    }

    private static void BytesEqual(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual) =>
        Assert.True(expected.SequenceEqual(actual), "Canvas bundle AEDS bytes differ.");

    private static byte[] Fixture(string name)
    {
        for (var at = new DirectoryInfo(AppContext.BaseDirectory); at is not null; at = at.Parent)
        {
            var path = Path.Combine(at.FullName, "tests", "Protocol", "fixtures", $"canvas-bundle-{name}.hex");
            if (File.Exists(path)) return Convert.FromHexString(File.ReadAllText(path).Trim());
        }
        throw new FileNotFoundException($"Missing independent Canvas bundle fixture {name}.");
    }
}
