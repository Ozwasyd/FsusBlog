namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Explicit intent only. Zero and null never select an action.</summary>
public enum ArticlePackageImportResolutionAction : byte
{
    Map = 1,
    Create = 2,
    Skip = 3
}

/// <summary>Shape assertion, not a second property value-type registry.</summary>
public enum ArticlePackageImportResolutionCardinality : byte
{
    Single = 1,
    Multiple = 2
}

/// <summary>Exact owner schema/type fingerprints; compatibility requires equality, not coercion.</summary>
public sealed record ArticlePackageImportResolutionShape(
    ArticlePackageIdentityKind Kind,
    string TypeDigest,
    ArticlePackageImportResolutionCardinality Cardinality,
    string ConstraintsDigest);

/// <summary>Content-free loss coordinates. Digests describe the supplied value and consequence.</summary>
public sealed record ArticlePackageImportResolutionLoss(
    ArticlePackageIdentity PortableArticle,
    string FieldIdentity,
    string ValueDigest,
    string ConsequenceDigest);

/// <summary>
/// One caller-declared unresolved identity. This is not an observed complete unresolved catalog.
/// The planner owns bounded copies before using these lists. Labels never participate in matching.
/// </summary>
public sealed record ArticlePackageImportResolutionItem(
    ArticlePackageIdentity Source,
    int SourceVersion,
    string SourceDigest,
    string DisplayLabel,
    ArticlePackageImportResolutionShape ExpectedShape,
    IReadOnlyList<ArticlePackageImportResolutionAction> AllowedActions,
    IReadOnlyList<ArticlePackageImportResolutionLoss> Loss);

/// <summary>
/// Explicit stable target assertion. No constructor or digest proves a current target, permission,
/// ownership, rights, anchor or creation observation; canonical owners remain required.
/// </summary>
public sealed record ArticlePackageImportResolutionTarget(
    string SiteIdentity,
    string StableIdentity,
    string? AnchorIdentity,
    long Revision,
    ArticlePackageImportResolutionShape Shape,
    string SourceDigest,
    string FactsDigest,
    string PermissionContextDigest,
    string PolicyDigest);

/// <summary>
/// One exact-source choice, with no wildcard, remembered label rule or default skip.
/// Create carries schema intent only and cannot carry a self-issued creation receipt or target.
/// Skip must confirm the planner's exact loss digest. Map requires an explicit target assertion.
/// </summary>
public sealed record ArticlePackageImportResolutionChoice(
    ArticlePackageIdentity Source,
    int SourceVersion,
    string SourceDigest,
    ArticlePackageImportResolutionShape ExpectedShape,
    ArticlePackageImportResolutionAction? Action,
    ArticlePackageImportResolutionTarget? Target,
    string? ConfirmedLossDigest,
    string? CreationSchemaDigest,
    string ActorIdentity,
    DateTime ChosenAtUtc);

/// <summary>Caller assertions bound to one old plan and one exact declared catalog.</summary>
public sealed record ArticlePackageImportResolutionBinding(
    string OldPlanDigest,
    string PackageBytesDigest,
    string SiteIdentity,
    string SchemaDigest,
    string CatalogDigest,
    string PermissionContextDigest,
    string PolicyDigest);

/// <summary>
/// Immutable, non-admitting old/new candidate proposal. A new candidate is not an executable
/// replan. Missing observations and all original required authorities remain unresolved.
/// </summary>
public sealed class ArticlePackageImportResolutionProposal
{
    internal ArticlePackageImportResolutionProposal(
        ArticlePackageImportCandidatePlan oldPlan,
        ArticlePackageImportCandidatePlan newCandidate,
        ArticlePackageImportResolutionBinding binding,
        ArticlePackageImportResolutionItem[] items,
        ArticlePackageImportResolutionChoice[] choices,
        string[] lossDigests,
        string proposalDigest)
    {
        OldPlan = oldPlan;
        NewCandidate = newCandidate;
        Binding = binding;
        Items = Array.AsReadOnly((ArticlePackageImportResolutionItem[])items.Clone());
        Choices = Array.AsReadOnly((ArticlePackageImportResolutionChoice[])choices.Clone());
        LossDigests = Array.AsReadOnly((string[])lossDigests.Clone());
        ProposalDigest = proposalDigest;
    }

    public int SchemaVersion => 1;
    public ArticlePackageImportCandidatePlan OldPlan
    {
        get;
    }
    public ArticlePackageImportCandidatePlan NewCandidate
    {
        get;
    }
    public ArticlePackageImportResolutionBinding Binding
    {
        get;
    }
    public IReadOnlyList<ArticlePackageImportResolutionItem> Items
    {
        get;
    }
    public IReadOnlyList<ArticlePackageImportResolutionChoice> Choices
    {
        get;
    }
    public IReadOnlyList<string> LossDigests
    {
        get;
    }
    public string ProposalDigest
    {
        get;
    }
    public IReadOnlyList<string> RequiredAuthorities => OldPlan.RequiredAuthorities;
    public bool ExecuteDisabled => true;
    public bool HasObservedResolution => false;
    public int PendingCreationCount => Choices.Count(choice => choice.Action == ArticlePackageImportResolutionAction.Create);

    /// <summary>Even a complete supplied choice set cannot establish execution authority.</summary>
    public ArticlePackageManifestCandidateResult RequireExecutionAuthority()
        => OldPlan.RequireExecutionAuthority();
}
