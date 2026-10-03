using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorRecentArticleHistoryContractTests
{
    private static readonly AuthorRecentArticleHistoryOwner s_owner = new(42, "primary-site");

    [Fact]
    public void ClosedSchema_UsesOnlyStableServerArticleIdentity()
    {
        Assert.Equal(1, AuthorRecentArticleHistoryContract.SchemaVersion);
        Assert.Equal(1_000, AuthorRecentArticleHistoryContract.MaxEntriesPerOwner);
        Type[] authorityTypes =
        [
            typeof(AuthorRecentArticleHistoryOwner),
            typeof(AuthorRecentArticleHistoryCommand),
            typeof(AuthorRecentArticleHistoryEntry),
            typeof(AuthorRecentArticleHistoryCollectionSnapshot),
            typeof(AuthorRecentArticleHistoryReceipt),
            typeof(AuthorRecentArticleHistoryProjectionRequest),
            typeof(AuthorRecentArticleHistoryProjectionPage)
        ];
        foreach (Type type in authorityTypes)
        {
            Assert.Null(type.GetProperty("Title"));
            Assert.Null(type.GetProperty("Slug"));
            Assert.Null(type.GetProperty("Route"));
            Assert.Null(type.GetProperty("Url"));
            Assert.Null(type.GetProperty("UpdatedAt"));
        }
        Assert.Throws<AuthorRecentArticleHistoryValidationException>(() =>
            AuthorRecentArticleHistoryContract.ValidateArticleId(0));
        Assert.Throws<AuthorRecentArticleHistoryValidationException>(() =>
            AuthorRecentArticleHistoryContract.ValidateServerRevision(0));
        Assert.Throws<AuthorRecentArticleHistoryValidationException>(() =>
            AuthorRecentArticleHistoryContract.ValidateRequestId(Guid.Empty));
        Assert.Null(typeof(AuthorRecentArticleHistoryCommand).GetProperty("ClientTimestamp"));
        Assert.Null(typeof(AuthorRecentArticleHistoryCommand).GetProperty("OccurredAtUtc"));
        Assert.Null(typeof(AuthorRecentArticleHistoryCommand).GetProperty("SortOrder"));
    }

    [Fact]
    public void CanonicalDigests_BindOwnerRevisionCommandAndServerFacts()
    {
        AuthorRecentArticleHistoryEntry entry = CreateEntry(17, 91, "open", 1);
        string first = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(s_owner, 1, [entry]);
        string repeated = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(s_owner, 1, [entry]);
        string changedRevision = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(s_owner, 2, [entry]);
        string changedOwner = AuthorRecentArticleHistoryContract.ComputeCollectionDigest(
            new AuthorRecentArticleHistoryOwner(43, s_owner.SiteScope),
            1,
            [entry]);
        string open = AuthorRecentArticleHistoryContract.ComputeCommandDigest(
            new(s_owner, 17, 91, 0, Guid.Parse("01991f50-8850-7f63-82ab-8dbf846ef421"), AuthorRecentArticleHistoryCommandKind.Open));
        string activate = AuthorRecentArticleHistoryContract.ComputeCommandDigest(
            new(s_owner, 17, 91, 0, Guid.Parse("01991f50-8850-7f63-82ab-8dbf846ef421"), AuthorRecentArticleHistoryCommandKind.Activate));

        Assert.Equal(first, repeated);
        Assert.NotEqual(first, changedRevision);
        Assert.NotEqual(first, changedOwner);
        Assert.NotEqual(open, activate);
        Assert.Equal(64, first.Length);
    }

    [Fact]
    public void Cursor_BindsCollectionPermissionSessionAndStableOrderKey()
    {
        AuthorRecentArticleHistoryCursor expected = new(
            s_owner,
            9,
            Hash("collection"),
            Hash("permission"),
            Hash("site"),
            Hash("session"),
            new DateTime(2026, 9, 15, 12, 0, 0, DateTimeKind.Utc),
            17);

        var codec = new AuthorRecentArticleHistoryCursorCodec(
            new EphemeralDataProtectionProvider());
        string encoded = codec.Encode(expected);

        Assert.True(codec.TryDecode(encoded, out AuthorRecentArticleHistoryCursor? actual, out string reason), reason);
        Assert.Equal(expected, actual);
        Assert.False(codec.TryDecode(
            encoded[..^1] + (encoded[^1] == 'A' ? 'B' : 'A'),
            out _,
            out _));
    }

    [Fact]
    public void SnapshotVerifier_RejectsTamperAndUnknownCommand()
    {
        AuthorRecentArticleHistoryEntry entry = CreateEntry(17, 91, "open", 1);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = new(
            s_owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            1,
            1,
            [entry],
            entry.LastOpenedAtUtc!.Value,
            AuthorRecentArticleHistoryContract.ComputeCollectionDigest(s_owner, 1, [entry]));

        Assert.True(AuthorRecentArticleHistoryContract.TryValidateSnapshot(snapshot, out IReadOnlyList<string> validReasons), string.Join(',', validReasons));

        AuthorRecentArticleHistoryEntry tampered = entry with
        {
            LastCommand = "edit"
        };
        AuthorRecentArticleHistoryCollectionSnapshot tamperedSnapshot = snapshot with
        {
            Entries = [tampered]
        };
        Assert.False(AuthorRecentArticleHistoryContract.TryValidateSnapshot(tamperedSnapshot, out IReadOnlyList<string> reasons));
        Assert.Contains(reasons, reason => reason.Contains("entry_digest_mismatch", StringComparison.Ordinal));

        AuthorRecentArticleHistoryEntry unknown = entry with
        {
            LastCommand = "unknown",
            ContentDigest = Hash("unknown")
        };
        Assert.False(
            AuthorRecentArticleHistoryContract.TryValidateSnapshot(
                snapshot with
                {
                    Entries = [unknown]
                },
                out _));
    }

    [Fact]
    public void Verifier_RejectsTamperAndMissingSideEffects()
    {
        AuthorRecentArticleHistoryCommand command = new(
            s_owner,
            17,
            91,
            0,
            Guid.Parse("01991f50-8850-7f63-82ab-8dbf846ef421"),
            AuthorRecentArticleHistoryCommandKind.Open);
        string commandDigest = AuthorRecentArticleHistoryContract.ComputeCommandDigest(command);
        var receipt = new AuthorRecentArticleHistoryReceipt(
            Guid.Parse("01991f50-8850-7f63-82ab-8dbf846ef422"),
            s_owner,
            command.RequestId,
            command.ArticleId,
            command.ServerRevision,
            0,
            1,
            "open",
            "applied",
            DateTime.SpecifyKind(new DateTime(2026, 9, 15), DateTimeKind.Utc),
            DateTime.SpecifyKind(new DateTime(2026, 9, 15), DateTimeKind.Utc),
            null,
            null,
            "projection:1",
            "server-read-model:1",
            "audit:1",
            "outbox:1",
            commandDigest,
            Hash("content"),
            false,
            string.Empty);
        receipt = receipt with
        {
            ReceiptDigest = AuthorRecentArticleHistoryContract.ComputeReceiptDigest(receipt)
        };

        Assert.Equal(
            receipt.ReceiptDigest,
            AuthorRecentArticleHistoryContract.ComputeReceiptDigest(
                receipt with
                {
                    IdempotentReplay = true
                }));
        Assert.NotEqual(
            receipt.ReceiptDigest,
            AuthorRecentArticleHistoryContract.ComputeReceiptDigest(
                receipt with
                {
                    ContentDigest = Hash("tampered")
                }));
    }

    private static AuthorRecentArticleHistoryEntry CreateEntry(
        int articleId,
        long serverRevision,
        string command,
        long entryRevision)
    {
        DateTime at = DateTime.SpecifyKind(new DateTime(2026, 9, 15, 12, 0, articleId), DateTimeKind.Utc);
        var entry = new AuthorRecentArticleHistoryEntry(
            articleId,
            serverRevision,
            at,
            command == "edit" ? at : null,
            command == "activate" ? at : null,
            command,
            entryRevision,
            Hash("seed"));
        return entry with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(s_owner, entry)
        };
    }

    private static string Hash(string value)
        => AuthorRecentArticleHistoryContract.HashText(value);
}
