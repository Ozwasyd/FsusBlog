namespace FsusBlog.Contracts.Articles;

/// <summary>The existing current stored article defaults; none of these values grants authoring admission.</summary>
public static class ArticleCurrentPolicyDefaults
{
    /// <summary>The current new-article live view counter starts at zero; historical counts are not imported into it.</summary>
    public const int InitialLiveViews = 0;
    /// <summary>The current default state for an article with no explicitly supplied lifecycle state.</summary>
    public const int Status = ArticleStatusValues.Published;
    /// <summary>The stored creator marker when no current administrator created the revision.</summary>
    /// <remarks>This is not an administrator ID, permission, or public revision/publication coordinate.</remarks>
    public const long UnattributedCreatorId = 0;
    /// <summary>The first responsibility snapshot version.</summary>
    public const int ResponsibilityVersion = 1;
    /// <summary>The default responsibility snapshot inherits the current configured site author.</summary>
    public const bool InheritSiteAuthor = true;
    /// <summary>The current empty author/source JSON collection representation.</summary>
    public const string EmptyPeopleJson = "[]";
    /// <summary>A default snapshot does not assert human confirmation.</summary>
    public const bool ResponsiblePersonConfirmed = false;

    /// <summary>Builds the existing current snapshot's default responsibility values.</summary>
    /// <remarks>The ordinary authoring validator still rejects an unconfirmed draft. This is a stored default, not approval.</remarks>
    public static ArticleResponsibilityDraft ResponsibilityDraft()
        => new(InheritSiteAuthor, [], null, [], null, null, null, null, null, null, null,
            ResponsiblePersonConfirmed, false, false, false, ResponsibilityVersion);
}
