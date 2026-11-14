CREATE TABLE public.canvas_history_patch (
    canvas_id uuid NOT NULL,
    edit_revision bigint NOT NULL,
    undone boolean NOT NULL,
    moved_at_revision bigint NOT NULL,
    payload bytea NOT NULL CHECK (octet_length(payload) >= 1 AND octet_length(payload) <= 33554432),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    PRIMARY KEY (canvas_id, edit_revision),
    FOREIGN KEY (canvas_id, edit_revision) REFERENCES public.canvas_document_event(canvas_id, revision),
    FOREIGN KEY (canvas_id, moved_at_revision) REFERENCES public.canvas_document_event(canvas_id, revision)
);

CREATE TABLE public.canvas_history_transition (
    canvas_id uuid NOT NULL,
    revision bigint NOT NULL,
    target_revision bigint,
    discarded_redo bigint[] NOT NULL,
    PRIMARY KEY (canvas_id, revision),
    FOREIGN KEY (canvas_id, revision) REFERENCES public.canvas_document_event(canvas_id, revision),
    FOREIGN KEY (canvas_id, target_revision) REFERENCES public.canvas_document_event(canvas_id, revision)
);

CREATE INDEX canvas_history_undo ON public.canvas_history_patch(canvas_id, undone, edit_revision DESC);
CREATE INDEX canvas_history_redo ON public.canvas_history_patch(canvas_id, undone, moved_at_revision DESC);
