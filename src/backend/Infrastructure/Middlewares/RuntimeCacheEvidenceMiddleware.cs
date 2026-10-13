using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Infrastructure.Middlewares;

internal sealed class RuntimeCacheEvidenceMiddleware(
    RequestDelegate next,
    IConfiguration configuration,
    IHostEnvironment environment,
    RuntimeCacheEvidenceStore store)
{
    internal const string RequestIdHeader = "X-Fsus-Runtime-Evidence-Request";
    internal const string SecretHeader = "X-Fsus-Runtime-Evidence-Secret";
    internal const string SecretConfigurationKey = "FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET";
    private static readonly object s_authenticatedSecretItemKey = new();
    private static readonly object s_authenticatedObservationItemKey = new();
    private readonly string? _secret = ResolveSecret(configuration, environment);
    private readonly QueryPlanCommandCaptureStore? _queryPlanCapture = QueryPlanCommandCaptureStore.Load(configuration, environment);

    public async Task InvokeAsync(HttpContext context)
    {
        bool secretAuthenticated = _secret is not null &&
            SecretEquals(_secret, context.Request.Headers[SecretHeader].ToString());
        if (secretAuthenticated)
        {
            context.Items[s_authenticatedSecretItemKey] = true;
        }

        string requestId = context.Request.Headers[RequestIdHeader].ToString().Trim();
        if (!secretAuthenticated || requestId.Length is < 8 or > 128)
        {
            await next(context);
            return;
        }

        context.Items[s_authenticatedObservationItemKey] = true;
        Stream originalBody = context.Response.Body;
        await using var hashingBody = new HashingWriteStream(originalBody);
        context.Response.Body = hashingBody;
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            requestId,
            context.Request.Method,
            $"{context.Request.Path.Value ?? "/"}{context.Request.QueryString.Value}",
            queryPlanCapture: context.Request.Method == "GET" && context.Request.Path.StartsWithSegments("/api/binary")
                ? _queryPlanCapture?.Begin(requestId) : null);
        try
        {
            await next(context);
        }
        finally
        {
            await hashingBody.FlushAsync(context.RequestAborted);
            context.Response.Body = originalBody;
            store.Store(observation, context.Response.StatusCode, hashingBody.GetDigest());
        }
    }

    internal static bool AllowsAuthenticatedHeader(HttpContext context, string headerName)
    {
        if (string.Equals(headerName, SecretHeader, StringComparison.OrdinalIgnoreCase))
        {
            return context.Items.ContainsKey(s_authenticatedSecretItemKey);
        }

        return string.Equals(headerName, RequestIdHeader, StringComparison.OrdinalIgnoreCase)
            && context.Items.ContainsKey(s_authenticatedObservationItemKey);
    }

    internal static bool IsAuthenticatedObservation(HttpContext context)
        => context.Items.ContainsKey(s_authenticatedObservationItemKey);

    private static string? ResolveSecret(IConfiguration configuration, IHostEnvironment environment)
    {
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            return null;
        }

        string? secret = configuration[SecretConfigurationKey]
            ?? Environment.GetEnvironmentVariable(SecretConfigurationKey);
        return string.IsNullOrWhiteSpace(secret) ? null : secret;
    }

    private static bool SecretEquals(string expected, string provided)
    {
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length == right.Length && CryptographicOperations.FixedTimeEquals(left, right);
    }

    private sealed class HashingWriteStream(Stream inner) : Stream
    {
        private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        private bool _finalized;
        private string? _digest;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => inner.CanWrite;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush() => inner.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            _hash.AppendData(buffer, offset, count);
            inner.Write(buffer, offset, count);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            _hash.AppendData(buffer.Span);
            await inner.WriteAsync(buffer, cancellationToken);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            _hash.AppendData(buffer, offset, count);
            return inner.WriteAsync(buffer, offset, count, cancellationToken);
        }

        internal string GetDigest()
        {
            if (!_finalized)
            {
                _digest = $"sha256:{Convert.ToHexStringLower(_hash.GetHashAndReset())}";
                _finalized = true;
            }
            return _digest!;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _hash.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
