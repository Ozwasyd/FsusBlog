using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentRevisionContractTests
{
    [Theory]
    [InlineData("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")]
    [InlineData("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]
    [InlineData("你好\nworld", "249d8bbd97cca68c26fce4db78ef66da58078a14dc36e16b02061506ec20e637")]
    [InlineData("  pre-normalized\r\ncontent  ", "4e58dba1fd047525fab3fba6a1326bc58790e7ade489a14c8d09c1033ccd2f6c")]
    public void Content_UsesExactSuppliedUtf8AndLowercaseSha256(string content, string expectedHash)
    {
        CommentRevision revision = CommentCommandService.BuildRevision(
            302, 1, CommentRevisionOperations.Created, content, DateTime.UnixEpoch,
            CommentAuthorModes.Public, 7, null);

        Assert.Equal(content, revision.Content);
        Assert.Equal(expectedHash, revision.ContentSha256);
    }

    [Theory]
    [InlineData(CommentRevisionOperations.Created, 1)]
    [InlineData(CommentRevisionOperations.Edited, 2)]
    [InlineData(CommentRevisionOperations.Deleted, 3)]
    public void Revision_LeavesRowIdentityToWriterAndPreservesExplicitFacts(string operation, int version)
    {
        DateTime createdAtUtc = DateTime.UnixEpoch.AddTicks(17);
        CommentRevision revision = CommentCommandService.BuildRevision(
            302, version, operation, "abc", createdAtUtc, CommentAuthorModes.Public, 7, 11);

        Assert.Equal(0, revision.Id);
        Assert.Equal(302, revision.CommentId);
        Assert.Equal(version, revision.Version);
        Assert.Equal(operation, revision.Operation);
        Assert.Equal(createdAtUtc, revision.CreatedAtUtc);
        Assert.Equal(createdAtUtc.Kind, revision.CreatedAtUtc.Kind);
        Assert.Equal(CommentAuthorModes.Public, revision.ActorMode);
        Assert.Equal(7, revision.ActorAccountId);
        Assert.Equal(11, revision.ActorAdminPrincipalId);
    }

    [Fact]
    public void AnonymousRevision_PreservesAbsentAccountAndAdminAssociation()
    {
        CommentRevision revision = CommentCommandService.BuildRevision(
            302, 2, CommentRevisionOperations.Edited, "abc", DateTime.UnixEpoch,
            CommentAuthorModes.ZkAnonymous, null, null);

        Assert.Null(revision.ActorAccountId);
        Assert.Null(revision.ActorAdminPrincipalId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, revision.ActorMode);
        Assert.Equal(0, revision.Id);
    }
}
