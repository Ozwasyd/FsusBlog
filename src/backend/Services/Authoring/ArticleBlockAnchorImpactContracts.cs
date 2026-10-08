using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

public enum ArticleBlockAnchorImpactOperation : byte
{
    Rename = 1,
    Remove = 2
}

public enum ArticleBlockAnchorRemovalChoice : byte
{
    RequireNoCurrentReferences = 1,
    LeaveBrokenExplicitly = 2,
    Cancel = 3
}

public enum ArticleBlockAnchorImpactDisposition : byte
{
    RenameCurrentLink = 1,
    ImmutableHistory = 2,
    KeepBrokenExplicitly = 3,
    BlockedCurrentEdit = 4,
    BlockedCurrentLifecycle = 5,
    BlockedRemovalReferences = 6
}

public enum ArticleBlockAnchorImpactStatus : byte
{
    Frozen = 1,
    Unavailable = 2,
    Cancelled = 3
}

/// <summary>Explicit intent and existing independently observed source/query coordinates.</summary>
public sealed record ArticleBlockAnchorImpactRequest(
    string RequestId,
    ArticleBlockAnchorImpactOperation Operation,
    BlockTargetArticleCoordinate TargetArticle,
    BlockAnchorId OldAnchor,
    BlockAnchorId? NewAnchor,
    ArticleBlockAnchorRemovalChoice RemovalChoice,
    ArticleBlockTargetQueryObservation ExpectedObservation);

/// <summary>
/// One exact indexed occurrence. Published sources always retain their original Markdown.
/// Current metadata/editability are separately observed; they do not grant writer admission.
/// </summary>
public sealed record ArticleBlockAnchorImpactItem(
    ArticleRelationRecord Record,
    ArticleRelationSourceRange Range,
    string BeforeMarkdown,
    string AfterMarkdown,
    BlockTargetArticleCoordinate? CurrentArticle,
    ArticleBlockAnchorImpactDisposition Disposition);

/// <summary>
/// Immutable incoming-impact preparation, never an executable source mutation or receipt.
/// Original target marker/inventory admission and the canonical multi-article transaction
/// remain required. No anchor collision is inferred from the presence or absence of links.
/// </summary>
public sealed class ArticleBlockAnchorImpactPlan
{
    internal ArticleBlockAnchorImpactPlan(
        ArticleBlockAnchorImpactRequest request,
        ArticleRelationIndexInspection inspection,
        ImmutableArray<ArticleBlockAnchorImpactItem> items,
        ImmutableSortedDictionary<string, BlockTargetArticleCoordinate> currentArticles,
        string operationDigest)
    {
        Request = request;
        Inspection = inspection;
        Items = items;
        CurrentArticles = currentArticles;
        OperationDigest = operationDigest;
    }

    public ArticleBlockAnchorImpactRequest Request
    {
        get;
    }

    public ArticleRelationIndexInspection Inspection
    {
        get;
    }

    public ImmutableArray<ArticleBlockAnchorImpactItem> Items
    {
        get;
    }

    public ImmutableSortedDictionary<string, BlockTargetArticleCoordinate> CurrentArticles
    {
        get;
    }

    public string OperationDigest
    {
        get;
    }

    public bool HasCurrentBlocks => Items.Any(static item => item.Disposition is
        ArticleBlockAnchorImpactDisposition.BlockedCurrentEdit
        or ArticleBlockAnchorImpactDisposition.BlockedCurrentLifecycle
        or ArticleBlockAnchorImpactDisposition.BlockedRemovalReferences);

    public bool RequiresTargetInventoryAndMarkerAdmission => true;

    public bool RequiresCanonicalTransactionAdmission => true;

    public bool RequiresHistoricalPermissionAdmission => Items.Any(static item =>
        item.Record.Source.RevisionKind == ArticleRelationRevisionKind.Published);
}

/// <summary>Absence, denied reads and drift carry no plan, items, counts or source diagnostics.</summary>
public sealed record ArticleBlockAnchorImpactResult(
    ArticleBlockAnchorImpactStatus Status,
    ArticleBlockAnchorImpactPlan? Plan);
