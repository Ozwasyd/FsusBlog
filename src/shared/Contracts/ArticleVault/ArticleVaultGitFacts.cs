using System.Collections.Immutable;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Records optional Git availability without making Git an article authority.</summary>
public enum VaultGitAvailability
{
    NotPresent = 1,
    Observed,
    Blocked
}

/// <summary>Names only unfinished operations; HEAD never supplies a Vault winner or base.</summary>
public enum VaultGitOperation
{
    Merge = 1,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
    Sequencer
}

/// <summary>Contains digests and counts only; filenames, remote configuration and source are excluded.</summary>
public sealed record VaultGitIndexFacts(string ContentSha256, int Entries, int UnmergedEntries);

/// <summary>Retains rename hints as projection digests, with no portable-identity assignment.</summary>
public sealed record VaultGitRenameHint(string OldProjectionSha256, string NewProjectionSha256);

/// <summary>Summarizes one bounded NUL-delimited status observation.</summary>
public sealed record VaultGitStatusFacts(
    string ContentSha256,
    int Staged,
    int Unstaged,
    int Untracked,
    int Unmerged,
    ImmutableArray<VaultGitRenameHint> RenameHints);

/// <summary>Binds marker byte ranges to verified portable identity and exact local bytes.</summary>
public sealed record VaultGitSourceFacts(
    string PortableArticleIdentity,
    string SourceSha256,
    ImmutableArray<VaultConflictSourceChange> MarkerRanges);

/// <summary>
/// Seals a complete observation batch. This DTO is diagnostic evidence, not filesystem, identity,
/// merge or writer authority. Current admission requires an independent native reread.
/// </summary>
public sealed record ArticleVaultGitFacts(
    string Schema,
    int SchemaVersion,
    VaultPathStructuralScope Scope,
    VaultGitAvailability Availability,
    string? ReasonCode,
    string? RepositoryRootSha256,
    string? WorktreeIdentitySha256,
    string? HeadFactsSha256,
    string? GitVersionSha256,
    string? ConfigPolicySha256,
    VaultGitIndexFacts? Index,
    VaultGitStatusFacts? Status,
    ImmutableArray<VaultGitOperation> Operations,
    ImmutableArray<VaultGitSourceFacts> Sources,
    string WorktreeSha256,
    string OperationSha256,
    string ContentSha256);

/// <summary>Decodes a closed Git transcript and detects markers without running Git or reading files.</summary>
public static class ArticleVaultGitFactDecoder
{
    public const string Schema = "fsusblog.article-vault.git-facts.v1";
    public const int MaxOutputBytes = 1_048_576;
    public const int MaxEntries = 10_000;
    public const int MaxSourceBytes = 16_777_216;

    public static VaultGitStatusFacts DecodeStatus(ReadOnlySpan<byte> bytes)
    {
        string[] records = Records(bytes);
        int staged = 0;
        int unstaged = 0;
        int untracked = 0;
        int unmerged = 0;
        var hints = ImmutableArray.CreateBuilder<VaultGitRenameHint>();
        for (int index = 0; index < records.Length; index++)
        {
            string record = records[index];
            if (record.Length < 4 || record[2] != ' ')
            {
                throw Invalid("status_malformed");
            }

            char x = record[0];
            char y = record[1];
            string path = record[3..];
            ValidateProjection(path);
            if (x == '?' && y == '?')
            {
                untracked++;
                continue;
            }

            if (!" MADRCUT".Contains(x) || !" MADRCUT".Contains(y) || x == ' ' && y == ' ')
            {
                throw Invalid("status_malformed");
            }

            bool conflict = x == 'U' || y == 'U' || x == 'A' && y == 'A' || x == 'D' && y == 'D';
            unmerged += conflict ? 1 : 0;
            staged += x != ' ' ? 1 : 0;
            unstaged += y != ' ' ? 1 : 0;
            if (x is 'R' or 'C' || y is 'R' or 'C')
            {
                if (++index >= records.Length)
                {
                    throw Invalid("rename_malformed");
                }

                ValidateProjection(records[index]);
                hints.Add(new(ArticleVaultManifestCodec.ComputeProjectionSha256(records[index]),
                    ArticleVaultManifestCodec.ComputeProjectionSha256(path)));
            }
        }

        return new(Digest(bytes), staged, unstaged, untracked, unmerged, hints.ToImmutable());
    }

    public static VaultGitIndexFacts DecodeIndex(ReadOnlySpan<byte> bytes)
    {
        string[] records = Records(bytes);
        int unmerged = 0;
        var members = new HashSet<string>(StringComparer.Ordinal);
        foreach (string record in records)
        {
            int tab = record.IndexOf('\t');
            if (tab < 0)
            {
                throw Invalid("index_malformed");
            }

            string[] fields = record[..tab].Split(' ');
            string path = record[(tab + 1)..];
            ValidateProjection(path);
            if (fields.Length != 3 || fields[0] is not ("100644" or "100755" or "120000" or "160000")
                || !IsObjectId(fields[1]) || fields[2] is not ("0" or "1" or "2" or "3")
                || !members.Add(fields[2] + ":" + path))
            {
                throw Invalid("index_malformed");
            }

            unmerged += fields[2] != "0" ? 1 : 0;
        }

        return new(Digest(bytes), records.Length, unmerged);
    }

    /// <summary>
    /// Rejects configured clean/process filters before status can hash worktree bytes and invoke them.
    /// Only finite correctness-relevant configuration values are read; remote/credential values are absent.
    /// </summary>
    public static string DecodeConfiguration(ReadOnlySpan<byte> names, ReadOnlySpan<byte> relevantValues)
    {
        string[] keys = Records(names);
        if (keys.Any(static key => key.StartsWith("filter.", StringComparison.OrdinalIgnoreCase)
            || key.StartsWith("diff.", StringComparison.OrdinalIgnoreCase)
                && (key.EndsWith(".command", StringComparison.OrdinalIgnoreCase) || key.EndsWith(".textconv", StringComparison.OrdinalIgnoreCase))
            || key.StartsWith("merge.", StringComparison.OrdinalIgnoreCase) && key.EndsWith(".driver", StringComparison.OrdinalIgnoreCase)))
        {
            throw Invalid("external_driver_configured");
        }

        foreach (string record in Records(relevantValues))
        {
            string[] fields = record.Split('\n');
            if (fields.Length != 2 || (fields[0] switch
            {
                "core.repositoryformatversion" => fields[1] is not ("0" or "1"),
                "core.bare" or "core.ignorecase" or "core.filemode" => fields[1] is not ("true" or "false"),
                "extensions.objectformat" => fields[1] is not ("sha1" or "sha256"),
                _ => true
            }))
            {
                throw Invalid("configuration_malformed");
            }
        }

        return Digest(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            NamesSha256 = Digest(names),
            RelevantValuesSha256 = Digest(relevantValues)
        }));
    }

    public static ImmutableArray<VaultConflictSourceChange> FindMarkers(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > MaxSourceBytes)
        {
            throw Invalid("source_limit");
        }

        var markers = ImmutableArray.CreateBuilder<VaultConflictSourceChange>();
        int start = bytes.StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? 3 : 0;
        while (start < bytes.Length)
        {
            int length = bytes[start..].IndexOf((byte)'\n');
            int end = length < 0 ? bytes.Length : start + length + 1;
            ReadOnlySpan<byte> line = bytes[start..end];
            if (line.StartsWith("<<<<<<<"u8) || line.StartsWith("======="u8)
                || line.StartsWith(">>>>>>>"u8) || line.StartsWith("|||||||"u8))
            {
                if (markers.Count >= MaxEntries)
                {
                    throw Invalid("marker_limit");
                }

                markers.Add(new(start, end, "git-marker"));
            }

            start = end;
        }

        return markers.ToImmutable();
    }

    /// <summary>Rejects incomplete inventory and markers even when Git is absent.</summary>
    public static ArticleVaultValidationResult Validate(ArticleVaultGitFacts? facts)
    {
        if (facts is null || facts.Schema != Schema || facts.SchemaVersion != 1 || facts.Scope is null
            || !Enum.IsDefined(facts.Availability) || facts.Sources.IsDefault || facts.Sources.Length > MaxEntries
            || facts.Operations.IsDefault || !facts.Operations.SequenceEqual(facts.Operations.Distinct().Order())
            || facts.Operations.Any(static operation => !Enum.IsDefined(operation))
            || !ArticleVaultManifestValidator.IsSha256(facts.WorktreeSha256)
            || !ArticleVaultManifestValidator.IsSha256(facts.OperationSha256)
            || facts.ContentSha256 != ComputeContentSha256(facts))
        {
            return Rejected("facts_invalid");
        }

        VaultPathStructuralScope scope = facts.Scope;
        if (!ArticleVaultManifestValidator.IsIdentity(scope.SiteIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(scope.VaultIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(scope.DeviceIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(scope.AgentIdentity)
            || !ArticleVaultManifestValidator.IsSha256(scope.RootIdentitySha256)
            || !ArticleVaultManifestValidator.IsSha256(scope.RootManifestSha256)
            || facts.Sources.Any(static source => source is null
                || !ArticleVaultManifestValidator.IsIdentity(source.PortableArticleIdentity)
                || !ArticleVaultManifestValidator.IsSha256(source.SourceSha256) || source.MarkerRanges.IsDefault)
            || facts.Sources.Select(static source => source.PortableArticleIdentity).Distinct().Count() != facts.Sources.Length
            || !facts.Sources.Select(static source => source.PortableArticleIdentity).SequenceEqual(
                facts.Sources.Select(static source => source.PortableArticleIdentity).Order(StringComparer.Ordinal))
            || facts.WorktreeSha256 != Digest(ArticleVaultManifestCodec.SerializeCanonical(facts.Sources))
            || facts.OperationSha256 != Digest(ArticleVaultManifestCodec.SerializeCanonical(facts.Operations)))
        {
            return Rejected("binding_invalid");
        }

        foreach (VaultGitSourceFacts source in facts.Sources)
        {
            long previousEnd = 0;
            foreach (VaultConflictSourceChange? marker in source.MarkerRanges)
            {
                if (marker is null || marker.SemanticNodeIdentity != "git-marker" || marker.Start < previousEnd
                    || marker.End <= marker.Start || marker.End > MaxSourceBytes)
                {
                    return Rejected("marker_ranges_invalid");
                }

                previousEnd = marker.End;
            }
        }

        if (facts.Availability == VaultGitAvailability.Observed)
        {
            if (facts.Index is null || facts.Status is null || facts.ReasonCode is not null
                || !new[] { facts.RepositoryRootSha256, facts.WorktreeIdentitySha256, facts.HeadFactsSha256,
                    facts.GitVersionSha256, facts.ConfigPolicySha256, facts.Index.ContentSha256, facts.Status.ContentSha256 }
                    .All(ArticleVaultManifestValidator.IsSha256)
                || facts.Index.Entries is < 0 or > MaxEntries || facts.Index.UnmergedEntries < 0
                || facts.Index.UnmergedEntries > facts.Index.Entries || facts.Status.RenameHints.IsDefault
                || facts.Status.Staged < 0 || facts.Status.Unstaged < 0 || facts.Status.Untracked < 0 || facts.Status.Unmerged < 0)
            {
                return Rejected("repository_facts_invalid");
            }
        }
        else if (facts.Index is not null || facts.Status is not null || facts.RepositoryRootSha256 is not null
            || facts.WorktreeIdentitySha256 is not null || facts.HeadFactsSha256 is not null
            || facts.GitVersionSha256 is not null || facts.ConfigPolicySha256 is not null || facts.Operations.Length != 0
            || facts.Availability == VaultGitAvailability.NotPresent && facts.ReasonCode != "git-not-present"
            || facts.Availability == VaultGitAvailability.Blocked && facts.ReasonCode is not
                ("git-observation-blocked" or "git-readonly-configuration-admission-missing"))
        {
            return Rejected("availability_facts_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult AdmitSource(ArticleVaultGitFacts facts, string portableArticleIdentity, string sourceSha256)
    {
        ArticleVaultValidationResult structure = Validate(facts);
        if (!structure.IsValid)
        {
            return structure;
        }

        VaultGitSourceFacts? source = facts.Sources.SingleOrDefault(item => item.PortableArticleIdentity == portableArticleIdentity);
        if (source is null || source.SourceSha256 != sourceSha256)
        {
            return Rejected("source_binding_drift");
        }

        return facts.Availability == VaultGitAvailability.Blocked || facts.Operations.Length != 0
            || facts.Index?.UnmergedEntries > 0 || facts.Status?.Unmerged > 0 || source.MarkerRanges.Length != 0
            ? Rejected("source_blocked") : ArticleVaultValidationResult.Valid();
    }

    public static string ComputeContentSha256(ArticleVaultGitFacts facts)
        => Digest(ArticleVaultManifestCodec.SerializeCanonical(facts with
        {
            ContentSha256 = string.Empty
        }));

    public static string ComputeWorktreeSha256(ImmutableArray<VaultGitSourceFacts> sources)
        => Digest(ArticleVaultManifestCodec.SerializeCanonical(sources));

    public static string ComputeOperationSha256(ImmutableArray<VaultGitOperation> operations)
        => Digest(ArticleVaultManifestCodec.SerializeCanonical(operations));

    public static bool IsObjectId(string value)
        => value.Length is 40 or 64 && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string[] Records(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > MaxOutputBytes || !bytes.IsEmpty && bytes[^1] != 0)
        {
            throw Invalid("output_limit_or_truncated");
        }

        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw Invalid("output_encoding");
        }

        string[] records = text.Length == 0 ? [] : text[..^1].Split('\0');
        if (records.Length > MaxEntries || records.Any(static record => record.Length == 0))
        {
            throw Invalid("entry_limit_or_empty");
        }

        return records;
    }

    private static void ValidateProjection(string path)
    {
        if (path.Length > 4096 || path.StartsWith('/') || path.Contains('\\')
            || path.Split('/').Any(static segment => segment is "" or "." or "..")
            || path.Any(char.IsControl))
        {
            throw Invalid("projection_invalid");
        }
    }

    private static string Digest(ReadOnlySpan<byte> bytes) => ArticleVaultManifestCodec.ComputeSha256(bytes);

    private static InvalidDataException Invalid(string reason) => new($"article_vault_git_{reason}");

    private static ArticleVaultValidationResult Rejected(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_git_{reason}");
}
