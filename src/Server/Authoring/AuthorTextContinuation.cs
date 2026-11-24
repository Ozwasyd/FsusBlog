namespace FsusBlog.V2.Server.Authoring;

internal readonly record struct AuthorTextRankKey(int PhraseRank, int FieldRank, long UpdatedAtUnixMs, int Id);

// Search queries and cursor transport share this continuation contract without
// depending on one another's implementation.
internal static class AuthorTextContinuation
{
    internal static void Validate(AuthorTextRankKey? after, byte[]? expectedGeneration)
    {
        if ((after is null) != (expectedGeneration is null) || expectedGeneration is { Length: not SHA256.HashSizeInBytes } ||
            after is { } key && (key.Id <= 0 || key.PhraseRank < 0 || key.FieldRank <= 0 || key.PhraseRank > key.FieldRank))
            throw Invalid();
    }

    internal static BusinessException Invalid() => new(Rejection.Conflict, "The article search page changed. Search again from the first page.");
}
