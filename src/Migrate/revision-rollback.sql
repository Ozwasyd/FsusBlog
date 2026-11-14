CREATE TABLE public.article_rollback (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    previous_revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    actor_id uuid NOT NULL,
    command_id uuid NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, previous_revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, source_revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (actor_id, command_id) REFERENCES public.article_command (actor_id, command_id),
    CHECK (previous_revision = revision - 1 AND source_revision < previous_revision),
    CHECK (char_length(reason) >= 8 AND char_length(reason) <= 500)
);
