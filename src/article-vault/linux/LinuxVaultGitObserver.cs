using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Observes Git only inside a root admitted by the existing native verifier. No API accepts a shell,
/// command string, executable path, remote or writer. Source bytes come from the original copied-byte
/// admission; this observer does not read arbitrary worktree files or materialize content.
/// </summary>
public sealed class LinuxVaultGitObserver
{
    private readonly LinuxVaultRootVerifier.VerifiedLinuxVaultRoot _root;
    private readonly VaultPathStructuralScope _scope;

    private LinuxVaultGitObserver(LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root, string agentIdentity)
    {
        _root = root;
        _scope = new(root.Manifest.SiteIdentity, root.Manifest.VaultIdentity, root.Manifest.DeviceIdentity,
            agentIdentity, root.RootIdentity, root.Manifest.ContentSha256, VaultPathComparisonPolicy.Ordinal);
    }

    public static LinuxVaultGitObserver Open(LinuxVaultWatchRequest request)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("article_vault_git_linux_required");
        }

        ArticleVaultRootManifest manifest = ArticleVaultManifestCodec.DeserializeRoot(
            ArticleVaultManifestCodec.Serialize(request.RootManifest));
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root = LinuxVaultRootVerifier.Verify(request with
        {
            RootManifest = manifest
        });
        return new(root, request.AgentIdentity);
    }

    /// <summary>
    /// Coalesces the full admitted article inventory into one operation-bound snapshot. Missing
    /// source proofs or changing Git state blocks the batch, rather than submitting per-path events.
    /// </summary>
    public async Task<ArticleVaultGitFacts> ObserveAsync(
        IReadOnlyList<ArticleVaultAdmittedSource> admittedSources,
        CancellationToken cancellationToken = default)
    {
        VerifyRoot();
        ImmutableArray<VaultGitSourceFacts> sources = CaptureSources(admittedSources);
        using var observationDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        observationDeadline.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            CommandOutput root = await RunAsync(GitReadCommand.RepositoryRoot, observationDeadline.Token).ConfigureAwait(false);
            if (root.ExitCode != 0)
            {
                return Seal(VaultGitAvailability.NotPresent, sources);
            }

            string repositoryRoot = Line(root.Bytes);
            if (repositoryRoot != _root.CanonicalPath)
            {
                return Seal(VaultGitAvailability.Blocked, sources);
            }

            GitSnapshot before = await CaptureGitAsync(observationDeadline.Token).ConfigureAwait(false);
            GitSnapshot after = await CaptureGitAsync(observationDeadline.Token).ConfigureAwait(false);
            VerifyRoot();
            if (before.HeadSha256 != after.HeadSha256 || before.WorktreeSha256 != after.WorktreeSha256
                || before.VersionSha256 != after.VersionSha256 || before.ConfigSha256 != after.ConfigSha256 || before.Index != after.Index
                || before.Status.ContentSha256 != after.Status.ContentSha256
                || !before.Operations.SequenceEqual(after.Operations))
            {
                return Seal(VaultGitAvailability.Blocked, sources);
            }

            return Seal(VaultGitAvailability.Observed, sources, before, Digest(root.Bytes));
        }
        catch (Win32Exception)
        {
            return Seal(VaultGitAvailability.NotPresent, sources);
        }
        catch (GitObservationException exception)
        {
            return Seal(VaultGitAvailability.Blocked, sources, reasonCode: exception.ReasonCode);
        }
        catch (InvalidDataException)
        {
            return Seal(VaultGitAvailability.Blocked, sources);
        }
        catch (IOException)
        {
            return Seal(VaultGitAvailability.Blocked, sources);
        }
        catch (UnauthorizedAccessException)
        {
            return Seal(VaultGitAvailability.Blocked, sources);
        }
        catch (DecoderFallbackException)
        {
            return Seal(VaultGitAvailability.Blocked, sources);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Seal(VaultGitAvailability.Blocked, sources);
        }
    }

    /// <summary>Reruns the actual observer and compares the entire binding, not just the receipt hash.</summary>
    public async Task<ArticleVaultValidationResult> VerifyCurrentAsync(
        ArticleVaultGitFacts expected,
        IReadOnlyList<ArticleVaultAdmittedSource> currentSources,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultValidationResult structure = ArticleVaultGitFactDecoder.Validate(expected);
        if (!structure.IsValid)
        {
            return structure;
        }

        ArticleVaultGitFacts current = await ObserveAsync(currentSources, cancellationToken).ConfigureAwait(false);
        return current.ContentSha256 == expected.ContentSha256
            ? ArticleVaultValidationResult.Valid()
            : ArticleVaultValidationResult.Invalid("article_vault_git_current_facts_drift");
    }

    private ImmutableArray<VaultGitSourceFacts> CaptureSources(IReadOnlyList<ArticleVaultAdmittedSource> proofs)
    {
        if (proofs.Count > ArticleVaultGitFactDecoder.MaxEntries
            || proofs.Count != _root.Manifest.Articles.Count
            || proofs.Select(static source => source.Binding.PortableArticleIdentity).Distinct().Count() != proofs.Count)
        {
            throw new InvalidDataException("article_vault_git_source_inventory_incomplete");
        }

        var sources = ImmutableArray.CreateBuilder<VaultGitSourceFacts>();
        long sourceBytes = 0;
        foreach (ArticleVaultAdmittedSource proof in proofs.OrderBy(static source => source.Binding.PortableArticleIdentity, StringComparer.Ordinal))
        {
            VaultConflictBinding binding = proof.Binding;
            VaultArticleReference? entry = _root.Manifest.Articles.SingleOrDefault(
                article => article.PortableArticleIdentity == binding.PortableArticleIdentity);
            if (binding.SiteIdentity != _scope.SiteIdentity || binding.VaultIdentity != _scope.VaultIdentity
                || binding.DeviceIdentity != _scope.DeviceIdentity || entry?.ManifestSha256 != binding.ArticleManifestSha256)
            {
                throw new InvalidDataException("article_vault_git_source_binding_drift");
            }

            sourceBytes += binding.Coordinates.Local.Source!.ByteLength;
            if (sourceBytes > ArticleVaultGitFactDecoder.MaxSourceBytes)
            {
                throw new InvalidDataException("article_vault_git_source_batch_limit");
            }

            byte[] bytes = proof.CopyLocalBytes();
            sources.Add(new(binding.PortableArticleIdentity, Digest(bytes), ArticleVaultGitFactDecoder.FindMarkers(bytes)));
        }

        return sources.ToImmutable();
    }

    private async Task<GitSnapshot> CaptureGitAsync(CancellationToken cancellationToken)
    {
        CommandOutput configNames = await RequiredAsync(GitReadCommand.ConfigNames, cancellationToken).ConfigureAwait(false);
        CommandOutput configValues = await RunAsync(GitReadCommand.ConfigValues, cancellationToken).ConfigureAwait(false);
        if (configValues.ExitCode is not (0 or 1))
        {
            throw new GitObservationException();
        }

        string configDigest = ArticleVaultGitFactDecoder.DecodeConfiguration(configNames.Bytes, configValues.Bytes);
        CommandOutput head = await RunAsync(GitReadCommand.Head, cancellationToken).ConfigureAwait(false);
        if (head.ExitCode is not (0 or 1) || head.ExitCode == 0 && !ArticleVaultGitFactDecoder.IsObjectId(Line(head.Bytes)))
        {
            throw new GitObservationException();
        }

        RequireReadOnlyConfigurationAdmission();
        CommandOutput status = await RequiredAsync(GitReadCommand.Status, cancellationToken).ConfigureAwait(false);
        CommandOutput index = await RequiredAsync(GitReadCommand.Index, cancellationToken).ConfigureAwait(false);
        CommandOutput gitDirectory = await RequiredAsync(GitReadCommand.GitDirectory, cancellationToken).ConfigureAwait(false);
        CommandOutput version = await RequiredAsync(GitReadCommand.Version, cancellationToken).ConfigureAwait(false);
        string versionText = Line(version.Bytes);
        if (!versionText.StartsWith("git version ", StringComparison.Ordinal) || versionText.Length > 128)
        {
            throw new GitObservationException();
        }

        var operations = ImmutableArray.CreateBuilder<VaultGitOperation>();
        foreach ((GitReadCommand command, VaultGitOperation operation) in new[]
        {
            (GitReadCommand.MergeHead, VaultGitOperation.Merge),
            (GitReadCommand.RebaseMerge, VaultGitOperation.Rebase),
            (GitReadCommand.RebaseApply, VaultGitOperation.Rebase),
            (GitReadCommand.CherryPickHead, VaultGitOperation.CherryPick),
            (GitReadCommand.RevertHead, VaultGitOperation.Revert),
            (GitReadCommand.BisectStart, VaultGitOperation.Bisect),
            (GitReadCommand.Sequencer, VaultGitOperation.Sequencer)
        })
        {
            CommandOutput location = await RequiredAsync(command, cancellationToken).ConfigureAwait(false);
            string path = Line(location.Bytes);
            if (!Path.IsPathFullyQualified(path))
            {
                throw new GitObservationException();
            }

            // Git's own control paths may belong to a linked worktree. Never expose or execute them.
            if (Path.Exists(path))
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new GitObservationException();
                }

                operations.Add(operation);
            }
        }

        return new(Digest(head.Bytes), Digest(gitDirectory.Bytes), Digest(version.Bytes), configDigest,
            ArticleVaultGitFactDecoder.DecodeIndex(index.Bytes), ArticleVaultGitFactDecoder.DecodeStatus(status.Bytes),
            operations.Distinct().Order().ToImmutableArray());
    }

    private ArticleVaultGitFacts Seal(
        VaultGitAvailability availability,
        ImmutableArray<VaultGitSourceFacts> sources,
        GitSnapshot? git = null,
        string? repositoryRootSha256 = null,
        string? reasonCode = null)
    {
        ImmutableArray<VaultGitOperation> operations = git?.Operations ?? [];
        ArticleVaultGitFacts facts = new(ArticleVaultGitFactDecoder.Schema, 1, _scope, availability,
            availability switch
            {
                VaultGitAvailability.NotPresent => "git-not-present",
                VaultGitAvailability.Blocked => reasonCode ?? "git-observation-blocked",
                _ => null
            }, repositoryRootSha256, git?.WorktreeSha256, git?.HeadSha256, git?.VersionSha256,
            git is null ? null : Digest(Encoding.UTF8.GetBytes(git.ConfigSha256 + "\0" + string.Join('\0', s_commandPolicy))),
            git?.Index, git?.Status, operations, sources,
            ArticleVaultGitFactDecoder.ComputeWorktreeSha256(sources),
            ArticleVaultGitFactDecoder.ComputeOperationSha256(operations), string.Empty);
        return facts with
        {
            ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(facts)
        };
    }

    private void VerifyRoot()
    {
        LinuxVaultRootVerifier.PathVerification verification = LinuxVaultRootVerifier.VerifyWatchedRoot(_root);
        if (verification.Disposition == LinuxVaultPathDisposition.Blocked)
        {
            throw new LinuxVaultWatcherException(verification.ErrorCode ?? "article_vault_git_root_drift");
        }
    }

    private static readonly string[] s_commandPolicy =
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null"];

    private async Task<CommandOutput> RequiredAsync(GitReadCommand command, CancellationToken cancellationToken)
    {
        CommandOutput output = await RunAsync(command, cancellationToken).ConfigureAwait(false);
        return output.ExitCode == 0 ? output : throw new GitObservationException();
    }

    private async Task<CommandOutput> RunAsync(GitReadCommand command, CancellationToken cancellationToken)
    {
        string[] arguments = command switch
        {
            GitReadCommand.RepositoryRoot => ["rev-parse", "--show-toplevel"],
            GitReadCommand.GitDirectory => ["rev-parse", "--absolute-git-dir"],
            GitReadCommand.Head => ["rev-parse", "--verify", "--quiet", "HEAD"],
            GitReadCommand.Status => ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
            GitReadCommand.Index => ["ls-files", "--stage", "-z"],
            GitReadCommand.Version => ["--version"],
            GitReadCommand.ConfigNames => ["config", "--null", "--name-only", "--list"],
            GitReadCommand.ConfigValues => ["config", "--null", "--get-regexp", "^(core\\.(repositoryformatversion|bare|ignorecase|filemode)|extensions\\.objectformat)$"],
            GitReadCommand.MergeHead => OperationPath("MERGE_HEAD"),
            GitReadCommand.RebaseMerge => OperationPath("rebase-merge"),
            GitReadCommand.RebaseApply => OperationPath("rebase-apply"),
            GitReadCommand.CherryPickHead => OperationPath("CHERRY_PICK_HEAD"),
            GitReadCommand.RevertHead => OperationPath("REVERT_HEAD"),
            GitReadCommand.BisectStart => OperationPath("BISECT_START"),
            GitReadCommand.Sequencer => OperationPath("sequencer"),
            _ => throw new GitObservationException()
        };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        var start = new ProcessStartInfo("/usr/bin/git")
        {
            WorkingDirectory = _root.CanonicalPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        start.Environment.Clear();
        start.Environment["PATH"] = "/usr/bin:/bin";
        start.Environment["LC_ALL"] = "C";
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        foreach (string argument in s_commandPolicy.Concat(arguments))
        {
            start.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = start };
        bool started = false;
        try
        {
            process.Start();
            started = true;
            Task<byte[]> stdout = ReadBoundedAsync(process.StandardOutput.BaseStream, deadline.Token);
            Task<byte[]> stderr = ReadBoundedAsync(process.StandardError.BaseStream, deadline.Token);
            Task exited = process.WaitForExitAsync(deadline.Token);
            await Task.WhenAll(stdout, stderr, exited).ConfigureAwait(false);
            return new(process.ExitCode, await stdout.ConfigureAwait(false));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new GitObservationException();
        }
        finally
        {
            if (started && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                using var cleanupDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await process.WaitForExitAsync(cleanupDeadline.Token).ConfigureAwait(false);
            }
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) != 0)
        {
            if (output.Length + count > ArticleVaultGitFactDecoder.MaxOutputBytes)
            {
                throw new GitObservationException();
            }

            output.Write(buffer, 0, count);
        }

        return output.ToArray();
    }

    private static string[] OperationPath(string name) => ["rev-parse", "--path-format=absolute", "--git-path", name];

    private static void RequireReadOnlyConfigurationAdmission()
    {
        // status may invoke clean/process filters when hashing changed worktree bytes. Config
        // preflight alone cannot prevent a concurrent external editor from introducing a new filter.
        // The native owner must provide a frozen config or descendant-exec isolation capability;
        // until then even a clean transcript cannot authorize running status against a live config.
        throw new GitObservationException("git-readonly-configuration-admission-missing");
    }

    private static string Line(byte[] bytes)
    {
        if (bytes.Length is 0 or > 4096 || bytes[^1] != '\n' || bytes[..^1].Contains((byte)'\n') || bytes.Contains((byte)0))
        {
            throw new GitObservationException();
        }

        return new UTF8Encoding(false, true).GetString(bytes.AsSpan(0, bytes.Length - 1));
    }

    private static string Digest(ReadOnlySpan<byte> bytes) => ArticleVaultManifestCodec.ComputeSha256(bytes);

    private enum GitReadCommand
    {
        RepositoryRoot, GitDirectory, Head, Status, Index, Version, ConfigNames, ConfigValues,
        MergeHead, RebaseMerge, RebaseApply, CherryPickHead, RevertHead, BisectStart, Sequencer
    }

    private sealed record CommandOutput(int ExitCode, byte[] Bytes);

    private sealed record GitSnapshot(
        string HeadSha256,
        string WorktreeSha256,
        string VersionSha256,
        string ConfigSha256,
        VaultGitIndexFacts Index,
        VaultGitStatusFacts Status,
        ImmutableArray<VaultGitOperation> Operations);

    private sealed class GitObservationException(string reasonCode = "git-observation-blocked") : Exception
    {
        public string ReasonCode { get; } = reasonCode;
    }
}
