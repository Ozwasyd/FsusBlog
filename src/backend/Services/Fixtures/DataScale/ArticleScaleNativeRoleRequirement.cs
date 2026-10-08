namespace FsusBlog.Server.Services.Fixtures.DataScale;

public sealed record ArticleScaleNativeRoleRequirement(
    ArticleScaleRowKind Kind,
    string AllocationRole,
    IReadOnlyList<string> SemanticRoles);

