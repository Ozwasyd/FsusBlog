public sealed class PublishingTests
{
    private static readonly Identity Owner = new(Guid.NewGuid(), "author", 1, true, DateTimeOffset.MaxValue);
    private static readonly ArticleState Published = new(9, Owner.Id, 4, "Published title", "Published body", 4, false);

    [Fact]
    public void DraftSavePreservesPublicRevisionUntilExplicitRepublish()
    {
        var edit = new Edit(9, 4, Guid.NewGuid(), "  New draft  ", "New draft body");
        var draft = Publishing.Change(ArticleAction.Save, Publishing.Validate(ArticleAction.Save, edit), Published, Owner);
        Assert.Equal(("New draft", (long?)4), (draft.Title, draft.PublishedRevision));
        Reject(Rejection.Conflict, () => Publishing.Change(ArticleAction.Publish, edit, draft, Owner));
        Assert.Equal(6, Publishing.Change(ArticleAction.Publish, edit with { ExpectedRevision = 5, Title = "", Body = "" }, draft, Owner).PublishedRevision);
    }

    [Fact]
    public void PrivateOwnershipAndBusinessPermissionAreDistinct()
    {
        var edit = new Edit(9, 4, Guid.NewGuid(), "", "");
        Reject(Rejection.NotFound, () => Publishing.Change(ArticleAction.Delete, edit, Published, Owner with { Id = Guid.NewGuid() }));
        Reject(Rejection.Forbidden, () => Publishing.Change(ArticleAction.Retract, edit, Published, Owner with { CanAuthor = false }));
        var retracted = Publishing.Change(ArticleAction.Retract, edit, Published, Owner);
        Assert.Equal(((long?)null, false), (retracted.PublishedRevision, retracted.Deleted));
    }

    [Fact]
    public void TextMustFitEveryPublicRepresentation()
    {
        var edit = new Edit(0, 0, Guid.NewGuid(), new string('界', 86), "text");
        foreach (var bad in new[] { edit, edit with { Title = "bad\0title" }, edit with { Title = "valid", Body = "\uD800" } })
            Assert.Throws<BusinessException>(() => Publishing.Validate(ArticleAction.Save, bad));
        Assert.Equal(new string('界', 85), Publishing.Validate(ArticleAction.Save, edit with { Title = new string('界', 85) }).Title);
    }

    private static void Reject(Rejection expected, Action act) => Assert.Equal(expected, Assert.Throws<BusinessException>(act).Rejection);
}
