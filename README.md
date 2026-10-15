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

- FastAPI + SQLAlchemy models for reading documents, progress, highlights, Markdown notes, flashcards, review logs and sync events.
- Progressive-reading workspace: create a reading queue entry with an optional source URL and pasted Markdown/text, update the article body, track unread/reading/completed status and percentage, and save/delete quoted highlights with personal annotations.
- Markdown note create/read/update/delete API, title/body search, note types and a browser editor.
- Wiki-links with aliases and heading anchors, backlink lookup, a clickable knowledge graph and orphan-note detection.
- Create FSRS flashcards directly from a note; cards retain the source note relationship. Reading highlights can generate stable-ID literature notes, linked permanent notes, and flashcards attached to the permanent note; repeated conversions reuse the same note IDs and skip an existing linked flashcard.
- Offline note create/update operations are stored in IndexedDB and retried automatically after reconnect.
- Stable client-generated note IDs make offline creation retry-safe; operation IDs make note-update retries idempotent.
- Optimistic timestamp checks detect edits made on another device; conflicts preserve the local copy until the user resolves them.
- IndexedDB cache for notes and flashcards; cached notes remain readable offline.
- FSRS scheduling via the `fsrs` package (`py-fsrs`).
- Flashcard create/list/due-list/review endpoints, review history and cursor-based sync pull.
- PWA shell, service worker, reveal-answer-before-rating review flow and offline review outbox.
- Idempotent review operation IDs and optimistic card version checks.

## Important limitations

This is an initial starter, not production-ready multi-user software. Offline note creation, editing and deletion are queued locally, but cross-device automatic merge is not implemented; conflicts require a manual decision. Offline reviews are queued locally, but the browser does not calculate a new FSRS schedule until the server accepts the review. The sync push/batch endpoint, automated web extraction, and Markdown/PDF file import/export are not implemented. Previously opened reading documents are cached; article body edits, reading progress and new highlights can be queued offline and retried after reconnect. Stable highlight IDs make highlight creation retry-safe. Offline highlight deletion and literature/permanent-note/flashcard conversion remain online-only. Before public deployment, add authentication and per-user row isolation, Alembic migrations, PostgreSQL configuration, HTTPS, request limits, monitoring, backup/restore and a complete multi-device conflict policy. SQLite is for local development only.

Never commit private PDFs, secrets or personal reading data to a public repository.


Conflict handling: when an offline reading edit conflicts with a newer server version, the sync queue can compare the local and server snapshots and explicitly keep either the local version or the server version. Choosing the local version requires confirmation before it is retried against the latest server timestamp.
