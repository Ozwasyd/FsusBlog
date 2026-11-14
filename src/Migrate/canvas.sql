CREATE TABLE public.authoring_canvas (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.blog_user(id),
    revision bigint NOT NULL CHECK (revision > 0)
);

CREATE TABLE public.canvas_edge (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas(id),
    id uuid NOT NULL,
    article_id integer NOT NULL REFERENCES public.article(id),
    target_article_id integer NOT NULL REFERENCES public.article(id),
    explicit_reference boolean NOT NULL,
    PRIMARY KEY (canvas_id, id),
    CHECK (article_id <> target_article_id)
);

CREATE TABLE public.canvas_link_plan (
    id uuid PRIMARY KEY,
    canvas_id uuid NOT NULL,
    edge_id uuid NOT NULL,
    canvas_revision bigint NOT NULL CHECK (canvas_revision > 0),
    host_revision bigint NOT NULL CHECK (host_revision > 0),
    target_revision bigint NOT NULL CHECK (target_revision > 0),
    source_offset integer NOT NULL CHECK (source_offset >= 0),
    insert_digest bytea NOT NULL CHECK (octet_length(insert_digest) = 32),
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    session_generation bigint NOT NULL CHECK (session_generation > 0),
    expires_at timestamptz NOT NULL,
    applied_article_id integer,
    applied_revision bigint,
    applied_canvas_revision bigint,
    FOREIGN KEY (canvas_id, edge_id) REFERENCES public.canvas_edge(canvas_id, id),
    FOREIGN KEY (applied_article_id, applied_revision) REFERENCES public.article_revision(article_id, revision)
);

CREATE INDEX canvas_owner ON public.authoring_canvas(owner_id);
CREATE INDEX canvas_links_owner ON public.canvas_link_plan(canvas_id, edge_id, expires_at);
