namespace FsusBlog.V2.Server.Content;

internal static class PageShellEndpoints
{
    private static readonly string[] ReaderWorkspaceRoutes = ["/user/identity/mfa", "/user/messagebox"];

    private sealed record ShellSet(
        long Revision,
        byte[] Shell,
        byte[] Archive,
        byte[] EnglishArchive,
        byte[] Search,
        byte[] EnglishSearch,
        byte[] Login,
        byte[] EnglishLogin,
        byte[] Register,
        byte[] EnglishRegister);

    internal static void Map(WebApplication app, Publications publications, bool publicMediaEnabled)
    {
        var webPages = app.Services.GetRequiredService<WebPages>();
        var current = BuildShells(webPages);

        ShellSet CurrentShells()
        {
            var snapshot = Volatile.Read(ref current);
            if (snapshot.Revision == webPages.SiteConfigRevision) return snapshot;
            var rebuilt = BuildShells(webPages);
            Volatile.Write(ref current, rebuilt);
            return rebuilt;
        }

        void MapLocalized(string path, Func<ShellSet, bool, byte[]> body) =>
            app.MapGet(path, (HttpContext ctx) =>
            {
                ServerHttp.NoStore(ctx);
                var shells = CurrentShells();
                return Results.Bytes(body(shells, SiteLocale.Select(ctx) == "en"), ServerHttp.HtmlContentType);
            });

        app.MapGet("/", (HttpContext ctx) =>
        {
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var body = SiteLocale.Select(ctx) == "en" ? snapshot.EnglishHome : snapshot.Home;
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            return PublicResponse.Write(ctx, body, ServerHttp.HtmlContentType);
        });
        app.MapGet("/article/{id:int}", (HttpContext ctx, int id) =>
            PublicReadEndpoints.PublicDetail(ctx, publications, publicMediaEnabled, id, asHtml: true));
        MapLocalized("/archive", static (shells, english) => english ? shells.EnglishArchive : shells.Archive);
        app.MapGet("/user/comments", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
            return Results.Bytes(CurrentShells().Shell, ServerHttp.HtmlContentType);
        });
        MapLocalized("/search", static (shells, english) => english ? shells.EnglishSearch : shells.Search);
        MapLocalized("/login", static (shells, english) => english ? shells.EnglishLogin : shells.Login);
        MapLocalized("/register", static (shells, english) => english ? shells.EnglishRegister : shells.Register);
        app.MapGet("/user", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Redirect("/user/identity/mfa");
        });
        foreach (var route in ReaderWorkspaceRoutes)
        {
            app.MapGet(route, (HttpContext ctx) =>
            {
                ServerHttp.NoStore(ctx);
                return Results.Bytes(CurrentShells().Shell, ServerHttp.HtmlContentType);
            });
        }
        app.MapGet("/health/ready", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.StatusCode(publications.Snapshot is null ? 503 : 204);
        });
        app.MapFallback("/api/{**rest}", ctx => ServerHttp.Error(ctx, 404, "Unknown API route.").ExecuteAsync(ctx));
    }

    private static ShellSet BuildShells(WebPages webPages)
    {
        var revision = webPages.SiteConfigRevision;
        return new(
            revision,
            webPages.Page(),
            webPages.PublicListingPage("page.archive", SiteLocale.Default, "/archive"),
            webPages.PublicListingPage("page.archive", "en", "/archive"),
            webPages.PublicListingPage("page.search", SiteLocale.Default, "/search"),
            webPages.PublicListingPage("page.search", "en", "/search"),
            webPages.SiteLoginPage(),
            webPages.SiteLoginPage("en"),
            webPages.ReaderRegistrationPage(),
            webPages.ReaderRegistrationPage("en"));
    }
}
