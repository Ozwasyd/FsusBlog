ALTER TABLE public.article_publication_history ADD CONSTRAINT publication_history_native_binding
    UNIQUE (publication_id, article_id, revision, publication_no, happened_at, kind);
ALTER TABLE public.article_publication_rights ADD CONSTRAINT publication_rights_native_binding
    UNIQUE (id, publication_id, article_id, revision);
ALTER TABLE public.blog_outbox ADD CONSTRAINT outbox_native_publication_binding
    UNIQUE (id, article_id, revision, kind);

CREATE TABLE public.article_publication_canonical (
    publication_id bigint PRIMARY KEY,
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    publication_no integer NOT NULL,
    published_at timestamptz NOT NULL,
    transition text NOT NULL CHECK (transition IN ('publish','replace')),
    rights_snapshot_id bigint NOT NULL UNIQUE,
    outbox_id bigint NOT NULL UNIQUE,
    outbox_kind text NOT NULL CHECK (outbox_kind='publish'),
    canonical_version integer NOT NULL CHECK (canonical_version=2),
    content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
    policy_sha256 bytea NOT NULL CHECK (octet_length(policy_sha256)=32),
    FOREIGN KEY (publication_id,article_id,revision,publication_no,published_at,transition)
        REFERENCES public.article_publication_history(publication_id,article_id,revision,publication_no,happened_at,kind),
    FOREIGN KEY (rights_snapshot_id,publication_id,article_id,revision)
        REFERENCES public.article_publication_rights(id,publication_id,article_id,revision),
    CONSTRAINT canonical_exact_outbox FOREIGN KEY (outbox_id,article_id,revision,outbox_kind)
        REFERENCES public.blog_outbox(id,article_id,revision,kind)
);
