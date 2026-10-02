using System.Net;

namespace FsusBlog.Contracts.Articles;

/// <summary>The existing pure current responsibility validation and public URL filtering rules.</summary>
public static class ArticleResponsibilityGovernance
{
    /// <summary>Returns blocking author/confirmation errors and disclosure warnings for explicit input.</summary>
    /// <remarks>Evaluation does not persist snapshots, confirm a person, or resolve an inherited site author.</remarks>
    public static IReadOnlyList<PrepublishIssue> Evaluate(ArticleResponsibilityDraft draft)
    {
        var issues = new List<PrepublishIssue>();
        if (!draft.InheritSiteAuthor && draft.Authors.Count == 0)
            issues.Add(Block("responsible_author_missing", "必须指定责任作者或显式继承站点作者。"));
        if (!draft.ResponsiblePersonConfirmed)
            issues.Add(Block("responsible_person_unconfirmed", "AI 辅助内容必须由真实责任人确认。"));
        if (draft.Authors.Any(static author => string.IsNullOrWhiteSpace(author.Name)))
            issues.Add(Block("author_profile_mismatch", "作者公开资料缺少稳定展示名。"));
        if (draft.ContainsStrongClaims && draft.Sources.Count == 0)
            issues.Add(Warn("strong_claim_without_source", "强结论尚未提供可核验来源。"));
        if (draft.Sources.Any(static source => string.IsNullOrWhiteSpace(source.Title) || PublicSourceUrlInvalid(source.Url)))
            issues.Add(Warn("source_invalid", "来源标题缺失，或链接不可公开访问。"));
        if (draft.IsSubstantiveUpdate && (string.IsNullOrWhiteSpace(draft.UpdateSummary) || string.IsNullOrWhiteSpace(draft.UpdateReason)))
            issues.Add(Warn("update_note_missing", "实质更新需要说明改了什么以及为什么修改。"));
        if (draft.RequiresMethodsDisclosure && (string.IsNullOrWhiteSpace(draft.Methodology) || string.IsNullOrWhiteSpace(draft.Limitations)))
            issues.Add(Warn("methods_or_limitations_missing", "此内容类型应人工复核方法与局限说明。"));
        return issues;
    }

    private static bool PublicSourceUrlInvalid(string value)
        => PublicUrl(value) is null;

    private static PrepublishIssue Block(string code, string message) => new("error", code, message);
    private static PrepublishIssue Warn(string code, string message) => new("warning", code, message);

    /// <summary>Returns the normalized public HTTP(S) URL or null under the existing address rules.</summary>
    /// <remarks>No network request, DNS resolution or reachability guarantee is performed.</remarks>
    public static string? PublicUrl(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (IPAddress.TryParse(uri.Host, out IPAddress? address)
            && (IPAddress.IsLoopback(address) || IsPrivateAddress(address)))
        {
            return null;
        }

        return uri.AbsoluteUri;
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return bytes[0] == 10
                || bytes[0] == 127
                || (bytes[0] == 169 && bytes[1] == 254)
                || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
                || (bytes[0] == 192 && bytes[1] == 168);
        }

        return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.Equals(IPAddress.IPv6Loopback);
    }
}
