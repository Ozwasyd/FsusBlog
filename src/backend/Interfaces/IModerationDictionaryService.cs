using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IModerationDictionaryService
{
    ModerationDictionarySnapshot CurrentSnapshot
    {
        get;
    }
    string? LastError
    {
        get;
    }
    IReadOnlyList<ModerationDictionaryMatch> Match(string content, string region);
    IReadOnlyList<ModerationDictionaryMatch> MatchAll(string content);
    IReadOnlyList<ModerationDictionaryMatch> FilterMatchesForRegion(IReadOnlyList<ModerationDictionaryMatch> matches, string region);
    ModerationPolicyAction ResolveAction(string region, string category);
    IReadOnlyList<ModerationDictionaryTerm> GetGlobalHardFilterTerms();
    ModerationDictionaryRuntimeSnapshot GetRuntimeSnapshot();
    Result Reload();
    Result Rollback();
}
