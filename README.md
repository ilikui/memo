# VibeReading

VibeReading is a progressive-reading and personal knowledge-base PWA with Luhmann-style Markdown notes and FSRS spaced-repetition flashcards.

## Current status

Initial repository bootstrap. The implementation is being added in small, testable steps.

## Planned stack

- PWA frontend with IndexedDB offline cache and sync outbox
- FastAPI backend
- SQLAlchemy 2.x
- `py-fsrs` (`fsrs` Python package) as the flashcard scheduler
- PostgreSQL for production; SQLite for local development

## Development safety

Do not deploy publicly until authentication, per-user data isolation, migrations, conflict handling, HTTPS, and backup/restore are implemented.
