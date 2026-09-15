using System.Collections.Immutable;
using System.Text;
using System.Xml.Linq;

namespace FsusBlog.Server.Services.DocumentExport;

public sealed record DocumentExportRendererRequest(
    string Schema,
    string InputId,
    string InputDigest,
    string SourceDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    ImmutableArray<byte> MarkdownUtf8,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string LayoutProfile,
    string ThemeProfile,
    string Locale,
    ImmutableArray<DocumentExportAsset> Assets);

public sealed record DocumentExportRendererResponse(
    string Schema,
    string InputId,
    string InputDigest,
    string SourceDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string Title,
    string HtmlFragment,
    ImmutableArray<string> ObservedFeatures,
    string ContentDigest);

public sealed record DocumentExportProviderResult(
    byte[] Bytes,
    byte[] SandboxOutputBytes,
    DocumentExportProviderReceipt Receipt,
    DocumentExportSandboxPlan SandboxPlan,
    DocumentExportSandboxReceipt SandboxReceipt);

/// <summary>
/// Packages canonical renderer output without interpreting Markdown. The result
/// is one deterministic, offline HTML document with embedded frozen assets.
/// </summary>
public sealed class SelfContainedHtmlDocumentExportProvider
{
    private const string ProviderStyle = "html{color-scheme:light dark}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.65;background:#fff;color:#18181b}main{max-width:72ch;margin:auto;padding:3rem 1.25rem}img,svg,video{max-width:100%;height:auto}pre{overflow:auto;padding:1rem;background:#f4f4f5;border-radius:.5rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d4d4d8;padding:.5rem;text-align:start}a{color:#155eef}figure{margin:1.5rem 0}figcaption{color:#52525b;font-size:.9em}@media print{main{max-width:none;padding:0}a{color:inherit}}";
    private static readonly string s_styleHash = Convert.ToBase64String(
        System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(ProviderStyle)));
    private readonly DocumentExportSandboxRuntime _sandbox;

    public SelfContainedHtmlDocumentExportProvider(DocumentExportSandboxRuntime sandbox)
    {
        _sandbox = sandbox ?? throw new ArgumentNullException(nameof(sandbox));
    }

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        CancellationToken cancellationToken = default)
    {
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        DocumentExportFrozenInput frozenInput = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(task, frozenInput);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!provider.ImplementationAvailable || provider.FormatId != "self-contained-html")
        {
            throw new InvalidOperationException("Only the self-contained HTML provider is implemented in this slice.");
        }

        var request = new DocumentExportRendererRequest(
            DocumentExportContractCatalog.RendererRequestSchema,
            frozenInput.InputId,
            frozenInput.ContentDigest,
            frozenInput.SourceDigest,
            frozenInput.AssetManifestDigest,
            frozenInput.FontManifestDigest,
            frozenInput.ReadingStyleAuthorityDigest,
            frozenInput.MarkdownUtf8,
            frozenInput.RendererId,
            frozenInput.RendererVersion,
            frozenInput.RendererDigest,
            frozenInput.LayoutProfile,
            frozenInput.ThemeProfile,
            frozenInput.Locale,
            frozenInput.Assets);
        byte[] requestBytes = DocumentExportDigest.Serialize(request);
        DocumentExportSandboxResult sandboxResult = await _sandbox.ExecuteAsync(
            task,
            frozenInput,
            tool,
            requestBytes,
            cancellationToken);
        DocumentExportSandboxRuntime.ValidateReceipt(
            sandboxResult.Receipt,
            sandboxResult.Plan,
            task,
            frozenInput,
            tool,
            sandboxResult.Plan.HostBuildDigest,
            sandboxResult.OutputBytes);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(
            sandboxResult.OutputBytes);
        ValidateRendererResponse(response, frozenInput);

        IReadOnlyList<string> observedFeatures = ValidateFeatures(response.ObservedFeatures, provider);
        XElement article = ValidateAndNormalizeFragment(response.HtmlFragment, frozenInput.Assets);
        string output = ComposeDocument(response.Title, frozenInput.Locale, article);
        byte[] outputBytes = Encoding.UTF8.GetBytes(output);
        if (outputBytes.LongLength > provider.Budgets.MaxOutputBytes)
        {
            throw new DocumentExportBudgetExceededException("Self-contained HTML exceeds its output budget.");
        }

        string[] warnings = WarningsFor(observedFeatures, provider);
        DocumentExportProviderReceipt unsigned = new(
            DocumentExportContractCatalog.ResultSchema,
            task.ContentDigest,
            frozenInput.ContentDigest,
            provider.ProviderId,
            provider.ProviderVersion,
            frozenInput.RendererId,
            frozenInput.RendererVersion,
            frozenInput.RendererDigest,
            frozenInput.AssetManifestDigest,
            frozenInput.FontManifestDigest,
            frozenInput.ReadingStyleAuthorityDigest,
            tool.ToolId,
            tool.ToolVersion,
            sandboxResult.Receipt.ContentDigest,
            provider.OutputMediaType,
            provider.OutputExtension,
            provider.NormalizationPolicy,
            DocumentExportDigest.ComputeBytes(outputBytes),
            DocumentExportDigest.ComputeBytes(outputBytes),
            outputBytes.LongLength,
            observedFeatures,
            warnings,
            [],
            DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds,
            string.Empty);
        DocumentExportProviderReceipt receipt = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        return new DocumentExportProviderResult(
            outputBytes,
            sandboxResult.OutputBytes,
            receipt,
            sandboxResult.Plan,
            sandboxResult.Receipt);
    }

    public static DocumentExportRendererResponse SealRendererResponse(DocumentExportRendererResponse response)
    {
        DocumentExportRendererResponse unsigned = response with
        {
            ObservedFeatures = response.ObservedFeatures.ToArray().ToImmutableArray(),
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static void ValidateResult(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(task);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(tool);
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!provider.ImplementationAvailable || provider.FormatId != "self-contained-html")
        {
            throw new InvalidDataException("The result is not owned by the self-contained HTML provider.");
        }
        DocumentExportSandboxRuntime.ValidatePlan(
            result.SandboxPlan,
            task,
            input,
            provider,
            tool,
            expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateReceipt(
            result.SandboxReceipt,
            result.SandboxPlan,
            task,
            input,
            tool,
            expectedHostBuildDigest,
            result.SandboxOutputBytes);

        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(
            result.SandboxOutputBytes);
        ValidateRendererResponse(response, input);
        IReadOnlyList<string> observedFeatures = ValidateFeatures(response.ObservedFeatures, provider);
        XElement article = ValidateAndNormalizeFragment(response.HtmlFragment, input.Assets);
        byte[] expectedBytes = Encoding.UTF8.GetBytes(ComposeDocument(response.Title, input.Locale, article));
        string[] expectedWarnings = WarningsFor(observedFeatures, provider);
        DocumentExportProviderReceipt receipt = result.Receipt;
        if (receipt.Schema != DocumentExportContractCatalog.ResultSchema
            || receipt.TaskDigest != task.ContentDigest
            || receipt.InputDigest != input.ContentDigest
            || receipt.ProviderId != provider.ProviderId
            || receipt.ProviderVersion != provider.ProviderVersion
            || receipt.RendererId != input.RendererId
            || receipt.RendererVersion != input.RendererVersion
            || receipt.RendererDigest != input.RendererDigest
            || receipt.AssetManifestDigest != input.AssetManifestDigest
            || receipt.FontManifestDigest != input.FontManifestDigest
            || receipt.ReadingStyleAuthorityDigest != input.ReadingStyleAuthorityDigest
            || receipt.ToolId != tool.ToolId
            || receipt.ToolVersion != tool.ToolVersion
            || receipt.SandboxReceiptDigest != result.SandboxReceipt.ContentDigest
            || receipt.OutputMediaType != provider.OutputMediaType
            || receipt.OutputExtension != provider.OutputExtension
            || receipt.NormalizationPolicy != provider.NormalizationPolicy
            || receipt.OutputBytes != result.Bytes.LongLength
            || !result.Bytes.AsSpan().SequenceEqual(expectedBytes)
            || receipt.OutputDigest != DocumentExportDigest.ComputeBytes(result.Bytes)
            || receipt.SemanticDigest != receipt.OutputDigest
            || !receipt.ObservedFeatures.SequenceEqual(observedFeatures, StringComparer.Ordinal)
            || !receipt.Warnings.SequenceEqual(expectedWarnings, StringComparer.Ordinal)
            || receipt.Errors.Count != 0
            || receipt.Status != DocumentExportProviderResultStatus.Succeeded
            || receipt.CleanupExpiresAfterSeconds != (long)provider.Delivery.RetentionTtl.TotalSeconds)
        {
            throw new InvalidDataException("Self-contained HTML result identity mismatch.");
        }
        DocumentExportProviderReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        if (receipt.ContentDigest != DocumentExportDigest.Compute(unsigned))
        {
            throw new InvalidDataException("Self-contained HTML receipt digest mismatch.");
        }
        ValidateDocument(result.Bytes, input);
    }

    internal static void ValidateRendererResponse(
        DocumentExportRendererResponse response,
        DocumentExportFrozenInput input)
    {
        if (response.Schema != DocumentExportContractCatalog.RendererResponseSchema
            || response.InputId != input.InputId
            || response.InputDigest != input.ContentDigest
            || response.SourceDigest != input.SourceDigest
            || response.AssetManifestDigest != input.AssetManifestDigest
            || response.FontManifestDigest != input.FontManifestDigest
            || response.ReadingStyleAuthorityDigest != input.ReadingStyleAuthorityDigest
            || response.RendererId != input.RendererId
            || response.RendererVersion != input.RendererVersion
            || response.RendererDigest != input.RendererDigest
            || string.IsNullOrWhiteSpace(response.Title)
            || response.Title.Any(char.IsControl)
            || response.ContentDigest != DocumentExportDigest.Compute(response with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new InvalidDataException("Canonical renderer response identity is missing, drifted or tampered.");
        }
    }

    private static IReadOnlyList<string> ValidateFeatures(
        IReadOnlyList<string> observed,
        DocumentExportProviderContract provider)
    {
        ArgumentNullException.ThrowIfNull(observed);
        string[] ordered = observed.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
        if (ordered.Length != observed.Count
            || ordered.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("Canonical renderer reported an unknown or duplicate feature.");
        }
        foreach (string feature in ordered)
        {
            if (provider.Features.Single(item => item.FeatureId == feature).Disposition == DocumentExportFeatureDisposition.HardFail)
            {
                throw new InvalidDataException($"Feature '{feature}' is not supported by the selected provider.");
            }
        }
        return ordered;
    }

    private static string[] WarningsFor(
        IReadOnlyList<string> observedFeatures,
        DocumentExportProviderContract provider)
        => provider.Features
            .Where(feature => observedFeatures.Contains(feature.FeatureId, StringComparer.Ordinal)
                && feature.Disposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback)
            .Select(feature => $"{feature.FeatureId}:{feature.PreservedFallback}")
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();

    private static XElement ValidateAndNormalizeFragment(
        string htmlFragment,
        IReadOnlyList<DocumentExportAsset> assets)
    {
        XElement root;
        try
        {
            root = XElement.Parse($"<article xmlns=\"http://www.w3.org/1999/xhtml\">{htmlFragment}</article>", LoadOptions.PreserveWhitespace);
        }
        catch (Exception exception) when (exception is System.Xml.XmlException or ArgumentException)
        {
            throw new InvalidDataException("Canonical renderer output is not a deterministic XHTML fragment.", exception);
        }

        foreach (XElement element in root.DescendantsAndSelf())
        {
            string name = element.Name.LocalName.ToLowerInvariant();
            if (name is "script" or "style" or "link" or "iframe" or "object" or "embed" or "base" or "form")
            {
                throw new InvalidDataException($"Element '{name}' is prohibited in self-contained HTML.");
            }
            foreach (XAttribute attribute in element.Attributes().ToArray())
            {
                string attributeName = attribute.Name.LocalName.ToLowerInvariant();
                if (attributeName.StartsWith("on", StringComparison.Ordinal)
                    || attributeName is "srcdoc" or "formaction")
                {
                    throw new InvalidDataException("Executable HTML attributes are prohibited.");
                }
                if (attributeName is "src" or "href" or "poster")
                {
                    ValidateUri(element, attribute);
                }
            }
        }

        Dictionary<string, DocumentExportAsset> expected = assets.Where(asset => asset.Role == "image")
            .ToDictionary(asset => asset.AssetId, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (XElement image in root.Descendants().Where(element => element.Name.LocalName == "img"))
        {
            string assetId = image.Attribute("data-asset-id")?.Value
                ?? throw new InvalidDataException("Every rendered image must bind a frozen asset identity.");
            if (!expected.TryGetValue(assetId, out DocumentExportAsset? asset) || !seen.Add(assetId))
            {
                throw new InvalidDataException("Rendered asset identity is missing, duplicated or unknown.");
            }
            string expectedUri = $"data:{asset.MediaType};base64,{Convert.ToBase64String(asset.Bytes.AsSpan())}";
            if (image.Attribute("src")?.Value != expectedUri || image.Attribute("alt")?.Value != asset.AltText)
            {
                throw new InvalidDataException("Rendered asset bytes or accessible text drifted from frozen input.");
            }
        }
        if (!seen.SetEquals(expected.Keys))
        {
            throw new InvalidDataException("Not every frozen asset was embedded in the document.");
        }
        return root;
    }

    private static void ValidateUri(XElement element, XAttribute attribute)
    {
        string value = attribute.Value.Trim();
        if (value.StartsWith('#'))
        {
            return;
        }
        if (attribute.Name.LocalName == "src" && value.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        if (element.Name.LocalName == "a"
            && attribute.Name.LocalName == "href"
            && Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            element.SetAttributeValue("target", "_blank");
            element.SetAttributeValue("rel", "noopener noreferrer external");
            return;
        }
        throw new InvalidDataException("Self-contained HTML contains a prohibited resource reference.");
    }

    private static string ComposeDocument(string title, string locale, XElement article)
    {
        string direction = locale.StartsWith("ar", StringComparison.OrdinalIgnoreCase)
            || locale.StartsWith("he", StringComparison.OrdinalIgnoreCase)
                ? "rtl"
                : "ltr";
        string escapedTitle = System.Net.WebUtility.HtmlEncode(title);
        string fragment = string.Concat(article.Nodes().Select(node => node.ToString(SaveOptions.DisableFormatting)));
        return "<!doctype html>\n"
            + $"<html lang=\"{System.Net.WebUtility.HtmlEncode(locale)}\" dir=\"{direction}\">\n"
            + "<head>\n<meta charset=\"utf-8\" />\n"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />\n"
            + $"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'sha256-{s_styleHash}'; base-uri 'none'; form-action 'none'\" />\n"
            + $"<title>{escapedTitle}</title>\n<style>{ProviderStyle}</style>\n</head>\n"
            + $"<body><main><article>{fragment}</article></main></body>\n</html>\n";
    }

    private static void ValidateDocument(byte[] bytes, DocumentExportFrozenInput input)
    {
        string html = new UTF8Encoding(false, true).GetString(bytes);
        if (!html.StartsWith("<!doctype html>\n", StringComparison.Ordinal)
            || html.Contains('\r', StringComparison.Ordinal))
        {
            throw new InvalidDataException("Self-contained HTML encoding or normalization drifted.");
        }
        XDocument document;
        try
        {
            document = XDocument.Parse(html["<!doctype html>\n".Length..], LoadOptions.PreserveWhitespace);
        }
        catch (System.Xml.XmlException exception)
        {
            throw new InvalidDataException("Self-contained HTML is not independently parseable.", exception);
        }
        XElement root = document.Root
            ?? throw new InvalidDataException("Self-contained HTML root is missing.");
        XElement head = root.Elements().SingleOrDefault(element => element.Name.LocalName == "head")
            ?? throw new InvalidDataException("Self-contained HTML head is missing.");
        XElement body = root.Elements().SingleOrDefault(element => element.Name.LocalName == "body")
            ?? throw new InvalidDataException("Self-contained HTML body is missing.");
        XElement article = body.Descendants().SingleOrDefault(element => element.Name.LocalName == "article")
            ?? throw new InvalidDataException("Self-contained HTML article is missing.");
        string expectedCsp = $"default-src 'none'; img-src data:; style-src 'sha256-{s_styleHash}'; base-uri 'none'; form-action 'none'";
        if (root.Name.LocalName != "html"
            || root.Attribute("lang")?.Value != input.Locale
            || head.Elements().SingleOrDefault(element => element.Name.LocalName == "meta"
                && element.Attribute("http-equiv")?.Value == "Content-Security-Policy")?.Attribute("content")?.Value != expectedCsp
            || head.Elements().SingleOrDefault(element => element.Name.LocalName == "style")?.Value != ProviderStyle)
        {
            throw new InvalidDataException("Self-contained HTML metadata, locale or CSP drifted.");
        }
        ValidateElementClosure(article, input.Assets);
    }

    private static void ValidateElementClosure(XElement root, IReadOnlyList<DocumentExportAsset> assets)
    {
        foreach (XElement element in root.DescendantsAndSelf())
        {
            string name = element.Name.LocalName.ToLowerInvariant();
            if (name is "script" or "link" or "iframe" or "object" or "embed" or "base" or "form")
            {
                throw new InvalidDataException("Self-contained HTML contains an active or remote surface.");
            }
            foreach (XAttribute attribute in element.Attributes())
            {
                string attributeName = attribute.Name.LocalName.ToLowerInvariant();
                if (attributeName.StartsWith("on", StringComparison.Ordinal)
                    || attributeName is "srcdoc" or "formaction")
                {
                    throw new InvalidDataException("Self-contained HTML contains executable attributes.");
                }
                if (attributeName is "src" or "href" or "poster")
                {
                    ValidateUri(element, attribute);
                }
            }
        }
        Dictionary<string, DocumentExportAsset> expected = assets.Where(asset => asset.Role == "image")
            .ToDictionary(asset => asset.AssetId, StringComparer.Ordinal);
        XElement[] images = root.Descendants().Where(element => element.Name.LocalName == "img").ToArray();
        if (images.Length != expected.Count)
        {
            throw new InvalidDataException("Self-contained HTML asset closure is incomplete.");
        }
        foreach (XElement image in images)
        {
            string assetId = image.Attribute("data-asset-id")?.Value
                ?? throw new InvalidDataException("Self-contained HTML asset identity is missing.");
            if (!expected.TryGetValue(assetId, out DocumentExportAsset? asset)
                || image.Attribute("src")?.Value != $"data:{asset.MediaType};base64,{Convert.ToBase64String(asset.Bytes.AsSpan())}"
                || image.Attribute("alt")?.Value != asset.AltText)
            {
                throw new InvalidDataException("Self-contained HTML asset bytes drifted.");
            }
        }
    }
}
