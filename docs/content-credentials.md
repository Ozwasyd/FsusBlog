# Content Credentials offline prototype

FsusBlog's Content Credentials capability is fixed at `prototype / opt-in / default-off`. It creates a reproducible canonical package for the article, rendered projection, cover, and attachments, then hands it to an explicitly installed C2PA tool to create an external manifest. Ordinary HTML, Markdown, AEDS reads, the notification stream, and login do not depend on that tool or manifest.

## Canonicalization v1

The authoritative version is `fsusblog.article-canonical.v1`:

- Markdown becomes UTF-8, NFC, LF, with one final newline; drafts, comments, reading statistics, and user state are excluded.
- Rendered HTML uses the stable article projection; CSP `nonce`, `data-csp-nonce`, and nodes marked `data-c2pa-volatile` are excluded from the digest.
- Metadata contains only public article/revision coordinates, title, summary, canonical URL, publication time, language, copyright, content-level AI-use disclosure, and the release-receipt summary.
- Each cover and attachment records its URI, MIME, relation, and SHA-256. Dynamic themes, locale shells, comments, statistics, and private drafts are not ingredients.
- The manifest URL must be same-origin with the article, have no query/fragment, and use the immutable path `/credentials/articles/{articleId}/revisions/{revisionId}/manifest.c2pa`.

The generated package contains:

```text
canonical/article.md
canonical/article.html
canonical/metadata.json
manifest-definition.json
html-association.txt
package-manifest.json
assets/*
```

HTML association follows the C2PA 2.4 external-manifest discovery form:

```html
<link rel="c2pa-manifest" type="application/c2pa" href="https://fsus.blog/credentials/articles/1179/revisions/3/manifest.c2pa">
```

A missing manifest, unavailable validator, or failed validation affects only the provenance-verification result; it does not change body readability or automatically classify the article as malicious.

## Local commands

The ordinary offline self-check needs no C2PA tool:

```bash
node tools/content-credentials/c2pa-prototype.mjs check
node --test tests/tools/content-credentials-prototype.test.mjs
```

Build a canonical package:

```bash
node tools/content-credentials/c2pa-prototype.mjs build \
  --fixture tests/fixtures/content-credentials/article.json \
  --out /tmp/fsusblog-c2pa-package
```

Run C2PA interoperability explicitly with `c2patool 0.26.60` as the fixed primary validator:

```bash
C2PATOOL=/opt/c2patool-0.26.60/c2patool \
node tools/content-credentials/c2pa-prototype.mjs interop \
  --out /tmp/fsusblog-c2pa-interop
```

The Linux release asset and SHA-256 are fixed in `config/content-credentials/c2pa-interop-policy.json`. Operators must verify the archive digest offline; the special command never downloads or upgrades the validator.

When the tool is missing, the command returns `status=unavailable` and `productionDefault=false`; it downloads nothing, contacts no online verification service, and does not block ordinary tests. Test certificates may produce prototype evidence only; production signing must use an isolated signer; see [Content Credentials key lifecycle](security/content-credentials-key-lifecycle.md).

The special command also writes `verification-entry.json`. This local verification entry exposes only manifest presence, signature/content-binding result, limited signer information, publication time, article/revision coordinates, declared action, and fixed error codes; it never exposes the full certificate chain, private key, or internal identity. The built-in test certificate is correctly reported as `credential_untrusted`: valid signature and content binding do not promote it to a trusted production credential.

## Tamper and production gate

The ordinary self-check always covers five negative cases: Markdown, metadata, cover, attachment, and manifest URL. Before production-default, `config/content-credentials/c2pa-interop-policy.json` requires all of the following:

- offline positive cases from two different implementation families;
- receipts that remain verifiable after static download, cache recovery, and redeployment;
- evidence that the body is readable without JavaScript;
- key-rotation, revocation, and incident-recovery exercises; and
- privacy review plus budgets for size, signing latency, verification latency, and publication duration.

Passing with only `c2patool`, or multiple wrappers from the same `c2pa-rs` family, does not satisfy “two independent implementations.” If any receipt is missing, the decision remains `blocked`; the repository must not claim standard interoperability or tamper resistance.

## Degradation and rollback

The prototype is not wired into the production request chain, so its current state needs no restart. After future opt-in wiring, runtime rollback must: stop publishing new manifest associations, retain existing immutable manifests for historical verification, and continue serving normal HTML/Markdown/AEDS content. Never “fix” failure by deleting bodies, clearing historical manifests, or relaxing signature verification.
