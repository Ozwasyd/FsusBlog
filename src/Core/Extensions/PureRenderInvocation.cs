using System.Text;
using System.Text.Json;

namespace FsusBlog.V2.Core.Extensions;

internal static class PureRenderInvocation
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal static async Task RunAsync(DirectoryInfo root, string id, string markdown,
        Func<byte[], CancellationToken, Task<byte[]>> run,
        Func<CancellationToken, Task>? authorizeResult,
        Func<byte[], CancellationToken, Task> deliver, CancellationToken ct, PureRenderPlugin.Approval? expectedApproval = null)
    {
        if (markdown.Contains('\0') || Utf8.GetByteCount(markdown) > PureRenderPlugin.MaximumMarkdownBytes)
            throw new ExtensionRejectedException("plugin-markdown-input");
        using var approval = PureRenderPlugin.Open(root, id, TimeProvider.System, ct);
        if (expectedApproval is not null && approval.ApprovalIdentity != expectedApproval)
            throw new ExtensionRejectedException("plugin-consent-approval-changed");
        var request = JsonSerializer.SerializeToUtf8Bytes(new PurePluginRequest(id, approval.JavaScript, markdown, approval.TimeoutMs));
        var result = await run(request, ct);
        if (result.Length > PureRenderPlugin.MaximumMarkdownBytes || Utf8.GetString(result).Contains('\0'))
            throw new ExtensionRejectedException("plugin-worker-output");
        if (authorizeResult is not null) await authorizeResult(ct);
        approval.VerifyCompletion(ct);
        ct.ThrowIfCancellationRequested();
        await deliver(result, ct);
    }
}
