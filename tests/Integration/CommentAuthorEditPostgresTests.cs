using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Comments;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task ApprovedOwnerEditCommitsOneRevisionAndReturnsToReviewWithoutDuplicatingReplyNotice()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (owner, outsider) = await SeedBatchReplies(db, 1, ct);
        await Execute(db, "update public.comment_submit_command set user_id=$1 where article_id=1 and comment_id=1", ct, owner);
        var replyOwner = await ReadDatabase<Guid>(db, "select user_id from public.comment_account_owner where comment_id=3", ct);
        var actor = new Identity(owner, "Parent author", 1, false, DateTimeOffset.UtcNow.AddMinutes(10));
        var replier = actor with { Id = replyOwner, Name = "Reply author" };
        var session = RandomNumberGenerator.GetBytes(32);
        var otherSession = RandomNumberGenerator.GetBytes(32);
        var moderator = await AddModerator(db, "comment-edit-reviewer", ct);
        var review = CreateStore(fixture);
        var publicRead = new CommentReadStore(fixture.DataSource);
        await Approve(3);
        var delivered = await ReadDatabase<long>(db, "select message_id from public.comment_reply_notice where reply_id=3", ct);

        var original = await Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct));
        Assert.Equal(1, original.ArticleId);
        Assert.Equal(2, original.CurrentVersion);
        Assert.Equal("Awaiting review", original.Body);
        await Denied(Rejection.NotFound, () => Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, outsider, 1, ct)));
        await Execute(db, "insert into public.comment_blocked_region values(1,1,'ZZ')", ct);
        await Denied(Rejection.NotFound, () => Issue(actor, session, 1));
        await Execute(db, "delete from public.comment_blocked_region where article_id=1 and comment_id=1", ct);
        await Execute(db, "update public.comment set created_at=clock_timestamp()-interval '31 minutes' where article_id=1 and id=1", ct);
        await Denied(Rejection.NotFound, () => Own((conn, tx) => CommentAuthorEdits.Detail(conn, tx, owner, 1, ct)));
        await Execute(db, "update public.comment set created_at=clock_timestamp() where article_id=1 and id=1", ct);

        const string edited = "Revised root text for a second review.";
        var expired = await Issue(actor, session, 1);
        await Execute(db, "update public.comment_author_edit_challenge set expires_at=clock_timestamp()-interval '1 second'", ct);
        await Denied(Rejection.NotFound, () => Edit(actor, session, 1, new(expired.CurrentVersion, edited, expired.Challenge)));
        var mismatch = await Issue(actor, session, 1);
        await Execute(db, "update public.comment_author_edit_challenge set publication_id=publication_id+1", ct);
        await Denied(Rejection.Conflict, () => Edit(actor, session, 1, new(mismatch.CurrentVersion, edited, mismatch.Challenge)));

        var proof = await Issue(actor, session, 1);
        var command = new CommentAuthorEditRequest(proof.CurrentVersion, $"  {edited}  ", proof.Challenge);
        Assert.Equal(original.CurrentVersion, proof.CurrentVersion);
        await Denied(Rejection.NotFound, () => Edit(actor, otherSession, 1, command));
        await Denied(Rejection.NotFound, () => Edit(actor with { Generation = 2 }, session, 1, command));
        await Denied(Rejection.Conflict, () => Edit(actor, session, 1, command with { ExpectedVersion = command.ExpectedVersion + 1 }));
        await Denied(Rejection.Invalid, () => Edit(actor, session, 1, command with { Content = original.Body }));

        await Execute(db, "alter table public.comment_author_edit_outbox add constraint fixture_refuse_edit check (false)", ct);
        var failed = await Assert.ThrowsAsync<PostgresException>(() => Edit(actor, session, 1, command));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failed.SqlState);
        Assert.Equal("fixture_refuse_edit", failed.ConstraintName);
        Assert.True(await ReadDatabase<bool>(db, """
            select c.body=$1 and c.moderation_version=2 and c.moderation_status=1 and c.edited_at is null
                and (select count(*) from public.comment_author_edit_challenge)=1
                and not exists(select from public.comment_author_edited)
                and not exists(select from public.comment_author_edit_outbox)
            from public.comment c where c.article_id=1 and c.id=1
            """, ct, original.Body));
        await Execute(db, "alter table public.comment_author_edit_outbox drop constraint fixture_refuse_edit", ct);

        var outcomes = await Task.WhenAll(Attempt(), Attempt());
        var receipt = Assert.Single(outcomes.OfType<CommentAuthorMutation>());
        Assert.Single(outcomes, result => result is null);
        Assert.Equal((true, "ok", original.CurrentVersion + 1, 0),
            (receipt.Success, receipt.Code, receipt.CurrentVersion, receipt.ModerationStatus));
        Assert.True(receipt.EditedAtUtc.HasValue);
        Assert.True(await ReadDatabase<bool>(db, """
            select e.user_id=$1 and e.previous_version=2 and e.comment_version=3 and e.previous_status=1
                and e.moderation_status=0 and e.previous_body=$2 and e.body=$3
                and e.previous_body_digest=pg_catalog.sha256(convert_to($2,'UTF8'))
                and e.body_digest=pg_catalog.sha256(convert_to($3,'UTF8')) and e.happened_at=c.edited_at
                and c.body=$3 and c.parent_id is null and c.root_id=1 and c.depth=0 and not c.deleted
                and o.event_type='CommentEdited' and not exists(select from public.comment_author_edit_challenge)
            from public.comment_author_edited e
            join public.comment_author_edit_outbox o using(article_id,comment_id,comment_version)
            join public.comment c on (c.article_id,c.id)=(e.article_id,e.comment_id)
            where e.article_id=1 and e.comment_id=1
            """, ct, owner, original.Body, edited));

        var pending = Encoding.UTF8.GetString(await publicRead.Roots(1, null, 10, ct));
        Assert.Contains("Reply fixture 3", pending, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixture writer", pending, StringComparison.Ordinal);
        Assert.DoesNotContain(original.Body, pending, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, pending, StringComparison.Ordinal);
        Assert.DoesNotContain(edited, Encoding.UTF8.GetString(await publicRead.Context(1, 1, 6, ct)), StringComparison.Ordinal);
        await Denied(Rejection.NotFound, () => Issue(actor, session, 1));
        await Approve(1);
        var republished = Encoding.UTF8.GetString(await publicRead.Roots(1, null, 10, ct));
        Assert.Contains(edited, republished, StringComparison.Ordinal);
        Assert.DoesNotContain(original.Body, republished, StringComparison.Ordinal);

        var replyProof = await Issue(replier, otherSession, 3);
        const string editedReply = "Revised reply whose earlier notice is retained.";
        await Edit(replier, otherSession, 3, new(replyProof.CurrentVersion, editedReply, replyProof.Challenge));
        await Approve(3);
        Assert.Contains(editedReply, Encoding.UTF8.GetString(await publicRead.Context(1, 3, 6, ct)), StringComparison.Ordinal);
        Assert.True(await ReadDatabase<bool>(db, """
            select (select count(*) from public.comment_reply_notice where reply_id=3 and message_id=$1)=1
                and (select count(*) from public.inbox_message)=1
                and exists(select from public.comment where article_id=1 and id=3 and root_id=1 and parent_id=1
                    and reply_to_id=1 and parent_depth=0 and depth=1 and not deleted and edited_at is not null)
            """, ct, delivered));

        async Task<T> Own<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> action)
        {
            await using var conn = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            var result = await action(conn, tx);
            await tx.CommitAsync(ct);
            return result;
        }

        Task<CommentAuthorChallenge> Issue(Identity account, byte[] digest, long id) =>
            Own((conn, tx) => CommentAuthorEdits.Issue(conn, tx, account, digest, id, ct));

        Task<CommentAuthorMutation> Edit(Identity account, byte[] digest, long id, CommentAuthorEditRequest input) =>
            Own((conn, tx) => CommentAuthorEdits.Apply(conn, tx, account, digest, id, input, ct));

        async Task<CommentAuthorMutation?> Attempt()
        {
            try { return await Edit(actor, session, 1, command); }
            catch (BusinessException error) when (error.Rejection == Rejection.NotFound) { return null; }
        }

        async Task Approve(long id)
        {
            var claim = await review.AcquireCommentClaim(moderator.Token, new(1, id), ct);
            var decision = new AdminModerationDecision(1, id, 0, 1, "Review the exact current comment body", claim.CommentVersion,
                claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
            var grant = await SeedDecisionProof(db, moderator, Wire.EncodeAdminModerationDecision(decision), batch: false, ct);
            await review.DecideComment(moderator.Token, grant.Token, decision, ct);
        }
    }

    [Fact]
    public void CommentEditWireUsesFrame217AndRejectsAmbiguousVersionsAndAnonymousFields()
    {
        Assert.Equal(217, (int)FrameType.CommentAuthorEditRequest);
        Assert.Equal(33003, (int)FrameType.CommentAuthorEditDetail);
        const string proof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        var decoded = Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}"}""")));
        Assert.Equal(new(2, "Edit body", proof), decoded);
        var detail = new CommentAuthorEditDetail(3, 5, 7, "Exact body");
        Assert.Equal(detail, Wire.DecodeCommentAuthorEditDetail(Wire.EncodeCommentAuthorEditDetail(detail)));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":"2","content":"Edit body","challenge":"{{proof}}"}"""))));
        Assert.Throws<ProtocolException>(() => Wire.DecodeCommentAuthorEditRequest(Aeds.Encode(FrameType.CommentAuthorEditRequest,
            Encoding.UTF8.GetBytes($$"""{"expectedVersion":2,"content":"Edit body","challenge":"{{proof}}","capabilitySecret":"x"}"""))));
    }
}
