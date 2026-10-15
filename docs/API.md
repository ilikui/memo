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
| GET | `/api/notes/{id}/links` | Parse `[[Title]]` references and resolve target notes by title |
| GET | `/api/notes/{id}/backlinks` | Find notes that reference the target note title |

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

The push/batch sync endpoint, authentication, per-user isolation, note backlinks, document/reading queue, Markdown/PDF import/export and production migrations are still pending.
