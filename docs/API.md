# API v0

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |

## Markdown notes

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/notes` | Create a Markdown note; accepts optional client-generated `id` for offline retries |
| GET | `/api/notes?q=term&note_type=permanent&limit=100` | Search note title/body and filter by type |
| GET | `/api/notes/{id}` | Read one note |
| PUT | `/api/notes/{id}` | Update a note with optional `operation_id` and `expected_updated_at` |
| DELETE | `/api/notes/{id}?operation_id=...&expected_updated_at=...` | Delete a note with retry safety and stale-version detection |
| GET | `/api/notes/{id}/links` | Parse `[[Title]]` references and resolve target notes by title |
| GET | `/api/notes/{id}/backlinks` | Find notes that reference the target note title |
| GET | `/api/notes/graph` | Return note nodes, resolved link edges and orphan-note IDs |

Supported note types: `fleeting`, `literature`, `permanent`, `index`. Markdown is stored as text. Wiki-links support `[[Title]]`, aliases such as `[[Title|label]]`, and heading anchors such as `[[Title#section]]`. Link resolution currently uses exact case-insensitive note-title matching; backlinks are computed from note bodies at request time.

Example create payload:

```json
{
  "id": "optional-client-generated-uuid",
  "title": "One idea per note",
  "body_markdown": "## Principle\n\nA permanent note should express one idea.",
  "note_type": "permanent"
}
```

For offline synchronization, the client generates a stable note ID before saving locally. Repeating the same create request returns the existing note; reusing the ID with different content returns HTTP 409. Updates may send `expected_updated_at` to detect stale copies and a unique `operation_id` to make network retries idempotent. A stale update returns HTTP 409 with code `NOTE_VERSION_CONFLICT`.

## Progressive reading

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/documents` | Create a reading item with title, optional http/https source URL and pasted Markdown/text |
| GET | `/api/documents?status=reading&limit=100` | List reading items with progress and highlight count |
| GET | `/api/documents/{id}` | Read article body, progress and highlights |
| PUT | `/api/documents/{id}` | Update title, source URL or Markdown body |
| PUT | `/api/documents/{id}/progress` | Update status (`unread`, `reading`, `completed`), percentage (0–100) and last position |
| GET | `/api/documents/{id}/highlights` | List saved quotations and annotations |
| POST | `/api/documents/{id}/highlights` | Save a quote, optional note and optional character offsets |
| DELETE | `/api/documents/{id}/highlights/{highlight_id}` | Delete a saved highlight |

The PWA reading workspace supports manually pasting article text/Markdown, saving the source URL as metadata, resuming from the reading list, updating progress and recording highlights. It deliberately does not fetch arbitrary URLs yet; this avoids unsafe server-side URL fetching and keeps import behavior explicit. Reading data is currently online-only and is not part of the IndexedDB sync outbox.

## Flashcards and reviews

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/flashcards` | Create flashcard; optional `source_note_id` links to a note |
| GET | `/api/flashcards?due_only=true&limit=100` | List cards / due queue |
| POST | `/api/flashcards/{id}/review` | FSRS review, idempotent by `operation_id` |
| GET | `/api/reviews/logs?card_id=...` | Review history |

Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy. `expected_version` enables optimistic conflict detection. Review durations are supplied as `review_duration_ms`.

## Synchronization

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sync/pull?cursor=0&limit=200` | Pull append-only event stream |

The push/batch sync endpoint, authentication, per-user isolation, document/reading queue, Markdown/PDF import/export and production migrations are still pending.
