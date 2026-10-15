# VibeReading

VibeReading is a progressive-reading and personal knowledge-base PWA with Markdown/Luhmann notes and FSRS spaced-repetition flashcards.

## Run locally (Python 3.11+)

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS/Linux
# source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

Open the app at http://127.0.0.1:8000/ and API docs at http://127.0.0.1:8000/docs.

## Tests

```bash
pytest -q
```

GitHub Actions runs the Python test suite and JavaScript syntax checks on pushes and pull requests.

## Current MVP

- FastAPI + SQLAlchemy data model for documents, Markdown notes, flashcards, review logs and sync events.
- FSRS scheduling via the `fsrs` package (`py-fsrs`).
- Flashcard create/list/due-list/review endpoints, review history and cursor-based sync pull.
- PWA shell, service worker, IndexedDB card cache and offline review outbox.
- Reveal-answer-before-rating review flow.
- Idempotent review operation IDs and optimistic card version checks.
- Offline review actions remain queued and retry on reconnect; version conflicts are surfaced and users can explicitly discard a conflicted local review.

## Important limitations

This is an initial starter, not production-ready multi-user software. Offline reviews are queued locally, but the browser does not calculate a new FSRS schedule until the server accepts the review; a conflicted operation must be resolved manually. Offline card creation/editing and the sync push endpoint are not implemented. Markdown note editing, document import and incremental-reading queues are planned but not yet wired into the UI. Before public deployment, add authentication and per-user row isolation, Alembic migrations, PostgreSQL configuration, HTTPS, request limits, monitoring, backup/restore and a complete multi-device conflict policy. SQLite is for local development only.

Never commit private PDFs, secrets or personal reading data to a public repository.
