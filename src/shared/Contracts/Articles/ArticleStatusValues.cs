namespace FsusBlog.Contracts.Articles;

/// <summary>The existing current article status values, validated by the shared transition policy.</summary>
public static class ArticleStatusValues
{
    /// <summary>Unpublished editing state.</summary>
    public const int Draft = 0;
    /// <summary>Pending scheduled publication.</summary>
    public const int Scheduled = 1;
    /// <summary>Published state; visibility still requires valid publication coordinates.</summary>
    public const int Published = 2;
    /// <summary>Archived, non-public state.</summary>
    public const int Archived = 3;
    /// <summary>Deleted state, entered through the existing deletion flow.</summary>
    public const int Deleted = 4;
}
