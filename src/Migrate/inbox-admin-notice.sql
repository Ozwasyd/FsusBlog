CREATE TABLE public.inbox_admin_notice (
    source_event_id bigint PRIMARY KEY CHECK (source_event_id > 0),
    account_id uuid NOT NULL,
    conversation_id bigint NOT NULL UNIQUE,
    message_id bigint NOT NULL,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_reference bytea NOT NULL CHECK (octet_length(session_reference) = 32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    sent_at timestamptz NOT NULL,
    FOREIGN KEY (account_id, conversation_id) REFERENCES public.inbox_conversation (account_id, id),
    FOREIGN KEY (conversation_id, message_id) REFERENCES public.inbox_message (conversation_id, id)
);
