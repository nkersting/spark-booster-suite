# Schema 1.0 migration
- [x] Add a Pexels key beside Anthropic in both settings views; browser masking, persistence and generation forwarding verified, handoff tests pass and function deployed.
- [x] Use migrate_schema.py's schema for generation, saving, and new documents.
- [x] Load schema 1.0 without losing content, IDs, edge attributes, or renderer settings.
- [x] Convert the main bundled sample in public/data and data; verify schema rules and sample loading.

# Generation output repair
- [x] Checkpoint Claude output before the worker is stopped; stream checkpoint/continuation tests pass and function deployed.
- [x] Surface stalled jobs and verify schema 1.0 output through the save flow (replayed actual 39-node Claude result).
- [ ] Verify a fresh live Claude job across worker handoff; blocked because the backend fallback Anthropic key returns 401 and the user's browser key is unavailable here.