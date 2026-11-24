public sealed class PublishingTests
{
    private static readonly Identity Owner = new(Guid.NewGuid(), "author", 1, true, DateTimeOffset.MaxValue);
    private static readonly ArticleState Published = new(9, Owner.Id, 4, "Published title", "Published body", 4, false);

    [Fact]
    public void DraftSavePreservesPublicRevisionUntilExplicitRepublish()
    {
        var edit = new Edit(9, 4, Guid.NewGuid(), "  New draft  ", "New draft body");
        var draft = Publishing.Change(ArticleAction.Save, Publishing.Validate(ArticleAction.Save, edit), Published, Owner);
        Assert.Equal("New draft", draft.Title);
        Assert.Equal(4, draft.PublishedRevision);
        var conflict = Assert.Throws<BusinessException>(() => Publishing.Change(ArticleAction.Publish, edit, draft, Owner));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        var publish = edit with { ExpectedRevision = 5, Title = "", Body = "" };
        Assert.Equal(6, Publishing.Change(ArticleAction.Publish, publish, draft, Owner).PublishedRevision);
    }

    [Fact]
    public void PrivateOwnershipAndBusinessPermissionAreDistinct()
    {
        var edit = new Edit(9, 4, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.NotFound, Assert.Throws<BusinessException>(() =>
            Publishing.Change(ArticleAction.Delete, edit, Published, Owner with { Id = Guid.NewGuid() })).Rejection);
        Assert.Equal(Rejection.Forbidden, Assert.Throws<BusinessException>(() =>
            Publishing.Change(ArticleAction.Retract, edit, Published, Owner with { CanAuthor = false })).Rejection);
        var retracted = Publishing.Change(ArticleAction.Retract, edit, Published, Owner);
        Assert.Null(retracted.PublishedRevision);
        Assert.False(retracted.Deleted);
    }

    [Fact]
    public void TextMustFitEveryPublicRepresentation()
    {
        var edit = new Edit(0, 0, Guid.NewGuid(), new string('界', 86), "text");
        Assert.Throws<BusinessException>(() => Publishing.Validate(ArticleAction.Save, edit));
        Assert.Throws<BusinessException>(() => Publishing.Validate(ArticleAction.Save, edit with { Title = "bad\0title" }));
        Assert.Throws<BusinessException>(() => Publishing.Validate(ArticleAction.Save, edit with { Title = "valid", Body = "\uD800" }));
        Assert.Equal(new string('界', 85), Publishing.Validate(ArticleAction.Save, edit with { Title = new string('界', 85) }).Title);
    }
}
