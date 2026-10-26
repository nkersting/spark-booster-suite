# Architecture rules
- Keep schema 1.0 conversion in the pure shared knowledge-schema module used by the browser and generation worker, so saved files and job results follow migrate_schema.py consistently.
- Use the existing nested-tree view model inside the UI; adapt schema document metadata, node/content IDs, and edge attributes at load/save boundaries to preserve editing behavior.
- Checkpoint long Claude streams within 90 seconds and atomically claim bounded continuations; hosting workers may stop before a full tree finishes.
- Resolve user generation credentials with the shared generation-keys helper and pass them only through worker requests, never persisted job results or logs, so optional browser keys survive handoffs without exposing them in job polling.