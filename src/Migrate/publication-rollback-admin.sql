CREATE TABLE public.article_revision_responsibility (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id > 0),
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    responsible_party text NOT NULL CHECK (octet_length(responsible_party) BETWEEN 1 AND 256),
    basis text NOT NULL CHECK (octet_length(basis) BETWEEN 1 AND 4000),
    reference text NOT NULL CHECK (octet_length(reference) BETWEEN 1 AND 1000),
    recorded_by text NOT NULL CHECK (octet_length(recorded_by) BETWEEN 1 AND 255),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    source_snapshot_id bigint,
    UNIQUE (article_id, revision),
    UNIQUE (article_id, id),
    UNIQUE (article_id, revision, id),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, source_snapshot_id) REFERENCES public.article_revision_responsibility (article_id, id),
    CHECK (source_snapshot_id IS DISTINCT FROM id)
);

CREATE TABLE public.article_publication_responsibility (
    publication_id bigint PRIMARY KEY CHECK (publication_id > 0),
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    UNIQUE (article_id, revision),
    FOREIGN KEY (article_id, revision, snapshot_id) REFERENCES public.article_revision_responsibility (article_id, revision, id)
);

CREATE TABLE public.admin_article_rollback (
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    article_id integer NOT NULL,
    previous_revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    revision bigint NOT NULL,
    source_publication_id bigint NOT NULL CHECK (source_publication_id > 0),
    previous_publication_id bigint NOT NULL CHECK (previous_publication_id > 0),
    publication_id bigint NOT NULL UNIQUE CHECK (publication_id > 0),
    publication_no integer NOT NULL CHECK (publication_no > 0),
    published_at timestamptz NOT NULL,
    rights_snapshot_id bigint NOT NULL REFERENCES public.article_publication_rights (id),
    responsibility_snapshot_id bigint NOT NULL REFERENCES public.article_revision_responsibility (id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500),
    PRIMARY KEY (principal_id, command_id),
    UNIQUE (article_id, revision),
    FOREIGN KEY (article_id, previous_revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, source_revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    CHECK (previous_revision = revision - 1 AND source_revision < previous_revision)
);

CREATE TABLE public.admin_article_rollback_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 3),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);

ALTER TABLE public.article_publication_history
    ADD COLUMN admin_actor_id uuid,
    ADD COLUMN admin_command_id uuid,
    ADD CONSTRAINT article_publication_history_admin_command_fk
        FOREIGN KEY (admin_actor_id, admin_command_id) REFERENCES public.admin_article_rollback (principal_id, command_id),
    ADD CONSTRAINT article_publication_history_admin_command_unique UNIQUE (admin_actor_id, admin_command_id),
    ADD CONSTRAINT article_publication_history_admin_command_pair CHECK ((admin_actor_id IS NULL) = (admin_command_id IS NULL)),
    ADD CONSTRAINT article_publication_history_distinct_authority CHECK (actor_id IS NULL OR admin_actor_id IS NULL);
