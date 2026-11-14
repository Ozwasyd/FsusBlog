CREATE TABLE public.article_schedule_receipt (
    actor_id uuid NOT NULL,
    command_id uuid NOT NULL,
    due_at timestamptz,
    published_revision bigint NOT NULL CHECK (published_revision >= 0),
    PRIMARY KEY (actor_id, command_id),
    FOREIGN KEY (actor_id, command_id) REFERENCES public.article_command (actor_id, command_id)
);

CREATE TABLE public.article_schedule (
    article_id integer PRIMARY KEY,
    revision bigint NOT NULL,
    actor_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    command_id uuid NOT NULL,
    due_at timestamptz NOT NULL,
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (actor_id, command_id) REFERENCES public.article_schedule_receipt (actor_id, command_id)
);

CREATE INDEX article_schedule_due ON public.article_schedule (due_at, article_id);
