# API v0

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |

## Markdown notes

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/notes` | Create a Markdown note |
| GET | `/api/notes?q=term&note_type=permanent&limit=100` | Search note title/body and filter by type |
| GET | `/api/notes/{id}` | Read one note |
| PUT | `/api/notes/{id}` | Replace note fields |

Supported note types: `fleeting`, `literature`, `permanent`, `index`. Markdown is stored as text; rendering and backlink extraction are not implemented yet.

Example:

```json
{
  "title": "One idea per note",
  "body_markdown": "## Principle\n\nA permanent note should express one idea.",
  "note_type": "permanent"
}
```

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
