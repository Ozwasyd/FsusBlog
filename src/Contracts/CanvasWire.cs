namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(CanvasCreate input)
    {
        if (input.CanvasId == Guid.Empty || input.EdgeId == Guid.Empty ||
            input.HostArticleId <= 0 || input.TargetArticleId <= 0 || input.HostArticleId == input.TargetArticleId)
            throw new ProtocolException("Invalid Canvas identities.");
    }

    internal static void Validate(CanvasCreated input)
    {
        if (input.CanvasId == Guid.Empty || input.EdgeId == Guid.Empty || input.CanvasRevision <= 0)
            throw new ProtocolException("Invalid Canvas coordinates.");
    }

    internal static void Validate(CanvasPreview input)
    {
        if (input.CanvasId == Guid.Empty || input.EdgeId == Guid.Empty || input.CanvasRevision <= 0 ||
            input.HostRevision <= 0 || input.TargetRevision <= 0 || input.SourceOffset < 0)
            throw new ProtocolException("Invalid Canvas preview coordinates.");
    }

    internal static void Validate(CanvasLinkPlan input)
    {
        if (input.PlanId == Guid.Empty || input.CanvasRevision <= 0 || input.HostArticleId <= 0 ||
            input.TargetArticleId <= 0 || input.HostArticleId == input.TargetArticleId || input.HostRevision <= 0 ||
            input.TargetRevision <= 0 || input.SourceOffset < 0 || input.InsertedMarkdown.Length == 0 ||
            input.ExpiresAtUnixSeconds <= 0)
            throw new ProtocolException("Invalid Canvas link plan.");
    }

    internal static void Validate(CanvasConfirm input)
    {
        if (input.PlanId == Guid.Empty) throw new ProtocolException("Invalid Canvas link plan identity.");
    }

    internal static void Validate(CanvasLinked input)
    {
        if (input.PlanId == Guid.Empty || input.ArticleId <= 0 || input.ArticleRevision <= 0 || input.CanvasRevision <= 0)
            throw new ProtocolException("Invalid Canvas link receipt.");
    }
}
