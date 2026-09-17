using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    private sealed record TextToken(string Value, int Offset, int Length, TextTokenClass Class);

    private enum TextTokenClass
    {
        Word = 0,
        Whitespace = 1,
        Symbol = 2
    }

    private enum TokenizationStatus
    {
        Available = 0,
        InvalidUtf8 = 1,
        BudgetExceeded = 2
    }

    private sealed record WordDiffResult(
        ImmutableArray<RevisionDiffWordEdit> Edits,
        int TokenCount,
        bool BudgetExceeded);
}
