# Public SEO Checklist

- [x] First public visits show the server AOT shell before deferred Vue SPA takeover.
- [x] About is in the public-page scope.
- [x] About first visits use the server-first public AOT path; SPA only takes over afterward.
- [x] Home / ArticleDetail / Filter(category/tag) / About / Archive first visits use the unified backend AOT path and cached-shell injection.
- [x] `FilterView` keeps one renderer; `search` is excluded from public first-visit AOT and uses the normal SPA entry.
- [x] `Archive` is on the public AOT main path, not an SPA fallback page.
- [x] Admin article publish/edit/delete invalidates only AOT; the next public visit returns SPA and starts asynchronous server backfill.
- [x] ArticleDetail adds comment interaction on demand after SPA takeover.
- [x] The AOT comment placeholder and SPA comment-stream insertion strategy stay aligned.
