namespace FsusBlog.V2.Contracts;

public sealed record CanvasBundleReference(int Slot, int Kind, bool Pinned, string? Anchor);
public sealed record CanvasBundlePlan(string Digest, long SourceRevision, string Title, int NodeCount, int EdgeCount,
    IReadOnlyList<CanvasBundleReference> References);
public sealed record CanvasBundleMapping(int Slot, int ArticleId, long? PinnedRevision);
public sealed record CanvasBundleExecute(Guid CanvasId, Guid CommandId, string Digest,
    IReadOnlyList<CanvasBundleMapping> Mappings, byte[] Bundle);

public static partial class Wire
{
    private const int CanvasBundleDigestBytes = 64;
    public const string CanvasBundleContentType = "application/vnd.fsus.canvas+json";

    public static byte[] EncodeCanvasBundleIntake(ReadOnlySpan<byte> bundle)
    {
        ValidateCanvasBundleSize(bundle.Length);
        return Aeds.Encode(FrameType.CanvasBundleIntake, bundle);
    }

    public static byte[] DecodeCanvasBundleIntake(ReadOnlySpan<byte> frame)
    {
        var bundle = Aeds.Decode(frame, FrameType.CanvasBundleIntake);
        ValidateCanvasBundleSize(bundle.Length);
        return bundle.ToArray();
    }

    public static byte[] EncodeCanvasBundlePlan(CanvasBundlePlan plan)
    {
        ValidateCanvasBundlePlan(plan);
        var output = new Writer();
        output.Text(plan.Digest, CanvasBundleDigestBytes);
        output.I64(plan.SourceRevision);
        output.Text(plan.Title, WireLimits.TitleBytes);
        output.I32(plan.NodeCount);
        output.I32(plan.EdgeCount);
        output.I32(plan.References.Count);
        foreach (var reference in plan.References)
        {
            output.I32(reference.Slot);
            output.I32(reference.Kind);
            output.Bool(reference.Pinned);
            output.Text(reference.Anchor ?? "", WireLimits.CanvasGraphAnchorBytes);
        }
        return Aeds.Encode(FrameType.CanvasBundlePlan, output.Written);
    }

    public static CanvasBundlePlan DecodeCanvasBundlePlan(ReadOnlySpan<byte> frame)
    {
        var input = new Reader(Aeds.Decode(frame, FrameType.CanvasBundlePlan));
        var digest = input.Text(CanvasBundleDigestBytes);
        var revision = input.I64();
        var title = input.Text(WireLimits.TitleBytes);
        var nodes = input.I32();
        var edges = input.I32();
        var references = new CanvasBundleReference[input.Count(0, WireLimits.CanvasBundleMaxReferences, CanvasProtocolError)];
        for (var i = 0; i < references.Length; i++)
        {
            var slot = input.I32();
            var kind = input.I32();
            var pinned = input.Bool();
            var anchor = input.Text(WireLimits.CanvasGraphAnchorBytes);
            references[i] = new(slot, kind, pinned, anchor.Length == 0 ? null : anchor);
        }
        input.Finish();
        var plan = new CanvasBundlePlan(digest, revision, title, nodes, edges, references);
        ValidateCanvasBundlePlan(plan);
        return plan;
    }

    public static byte[] EncodeCanvasBundleExecute(CanvasBundleExecute execute)
    {
        ValidateCanvasBundleExecute(execute);
        var output = new Writer();
        output.Uuid(execute.CanvasId);
        output.Uuid(execute.CommandId);
        output.Text(execute.Digest, CanvasBundleDigestBytes);
        output.I32(execute.Mappings.Count);
        foreach (var mapping in execute.Mappings)
        {
            output.I32(mapping.Slot);
            output.I32(mapping.ArticleId);
            output.I64(mapping.PinnedRevision ?? 0);
        }
        output.Bytes(execute.Bundle);
        return Aeds.Encode(FrameType.CanvasBundleExecute, output.Written);
    }

    public static CanvasBundleExecute DecodeCanvasBundleExecute(ReadOnlySpan<byte> frame)
    {
        var input = Reader.Open(frame, FrameType.CanvasBundleExecute, WireLimits.CanvasBundleExecuteFrameBytes,
            InvalidCanvasBundle);
        var canvas = input.Uuid();
        var key = input.Uuid();
        var digest = input.Text(CanvasBundleDigestBytes);
        var mappings = new CanvasBundleMapping[input.Count(0, WireLimits.CanvasBundleMaxReferences, CanvasProtocolError)];
        for (var i = 0; i < mappings.Length; i++)
        {
            var slot = input.I32();
            var article = input.I32();
            var revision = input.I64();
            mappings[i] = new(slot, article, revision == 0 ? null : revision);
        }
        var bundle = input.Bytes(WireLimits.CanvasBundleBytes);
        input.Finish();
        var execute = new CanvasBundleExecute(canvas, key, digest, mappings, bundle.ToArray());
        ValidateCanvasBundleExecute(execute);
        return execute;
    }

    private static void ValidateCanvasBundlePlan(CanvasBundlePlan plan)
    {
        ValidateCanvasBundleDigest(plan.Digest);
        int openAngle = plan.Title.IndexOf('<');
        if (plan.SourceRevision <= 0 || plan.NodeCount is < 0 or > 10_000 || plan.EdgeCount is < 0 or > 10_000 ||
            plan.References.Count > plan.NodeCount || plan.References.Count > WireLimits.CanvasBundleMaxReferences ||
            plan.Title.Length is < 1 or > 128 || plan.Title != plan.Title.Trim() || plan.Title.Any(char.IsControl) ||
            (openAngle >= 0 && plan.Title.IndexOf('>', openAngle + 1) >= 0))
            throw InvalidCanvasBundle();
        for (var i = 0; i < plan.References.Count; i++)
        {
            var reference = plan.References[i];
            if (reference.Slot != i + 1 || reference.Kind is < 0 or > 2 ||
                (reference.Kind == 0 ? reference.Anchor is not null : !ValidCanvasBundleAnchor(reference.Anchor)))
                throw InvalidCanvasBundle();
        }
    }

    private static bool ValidCanvasBundleAnchor(string? anchor) =>
        anchor is { Length: > 0 and <= WireLimits.CanvasGraphAnchorBytes } && anchor[0] is >= 'a' and <= 'z' &&
        anchor.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');

    private static void ValidateCanvasBundleExecute(CanvasBundleExecute execute)
    {
        ValidateCanvasBundleDigest(execute.Digest);
        ValidateCanvasBundleSize(execute.Bundle.Length);
        if (execute.CanvasId == Guid.Empty || execute.CommandId == Guid.Empty ||
            execute.Mappings.Count > WireLimits.CanvasBundleMaxReferences)
            throw InvalidCanvasBundle();
        for (var i = 0; i < execute.Mappings.Count; i++)
        {
            var mapping = execute.Mappings[i];
            if (mapping.Slot != i + 1 || mapping.ArticleId <= 0 || mapping.PinnedRevision is <= 0)
                throw InvalidCanvasBundle();
        }
    }

    private static void ValidateCanvasBundleDigest(string digest)
    {
        if (digest.Length != CanvasBundleDigestBytes || digest.Any(c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw InvalidCanvasBundle();
    }

    private static void ValidateCanvasBundleSize(int length)
    {
        if (length is <= 0 or > WireLimits.CanvasBundleBytes) throw InvalidCanvasBundle();
    }

    private static ProtocolException InvalidCanvasBundle() => new("Invalid Canvas bundle frame");
}
