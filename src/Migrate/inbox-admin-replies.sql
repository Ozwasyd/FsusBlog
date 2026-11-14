CREATE TABLE public.inbox_admin_reply (
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 64),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    session_reference bytea NOT NULL CHECK (octet_length(session_reference) = 32),
    conversation_id bigint NOT NULL,
    message_id bigint NOT NULL UNIQUE,
    PRIMARY KEY (principal_id, command_id),
    FOREIGN KEY (conversation_id, message_id) REFERENCES public.inbox_message (conversation_id, id)
);
