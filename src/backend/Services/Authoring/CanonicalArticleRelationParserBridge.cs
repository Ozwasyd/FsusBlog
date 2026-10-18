using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

// Trusted host configuration, never request-selected commands, module paths or versions.
internal sealed record CanonicalArticleRelationParserRuntime(
    string NodeExecutable,
    string ScriptPath,
    string? LocalUiRoot,
    string PublicEntryDigest,
    string WasmModuleDigest,
    string Version)
{
    internal int TimeoutMilliseconds { get; init; } = 10_000;
    internal int MaxInputBytes { get; init; } = 1024 * 1024;
    internal int MaxOutputBytes { get; init; } = 2 * 1024 * 1024;
    internal long MaxWorkingSetBytes { get; init; } = 256 * 1024 * 1024;
}

// The caller must supply independently observed portable coordinates and mounted identity.
// Compare selectors/epochs and numeric DB IDs never manufacture those coordinates.
internal sealed record CanonicalArticleRelationParseRequest(
    RevisionCompareReadContext Reader,
    int ArticleId,
    RevisionCompareSourceSelector Selector,
    ArticleRelationSourceFacts Source,
    string MountedDocumentId,
    long MountedDocumentEpoch);

internal sealed record CanonicalArticleRelationParserRange(int Start, int End);

internal sealed record CanonicalArticleRelationParserNode(
    string NodeIdentity,
    string BlockIdentity,
    string Kind,
    CanonicalArticleRelationParserRange RawRange,
    CanonicalArticleRelationParserRange? LinkSourceRange,
    CanonicalArticleRelationParserRange NormalizedRange,
    CanonicalArticleRelationParserRange? ParentRawRange,
    ImmutableArray<CanonicalArticleRelationParserRange> RawContentRanges,
    string? TargetUrl,
    string? AnchorId,
    string? EmbedMode);

internal sealed record CanonicalArticleRelationParserDiagnostic(string Code, CanonicalArticleRelationParserRange RawRange);

// One explicit registry decision per canonical link, including non-block links (Target=null).
// TargetUrl is merely the original candidate; Target must come from the original registry.
internal sealed record CanonicalArticleRelationTargetBinding(string NodeIdentity, string? TargetUrl, ArticleBlockTarget? Target);

/// <summary>
/// Relation-owner bridge over the public FsusUI WASM runtime and the original authorized
/// package reader. No registration is provided: corpus generation, portable mappings and
/// fresh permission/target admission still have to close at IArticleBlockRelationParsedSource.
/// </summary>
internal sealed class CanonicalArticleRelationParserBridge(
    AuthoringRevisionComparePackageReader reader,
    CanonicalArticleRelationParserRuntime runtime)
{
    internal const string Schema = "fsusblog.canonical-article-relation-parse.v1";
    internal const int MaxSourceUtf16Length = 200_000;
    internal const int MaxNodes = 4096;
    private static readonly SemaphoreSlim s_processGate = new(1, 1);
    private static readonly object s_parseAdmission = new();
    private static readonly UTF8Encoding s_utf8 = new(false, true);
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16
    };

    // Content-free lifecycle observation also lets cancellation controls assert actual exit.
    internal event Action<int>? ProcessStarted;

    internal async Task<ParsedSource> ReadAsync(
        CanonicalArticleRelationParseRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(await s_processGate.WaitAsync(0, cancellationToken).ConfigureAwait(false), "canonical_article_relation_busy");
        try
        {
            return await ReadCoreAsync(request, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            s_processGate.Release();
        }
    }

    private async Task<ParsedSource> ReadCoreAsync(
        CanonicalArticleRelationParseRequest request,
        CancellationToken cancellationToken)
    {
        ValidateRuntime();
        Require(ArticleRelationContractValidator.Validate(request.Source).IsValid
            && request.Source.Permission == ArticleRelationPermissionState.Allowed
            && request.ArticleId > 0 && request.Reader.AdminPrincipalId > 0
            && request.Reader.RequestId != Guid.Empty && !string.IsNullOrWhiteSpace(request.Reader.SiteScope)
            && !string.IsNullOrWhiteSpace(request.MountedDocumentId) && request.MountedDocumentId.Length <= 128
            && !request.MountedDocumentId.Any(char.IsControl)
            && request.MountedDocumentEpoch is > 0 and <= 9_007_199_254_740_991,
            "canonical_article_relation_coordinate_unavailable");
        Require(SelectorValid(request.Selector), "canonical_article_relation_exact_source_required");
        cancellationToken.ThrowIfCancellationRequested();
        RevisionComparePackage package = await ReadPackageAsync(request, cancellationToken).ConfigureAwait(false);
        string rawSource;
        try
        {
            rawSource = s_utf8.GetString(package.RawMarkdown.AsSpan());
        }
        catch (DecoderFallbackException)
        {
            throw new ArticleRelationIndexException("canonical_article_relation_utf8_invalid");
        }
        Require(rawSource.Length <= MaxSourceUtf16Length, "canonical_article_relation_source_budget_exceeded");
        byte[] input = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema,
            SourceBase64 = Convert.ToBase64String(package.RawMarkdown.AsSpan()),
            package.SourceDigest,
            DocumentId = request.MountedDocumentId,
            DocumentEpoch = request.MountedDocumentEpoch,
            runtime.LocalUiRoot,
            runtime.PublicEntryDigest,
            runtime.WasmModuleDigest,
            RuntimeVersion = runtime.Version
        }, s_json);
        Require(input.Length <= runtime.MaxInputBytes, "canonical_article_relation_input_budget_exceeded");
        byte[] bytes = await RunAsync(input, cancellationToken).ConfigureAwait(false);
        ParserOutput output;
        try
        {
            output = JsonSerializer.Deserialize<ParserOutput>(bytes, s_json)
                ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new ArticleRelationIndexException("canonical_article_relation_output_invalid");
        }
        ValidateOutput(output, request, package, rawSource.Length);
        RevisionComparePackage current = await ReadPackageAsync(request, cancellationToken).ConfigureAwait(false);
        Require(current.PackageDigest == package.PackageDigest, "canonical_article_relation_source_stale");
        cancellationToken.ThrowIfCancellationRequested();
        return new ParsedSource(s_parseAdmission, request.Source, package.PackageDigest, rawSource, output);
    }

    private async Task<RevisionComparePackage> ReadPackageAsync(
        CanonicalArticleRelationParseRequest request,
        CancellationToken cancellationToken)
    {
        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            request.Reader, request.ArticleId, request.Selector, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RevisionComparePackage? package = result.Package;
        Require(result.Status == RevisionComparePackageReadStatus.Available && package is not null
            && RevisionComparePackageSeal.Verify(package)
            && package.ArticleId == request.ArticleId && package.SourceKind == request.Selector.Kind
            && package.RevisionId == request.Selector.RevisionId
            && package.ServerRevision == request.Selector.ExpectedServerRevision
            && package.DocumentEpoch == request.Selector.DocumentEpoch
            && package.SourceDigest == request.Source.ContentDigest
            && package.SourceDigest == request.Selector.ExpectedSourceDigest
            && package.RawMarkdown.Length <= MaxSourceUtf16Length * 3,
            "canonical_article_relation_source_stale");
        return package!;
    }

    private static bool SelectorValid(RevisionCompareSourceSelector selector)
        => ArticleRelationDigest.IsSha256(selector.ExpectedSourceDigest)
            && (selector.Kind == RevisionCompareSourceKind.CurrentDraft
                ? selector.RevisionId is null && !string.IsNullOrWhiteSpace(selector.DraftKey)
                    && selector.DraftKey.Length <= 256 && !selector.DraftKey.Any(char.IsControl)
                    && selector.ExpectedServerRevision > 0 && !string.IsNullOrWhiteSpace(selector.DocumentEpoch)
                    && selector.DocumentEpoch.Length <= 256 && !selector.DocumentEpoch.Any(char.IsControl)
                : selector.Kind is RevisionCompareSourceKind.CurrentRevision or RevisionCompareSourceKind.HistoricalRevision
                    && selector.RevisionId > 0 && selector.DraftKey is null
                    && selector.ExpectedServerRevision is null && selector.DocumentEpoch is null);

    private void ValidateRuntime()
    {
        Require(Path.IsPathFullyQualified(runtime.NodeExecutable) && Path.IsPathFullyQualified(runtime.ScriptPath)
            && Path.GetFileName(runtime.ScriptPath) == "canonicalArticleRelationParserBridge.mjs"
            && (runtime.LocalUiRoot is null || Path.IsPathFullyQualified(runtime.LocalUiRoot))
            && ArticleRelationDigest.IsSha256(runtime.PublicEntryDigest)
            && ArticleRelationDigest.IsSha256(runtime.WasmModuleDigest)
            && !string.IsNullOrWhiteSpace(runtime.Version) && runtime.Version.Length <= 128
            && runtime.TimeoutMilliseconds is > 0 and <= 10_000
            && runtime.MaxInputBytes is > 0 and <= 1024 * 1024
            && runtime.MaxOutputBytes is > 0 and <= 2 * 1024 * 1024
            && runtime.MaxWorkingSetBytes is > 0 and <= 256 * 1024 * 1024,
            "canonical_article_relation_runtime_unavailable");
    }

    private async Task<byte[]> RunAsync(byte[] input, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(runtime.TimeoutMilliseconds);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(runtime.NodeExecutable)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                StandardInputEncoding = s_utf8,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(runtime.ScriptPath)!
            }
        };
        // No inherited tokens, NODE_OPTIONS, loaders, credentials or private source in argv/env.
        process.StartInfo.Environment.Clear();
        process.StartInfo.ArgumentList.Add("--max-old-space-size=96");
        process.StartInfo.ArgumentList.Add("--max-semi-space-size=8");
        process.StartInfo.ArgumentList.Add("--disable-proto=throw");
        process.StartInfo.ArgumentList.Add("--disable-warning=MODULE_TYPELESS_PACKAGE_JSON");
        process.StartInfo.ArgumentList.Add(runtime.ScriptPath);
        Task[] pending = [];
        bool started = false;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            started = process.Start();
            Require(started, "canonical_article_relation_process_unavailable");
            using CancellationTokenRegistration registration = timeout.Token.Register(() => Kill(process));
            ProcessStarted?.Invoke(process.Id);
            Task write = WriteAsync(process, input, timeout.Token);
            Task<byte[]> stdout = ReadBoundedAsync(process.StandardOutput.BaseStream, runtime.MaxOutputBytes, timeout.Token);
            Task<byte[]> stderr = ReadBoundedAsync(process.StandardError.BaseStream, 4096, timeout.Token);
            Task monitor = MonitorAsync(process, timeout.Token);
            pending = [write, stdout, stderr, monitor, process.WaitForExitAsync(timeout.Token)];
            var remaining = new HashSet<Task>(pending);
            while (remaining.Count > 0)
            {
                Task completed = await Task.WhenAny(remaining).WaitAsync(timeout.Token).ConfigureAwait(false);
                await completed.ConfigureAwait(false);
                remaining.Remove(completed);
            }
            Require(process.ExitCode == 0 && stderr.Result.Length == 0, "canonical_article_relation_process_refused");
            return stdout.Result;
        }
        catch (Exception) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (Exception error) when (error is not ArticleRelationIndexException)
        {
            throw new ArticleRelationIndexException(timeout.IsCancellationRequested
                ? "canonical_article_relation_process_timeout"
                : "canonical_article_relation_process_unavailable");
        }
        finally
        {
            timeout.Cancel();
            if (started)
            {
                Kill(process);
                // Cancellation completes only after the actual child exits and pipes settle.
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
            try
            {
                await Task.WhenAll(pending).ConfigureAwait(false);
            }
            catch
            {
                // All errors above are translated without forwarding private pipe contents.
            }
        }
    }

    private async Task MonitorAsync(Process process, CancellationToken cancellationToken)
    {
        while (true)
        {
            try
            {
                if (process.HasExited)
                {
                    return;
                }
                process.Refresh();
                Require(process.WorkingSet64 <= runtime.MaxWorkingSetBytes, "canonical_article_relation_memory_budget_exceeded");
            }
            catch (InvalidOperationException) when (process.HasExited)
            {
                return;
            }
            catch (Win32Exception) when (process.HasExited)
            {
                return;
            }
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task WriteAsync(Process process, byte[] input, CancellationToken cancellationToken)
    {
        await process.StandardInput.BaseStream.WriteAsync(input, cancellationToken).ConfigureAwait(false);
        process.StandardInput.Close();
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, int limit, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        byte[] buffer = new byte[4096];
        while (true)
        {
            int count = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (count == 0)
            {
                return output.ToArray();
            }
            Require(output.Length + count <= limit, "canonical_article_relation_output_budget_exceeded");
            output.Write(buffer, 0, count);
        }
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // Exit won the race with cancellation.
        }
    }

    private void ValidateOutput(ParserOutput output, CanonicalArticleRelationParseRequest request, RevisionComparePackage package, int length)
    {
        Require(output.Schema == Schema && output.PublicModule == "@ozwasyd/element-plus/markdown-runtime"
            && output.PublicEntryDigest == runtime.PublicEntryDigest && output.WasmModuleDigest == runtime.WasmModuleDigest
            && output.Parser == "fsus-markdown-runtime" && output.Version == runtime.Version
            && !string.IsNullOrWhiteSpace(output.SourceIdentity) && output.SourceIdentity.Length <= 256
            && output.SourceDigest == package.SourceDigest && output.SourceUtf16Length == length
            && output.NormalizedUtf16Length >= 0 && output.NormalizedUtf16Length <= length
            && output.DocumentId == request.MountedDocumentId && output.DocumentEpoch == request.MountedDocumentEpoch
            && output.ProjectionNodeCount is >= 0 and <= MaxNodes
            && !output.Nodes.IsDefault && output.Nodes.Length <= output.ProjectionNodeCount
            && !output.Diagnostics.IsDefault && output.Diagnostics.Length <= MaxNodes,
            "canonical_article_relation_output_invalid");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (CanonicalArticleRelationParserNode node in output.Nodes)
        {
            Require(node is not null && !string.IsNullOrWhiteSpace(node.NodeIdentity) && node.NodeIdentity.Length <= 256
                && identities.Add(node.NodeIdentity) && !string.IsNullOrWhiteSpace(node.BlockIdentity)
                && node.BlockIdentity.Length <= 256 && node.Kind is "link" or "anchor" or "embed"
                && RangeValid(node.RawRange, length) && RangeValid(node.NormalizedRange, output.NormalizedUtf16Length)
                && (node.Kind == "link"
                    ? RangeValid(node.LinkSourceRange, length) && node.LinkSourceRange!.Start >= node.RawRange.Start
                        && node.LinkSourceRange.End <= node.RawRange.End
                    : node.LinkSourceRange is null)
                && (node.ParentRawRange is null || RangeValid(node.ParentRawRange, length)
                    && node.ParentRawRange.Start <= node.RawRange.Start && node.ParentRawRange.End >= node.RawRange.End)
                && !node.RawContentRanges.IsDefault && node.RawContentRanges.Length <= MaxNodes
                && node.RawContentRanges.All(range => RangeValid(range, length)
                    && range.Start >= node.RawRange.Start && range.End <= node.RawRange.End)
                && (node.TargetUrl is null || node.TargetUrl.Length <= MaxSourceUtf16Length)
                && (node.Kind != "anchor" || BlockAnchorId.IsCanonical(node.AnchorId))
                && (node.Kind != "embed" || node.EmbedMode is "article" or "heading" or "block"),
                "canonical_article_relation_node_invalid");
        }
        Require(output.Diagnostics.All(diagnostic => diagnostic is not null
            && !string.IsNullOrWhiteSpace(diagnostic.Code) && diagnostic.Code.Length <= 128
            && RangeValid(diagnostic.RawRange, length)), "canonical_article_relation_diagnostic_invalid");
    }

    private static bool RangeValid(CanonicalArticleRelationParserRange? range, int length)
        => range is not null && range.Start >= 0 && range.End >= range.Start && range.End <= length;

    private static void Require(bool condition, string code)
    {
        if (!condition)
        {
            throw new ArticleRelationIndexException(code);
        }
    }

    internal sealed record ParserOutput(
        string Schema, string PublicModule, string PublicEntryDigest, string WasmModuleDigest,
        string Parser, string Version, string SourceIdentity, string SourceDigest,
        int SourceUtf16Length, int NormalizedUtf16Length, string DocumentId, long DocumentEpoch,
        int ProjectionNodeCount, ImmutableArray<CanonicalArticleRelationParserNode> Nodes,
        ImmutableArray<CanonicalArticleRelationParserDiagnostic> Diagnostics);

    // Closed owner envelope: only ReadAsync constructs it after real process + original reread.
    // It carries no source-generation, rights, target-identity or mounted-epoch receipt.
    internal sealed class ParsedSource
    {
        private readonly ArticleRelationSourceFacts _source;
        private readonly string _rawSource;
        internal ParserOutput Projection
        {
            get;
        }
        internal string PackageDigest
        {
            get;
        }

        internal ParsedSource(object admission, ArticleRelationSourceFacts source, string packageDigest, string rawSource, ParserOutput projection)
        {
            Require(ReferenceEquals(admission, s_parseAdmission), "canonical_article_relation_parse_admission_required");
            _source = source;
            _rawSource = rawSource;
            PackageDigest = packageDigest;
            Projection = projection;
        }

        internal ArticleBlockRelationProductionInput Bind(
            ArticleRelationSourceFacts source,
            ArticleRelationVisibilityFacts visibility,
            long sourceGeneration,
            ImmutableArray<CanonicalArticleRelationTargetBinding> bindings,
            ImmutableArray<ArticleBlockRelationTargetInventory> targets)
        {
            Require(source == _source && source.ContentDigest == Projection.SourceDigest
                && Projection.Diagnostics.IsEmpty && !bindings.IsDefault && bindings.Length <= MaxNodes,
                "canonical_article_relation_binding_unavailable");
            CanonicalArticleRelationParserNode[] links = [.. Projection.Nodes.Where(static node => node.Kind == "link")];
            Require(bindings.Length == links.Length && bindings.All(static binding => binding is not null
                    && !string.IsNullOrWhiteSpace(binding.NodeIdentity) && binding.NodeIdentity.Length <= 256)
                && bindings.Select(static binding => binding.NodeIdentity).Distinct(StringComparer.Ordinal).Count() == bindings.Length,
                "canonical_article_relation_binding_ambiguous");
            var byIdentity = bindings.ToDictionary(static binding => binding.NodeIdentity, StringComparer.Ordinal);
            var parsed = ImmutableArray.CreateBuilder<ArticleBlockRelationParsedLink>();
            foreach (CanonicalArticleRelationParserNode node in links)
            {
                Require(byIdentity.TryGetValue(node.NodeIdentity, out CanonicalArticleRelationTargetBinding? binding)
                    && binding.TargetUrl == node.TargetUrl, "canonical_article_relation_binding_stale");
                if (binding!.Target is null)
                {
                    continue;
                }
                CanonicalArticleRelationParserRange range = node.LinkSourceRange!;
                parsed.Add(new(node.NodeIdentity, ArticleBlockRelationParsedKind.Link,
                    new(range.Start, range.End, _rawSource[range.Start..range.End]), binding.Target));
            }
            var input = new ArticleBlockRelationProductionInput(source, visibility, sourceGeneration,
                $"{Projection.Parser}/{Projection.Version}", Projection.SourceDigest, Projection.SourceUtf16Length,
                BlockAnchorSchemas.Version, BlockAnchorSchemas.ContractDigest, parsed.ToImmutable(), targets);
            ArticleBlockRelationProduction validation = ArticleBlockRelationProducer.Produce(input);
            Require(validation.Produced, validation.ReasonCode ?? "canonical_article_relation_binding_unavailable");
            return input;
        }

        public override string ToString() => Schema;
    }
}
