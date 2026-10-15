# API v0

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/flashcards` | Create flashcard |
| GET | `/api/flashcards?due_only=true&limit=100` | List cards / due queue |
| POST | `/api/flashcards/{id}/review` | FSRS review, idempotent by operation_id |
| GET | `/api/reviews/logs?card_id=...` | Review history |
| GET | `/api/sync/pull?cursor=0&limit=200` | Pull event stream |

Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy. Production endpoints still needed: auth, batch sync push, documents, reading queue, notes/backlinks, Markdown/PDF import and export.
