# Canvas operation frame admission

The existing document policy forbids a group frame from containing another
frame. `AuthoringCanvasOperationEngine` validates the entire source snapshot
before planning, the complete graph after every closed Apply command, and the
complete graph after applying sealed Undo or Redo facts. Every frame member must
exist in that graph and must be a non-frame node. This also rejects cycles and
nested empty frames without introducing a depth allowance or a second engine.

The existing shape contract still owns duplicate and self-member rejection.
Empty frames and ordered, document-local non-frame members remain supported.
The engine uses the direct store's `canvas_frame_nesting_forbidden` refusal;
missing members retain the operation planner's existing refusal.

`AuthoringCanvasOperationVerifier` independently checks the same graph invariant
in the initial snapshot, each replayed Apply command, each journal result and
the replayed current state. It records missing-member and nested-frame reasons
independently, once per containing frame and verification scope. It does not
call the engine or grant transaction, permission or receipt authority.

The original command vocabulary, CAS, sealed history, persistence and frontend
intention owners remain authoritative. This graph invariant does not change
Package, session, API, schema or generated contracts. Source compilation and
static checks do not establish replay, database, runtime or product acceptance;
those require independent verification of the actual candidate.
