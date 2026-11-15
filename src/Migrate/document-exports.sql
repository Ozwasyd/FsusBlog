CREATE TABLE public.author_document_export (
    owner_id uuid NOT NULL REFERENCES public.blog_user(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    article_id integer NOT NULL,
    expected_revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    author_generation bigint NOT NULL CHECK (author_generation > 0),
    format smallint NOT NULL CHECK (format BETWEEN 1 AND 4),
    state smallint NOT NULL CHECK (state BETWEEN 1 AND 7),
    failure smallint NOT NULL DEFAULT 0 CHECK (failure BETWEEN 0 AND 4),
    provider smallint NOT NULL DEFAULT 1 CHECK (provider BETWEEN 1 AND 4),
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    expires_at timestamptz NOT NULL,
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    output_digest bytea CHECK (octet_length(output_digest) = 32),
    output bytea CHECK (octet_length(output) BETWEEN 1 AND 4194304),
    attachment_id uuid,
    attachment_ids uuid[],
    CHECK ((provider = 3) = (attachment_id IS NOT NULL)),
    CHECK ((provider = 4) = (attachment_ids IS NOT NULL)),
    CHECK (attachment_ids IS NULL OR (format = 1 AND cardinality(attachment_ids) BETWEEN 2 AND 4
        AND array_ndims(attachment_ids) = 1 AND array_position(attachment_ids, NULL) IS NULL)),
    PRIMARY KEY (owner_id, id),
    FOREIGN KEY (article_id, source_revision)
        REFERENCES public.article_revision(article_id, revision) ON DELETE CASCADE,
    CHECK (source_revision >= 1 AND source_revision <= expected_revision),
    CHECK (expires_at > created_at),
    CHECK (started_at >= created_at),
    CHECK (finished_at >= coalesce(started_at, created_at)),
    CHECK ((state BETWEEN 3 AND 6) = (finished_at IS NOT NULL)),
    CHECK ((state NOT IN (2, 3, 7)) OR started_at IS NOT NULL),
    CHECK ((state IN (4, 6)) = (failure <> 0)),
    CHECK ((state = 3) = (output IS NOT NULL)),
    CHECK ((state = 3) = (output_digest IS NOT NULL))
);
CREATE INDEX author_document_export_pending ON public.author_document_export (state, created_at, owner_id, id);
CREATE INDEX author_document_export_expiry ON public.author_document_export (expires_at);
CREATE INDEX author_document_export_article ON public.author_document_export (owner_id, article_id, created_at, id);
