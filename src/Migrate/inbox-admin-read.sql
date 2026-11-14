CREATE TABLE public.inbox_admin_read (
    conversation_id bigint PRIMARY KEY,
    read_through bigint NOT NULL,
    read_at timestamptz NOT NULL,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_reference bytea NOT NULL CHECK (octet_length(session_reference) = 32),
    FOREIGN KEY (conversation_id, read_through) REFERENCES public.inbox_message (conversation_id, id)
);

CREATE INDEX inbox_admin_unread_messages ON public.inbox_message (conversation_id, id)
    WHERE sender = 0 AND NOT is_internal;
