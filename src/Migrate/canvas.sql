CREATE TABLE public.authoring_canvas (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.blog_user(id),
    revision bigint NOT NULL CHECK (revision > 0),
    title text NOT NULL,
    viewport_x integer NOT NULL,
    viewport_y integer NOT NULL,
    viewport_zoom integer NOT NULL CHECK (viewport_zoom >= 100 AND viewport_zoom <= 4000),
    deleted boolean NOT NULL,
    touched_at timestamptz NOT NULL
);

CREATE TABLE public.canvas_node (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas(id),
    id uuid NOT NULL,
    kind integer NOT NULL CHECK (kind >= 0 AND kind <= 4),
    x integer NOT NULL,
    y integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    article_id integer REFERENCES public.article(id),
    anchor text,
    pinned_revision bigint,
    note text,
    member_ids uuid[] NOT NULL,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (article_id, pinned_revision) REFERENCES public.article_revision(article_id, revision)
);

CREATE TABLE public.canvas_edge (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas(id),
    id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    explicit_reference boolean NOT NULL,
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    label text,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (canvas_id, source_node_id) REFERENCES public.canvas_node(canvas_id, id),
    FOREIGN KEY (canvas_id, target_node_id) REFERENCES public.canvas_node(canvas_id, id)
);

CREATE TABLE public.canvas_document_event (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas(id),
    revision bigint NOT NULL CHECK (revision > 0),
    actor_id uuid NOT NULL REFERENCES public.blog_user(id),
    command_id uuid NOT NULL,
    command_kind integer NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    title text NOT NULL,
    viewport_x integer NOT NULL,
    viewport_y integer NOT NULL,
    viewport_zoom integer NOT NULL,
    deleted boolean NOT NULL,
    node_count integer NOT NULL CHECK (node_count >= 0 AND node_count <= 10000),
    edge_count integer NOT NULL CHECK (edge_count >= 0 AND edge_count <= 10000),
    touched_at timestamptz NOT NULL,
    PRIMARY KEY (canvas_id, revision),
    UNIQUE (canvas_id, command_id)
);

CREATE TABLE public.canvas_link_plan (
    id uuid PRIMARY KEY,
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas(id),
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
    FOREIGN KEY (applied_article_id, applied_revision) REFERENCES public.article_revision(article_id, revision)
);

CREATE INDEX canvas_owner ON public.authoring_canvas(owner_id);
CREATE INDEX canvas_edge_document_order ON public.canvas_edge(canvas_id, sort_order, id);
CREATE INDEX canvas_links_owner ON public.canvas_link_plan(canvas_id, edge_id, expires_at);
