# Schema 1.0 migration
- [x] Use migrate_schema.py's schema for generation, saving, and new documents.
- [x] Load schema 1.0 without losing content, IDs, edge attributes, or renderer settings.
- [x] Convert the main bundled sample in public/data and data; verify schema rules and sample loading.

# Generation output repair
- [ ] Checkpoint Claude output before the worker is stopped and verify continuation.
- [ ] Surface stalled jobs and verify schema 1.0 output through the save flow.