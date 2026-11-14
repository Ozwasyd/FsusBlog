// Selected presentation values only, matching the four node kinds in the
// version-one panel contract. This is not a wire DTO or an admission receipt.
type PresentationText = Readonly<{
    Id: string;
    Text: string;
}>;

export type AuthoringWorkspacePanelPresentationNode = PresentationText & (
    | Readonly<{ Kind: 0; Value?: null; CommandId?: null; Tone?: null; }>
    | Readonly<{ Kind: 1; Value: string; CommandId?: null; Tone?: null; }>
    | Readonly<{ Kind: 2; Value?: null; CommandId?: null; Tone: 0 | 1 | 2; }>
    | Readonly<{ Kind: 3; Value?: null; CommandId: string; Tone?: null; }>
);

// A user intent contains no authorization or execution result. The host must
// recheck its full current identity and permission before acting on it.
export type AuthoringWorkspacePanelCommandIntent = Readonly<{
    nodeId: string;
    commandId: string;
}>;
