namespace FsusBlog.V2.Integration.Tests;

internal static class PublicationFixture
{
    private const string Signing = "IntegrityProof__Signing__";

    internal const string DefaultRightsForPublishedArticles = """
        insert into public.article_revision_rights (
            article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
            copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
            select article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
            from public.article_publication;
        insert into public.article_publication_rights (article_id,publication_id,revision)
            select article_id,publication_id,revision from public.article_publication;
        """;

    internal const string AllCurrentArticlesWithDefaultRights = """
        insert into public.article_revision(article_id,revision,title,body,happened_at)
            select id,revision,title,body,created_at from public.article;
        insert into public.article_publication(article_id,revision,publication_id,published_at)
            select id,revision,10000+id,created_at from public.article;
        """ + "\n" + DefaultRightsForPublishedArticles;

    internal static async Task<ArticleState> EditDraft(Store store, string token, ArticleAction action, Edit edit, CancellationToken ct) =>
        (await store.WithSession(token, true, (db, tx, actor) => Store.Execute(db, tx, actor, action, edit, ct), ct)).Article;

    internal static Publications Project(NpgsqlDataSource source, InstanceLease? lease = null) =>
        new(source, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance, lease);

    internal static DirectoryInfo PrivateScratch(string prefix)
    {
        var parent = OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp";
        var directory = Directory.CreateDirectory(Path.Combine(parent, $"{prefix}-{Guid.NewGuid():N}"));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return directory;
    }

    private const string AdminHost = "admin.example.test";

    internal static Dictionary<string, string> NativeSettings(string origin, string keyId, string privateKey) => new()
    {
        ["FSUSBLOG_PUBLIC_ORIGIN"] = origin,
        ["FSUSBLOG_ADMIN_ORIGIN"] = "https://" + AdminHost,
        ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
        [Signing + "NativeV2Enabled"] = "true",
        [Signing + "CurrentKeyId"] = keyId,
        [Signing + "NativeV2PrivateKeyFile"] = privateKey,
    };

    internal static void ConfigureKey(Dictionary<string, string> settings, string id, string version, byte[] spki,
        string notBefore = "2020-01-01T00:00:00.000000Z", string notAfter = "2099-01-01T00:00:00.000000Z")
    {
        var prefix = Signing + "Keys__" + id + "__";
        settings[prefix + "Version"] = version;
        settings[prefix + "Algorithm"] = "ECDSA_P256_SHA256";
        settings[prefix + "PublicKey"] = WebEncoders.Base64UrlEncode(spki);
        settings[prefix + "NotBeforeUtc"] = notBefore;
        settings[prefix + "NotAfterUtc"] = notAfter;
    }

    internal static async Task<string> ProofPath(ScratchDatabase db, int article, CancellationToken ct) =>
        $"/integrity/v2/article/{article}/{await db.ScalarAsync<long>(ct,
            "select publication_id from public.article_publication where article_id=$1", article)}/rights.json";

    internal static async Task<Draft> Publish(ServerProcess server, string token, string title, string body,
        CancellationToken ct, Draft? previous = null)
    {
        var draft = await Edit(server, token, WireRoutes.Save, new(previous?.Id ?? 0, previous?.Revision ?? 0, Guid.NewGuid(), title, body), ct);
        return await Edit(server, token, WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""), ct);
    }

    internal static async Task<string> InstallReadOnlyJson(string path, JsonNode content, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(content);
        var pending = path + ".tmp";
        await MediaFixture.WriteReadOnlyFile(pending, bytes, ct);
        File.Move(pending, path, overwrite: true);
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    internal static JsonNode SignedHead(PublicationTransparencyHeadV2 head, byte[] signature) => JsonSerializer.SerializeToNode(new
    {
        headVersion = 2, kind = "native-publication-log-head", algorithm = ArticlePublicationProofPayloadV2.Algorithm, origin = head.Origin,
        sequence = head.Sequence.ToString(CultureInfo.InvariantCulture), entrySha256 = Convert.ToHexStringLower(head.EntrySha256),
        keyId = head.KeyId, keyVersion = head.KeyVersion, keySha256 = Convert.ToHexStringLower(head.KeySha256),
        attestedAtUtc = ArticlePublicationProofPayloadV2.Time(head.AttestedAt), signature = WebEncoders.Base64UrlEncode(signature),
    })!;

    internal static async Task WithPublicServer(ScratchDatabase fixture, string scratch, Uri address,
        IReadOnlyDictionary<string, string> settings, ITestOutputHelper evidence, bool viaCaddy,
        Func<HttpClient, ServerProcess, Task> check, CancellationToken ct)
    {
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings,
            request => Forward(request, address.Authority));
        if (!viaCaddy) { await check(server.Client, server); return; }
        await using var proxy = await NativeCaddyProxy.Start(server.Client.BaseAddress!, scratch, ct, address);
        evidence.WriteLine($"Caddy SHA-256 leaf pin {proxy.Fingerprint}, HTTP/2 on {proxy.Client.BaseAddress}");
        await check(proxy.Client, server);
    }

    internal static byte[] SignP256(ECDsa key, byte[] bytes) =>
        key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    internal static async Task<HttpResponseMessage> ForwardedGet(HttpClient client, string route, string host,
        CancellationToken ct, string transport = "https")
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, route);
        Forward(request, host, transport);
        return await client.SendAsync(request, ct);
    }

    internal static async Task<Draft> Edit(ServerProcess server, string token, string route,
        ArticleCommand command, CancellationToken ct)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command), token, handle: null, secure: true);
        Forward(request, AdminHost);
        using var response = await server.Client.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
    }

    internal static string PrivateKey(DirectoryInfo directory, string name, ECDsa key)
    {
        var path = Path.Combine(directory.FullName, name);
        var bytes = key.ExportPkcs8PrivateKey();
        try { File.WriteAllBytes(path, bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead);
        return path;
    }

    internal static void Forward(HttpRequestMessage request, string host, string transport = "https")
    {
        request.Headers.Host = host;
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", transport);
    }

    internal static ProcessStartInfo Verifier(string subject, params string[] arguments) =>
        FixtureProcess.Command("node", [Tool($"verify-publication-{subject}.mjs"), .. arguments]);

    private static string Tool(string name)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "tools", name);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException($"Native publication verifier {name} was not found.");
    }
}
