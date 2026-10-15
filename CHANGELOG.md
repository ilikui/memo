# Changelog

## 0.3.0 — 2026-10-15

### Added
- Progressive reading queue with article metadata and Markdown/text body editing.
- Reading status, percentage progress, and saved cursor position for resuming.
- Quote highlights with personal annotations and optional source offsets.
- Convert a highlight into a stable-ID permanent note and optionally create a linked FSRS flashcard.
- Duplicate flashcard guard when converting the same highlight again.
- API tests for reading workflows and conflicting retries for client-generated note IDs.

### Changed
- PWA shell cache bumped to refresh the latest reading and knowledge-conversion UI.
- Package version aligned with API version 0.3.0.

### Known limitations
- No authentication or per-user data isolation; do not expose as a public multi-user service.
- SQLite and `create_all` are development defaults; production migrations and PostgreSQL setup are not yet included.
- Reading documents, progress, and highlights are online-only; only selected notes/reviews use the current offline outbox.
- No automated webpage extraction or PDF import/export yet.
- The GitHub Actions test suite must pass on the release commit before a stable release is published.
