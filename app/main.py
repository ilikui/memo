import json
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import Document, Flashcard, Note, ReviewLog, SyncEvent
from .schemas import (
    FlashcardCreate,
    FlashcardOut,
    NoteCreate,
    NoteOut,
    NoteUpdate,
    ReviewOut,
    ReviewRequest,
    SyncPullResult,
)
from .services.fsrs import new_card_state, review_card_state
from .services.sync import append_event

app = FastAPI(title="VibeReading API", version="0.2.0")
Base.metadata.create_all(bind=engine)  # Development only. Use Alembic migrations in production.


@app.get("/")
def home():
    return RedirectResponse(url="/web/index.html")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "vibereading"}


@app.post("/api/notes", response_model=NoteOut, status_code=201)
def create_note(body: NoteCreate, db: Session = Depends(get_db)):
    if body.document_id and not db.get(Document, body.document_id):
        raise HTTPException(status_code=404, detail="Source document not found")
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title must not be blank")
    if body.id:
        existing = db.get(Note, body.id)
        if existing:
            same_payload = (
                existing.title == title
                and existing.body_markdown == body.body_markdown
                and existing.note_type == body.note_type
                and existing.document_id == body.document_id
            )
            if same_payload:
                return existing
            raise HTTPException(status_code=409, detail={
                "code": "NOTE_ID_CONFLICT",
                "message": "A different note already uses this ID.",
            })
    note = Note(
        id=body.id,
        title=title,
        body_markdown=body.body_markdown,
        note_type=body.note_type,
        document_id=body.document_id,
    )
    db.add(note)
    db.flush()
    append_event(db, f"note-create:{note.id}", "note", note.id, "create", {
        "id": note.id,
        "title": note.title,
        "body_markdown": note.body_markdown,
        "note_type": note.note_type,
        "document_id": note.document_id,
        "updated_at": note.updated_at.isoformat(),
    })
    db.commit()
    db.refresh(note)
    return note


@app.get("/api/notes", response_model=list[NoteOut])
def list_notes(
    q: str | None = None,
    note_type: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    stmt = select(Note).order_by(Note.updated_at.desc()).limit(limit)
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(Note.title.ilike(pattern), Note.body_markdown.ilike(pattern)))
    if note_type:
        stmt = stmt.where(Note.note_type == note_type)
    return list(db.scalars(stmt).all())


@app.get("/api/notes/{note_id}", response_model=NoteOut)
def get_note(note_id: str, db: Session = Depends(get_db)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@app.put("/api/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: str, body: NoteUpdate, db: Session = Depends(get_db)):
    if body.operation_id:
        prior_event = db.scalar(select(SyncEvent).where(SyncEvent.event_id == body.operation_id))
        if prior_event and prior_event.entity_type == "note" and prior_event.entity_id == note_id:
            existing_note = db.get(Note, note_id)
            if existing_note:
                return existing_note
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if body.document_id and not db.get(Document, body.document_id):
        raise HTTPException(status_code=404, detail="Source document not found")
    if body.expected_updated_at is not None:
        actual = note.updated_at
        expected = body.expected_updated_at
        if actual.tzinfo is None:
            actual = actual.replace(tzinfo=timezone.utc)
        if expected.tzinfo is None:
            expected = expected.replace(tzinfo=timezone.utc)
        if abs(actual.timestamp() - expected.timestamp()) > 0.001:
            raise HTTPException(status_code=409, detail={
                "code": "NOTE_VERSION_CONFLICT",
                "message": "This note changed on the server. Keep the local copy and resolve the conflict.",
                "server_updated_at": note.updated_at.isoformat(),
            })
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title must not be blank")
    note.title = title
    note.body_markdown = body.body_markdown
    note.note_type = body.note_type
    note.document_id = body.document_id
    note.updated_at = datetime.now(timezone.utc)
    append_event(db, body.operation_id or f"note-update:{note.id}:{uuid4()}", "note", note.id, "update", {
        "id": note.id,
        "title": note.title,
        "body_markdown": note.body_markdown,
        "note_type": note.note_type,
        "document_id": note.document_id,
        "updated_at": note.updated_at.isoformat(),
    })
    db.commit()
    db.refresh(note)
    return note


def _extract_wikilinks(markdown: str) -> list[str]:
    """Return unique [[target]] links in first-seen order; ignore empty targets."""
    targets = []
    seen = set()
    for match in re.finditer(r"(?<!\\!)\\[\\[([^\\]#|]+)(?:#[^\\]|]+)?(?:\\|[^\\]]*)?\\]\\]", markdown):
        target = match.group(1).strip()
        if target and target.casefold() not in seen:
            seen.add(target.casefold())
            targets.append(target)
    return targets


@app.get("/api/notes/{note_id}/links")
def get_note_links(note_id: str, db: Session = Depends(get_db)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    titles = _extract_wikilinks(note.body_markdown)
    all_notes = list(db.scalars(select(Note).order_by(Note.title.asc())).all())
    by_title = {item.title.casefold(): item for item in all_notes}
    links = []
    for title in titles:
        target = by_title.get(title.casefold())
        links.append({
            "title": title,
            "resolved": target is not None,
            "note_id": target.id if target else None,
            "note_title": target.title if target else None,
        })
    return {"note_id": note.id, "links": links}


@app.get("/api/notes/{note_id}/backlinks")
def get_note_backlinks(note_id: str, db: Session = Depends(get_db)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    all_notes = list(db.scalars(select(Note).order_by(Note.updated_at.desc())).all())
    backlinks = []
    for source in all_notes:
        if source.id == note.id:
            continue
        targets = _extract_wikilinks(source.body_markdown)
        if any(target.casefold() == note.title.casefold() for target in targets):
            backlinks.append({
                "id": source.id,
                "title": source.title,
                "note_type": source.note_type,
                "updated_at": source.updated_at.isoformat(),
            })
    return {"note_id": note.id, "backlinks": backlinks}


@app.post("/api/flashcards", response_model=FlashcardOut, status_code=201)
def create_flashcard(body: FlashcardCreate, db: Session = Depends(get_db)):
    if body.source_note_id and not db.get(Note, body.source_note_id):
        raise HTTPException(status_code=404, detail="Source note not found")
    card_json, due_at = new_card_state()
    card = Flashcard(
        front=body.front,
        back=body.back,
        source_note_id=body.source_note_id,
        fsrs_card_json=card_json,
        due_at=due_at,
    )
    db.add(card)
    db.flush()
    append_event(db, f"create-card:{card.id}", "flashcard", card.id, "create", {
        "id": card.id,
        "front": card.front,
        "back": card.back,
        "source_note_id": card.source_note_id,
        "due_at": card.due_at.isoformat(),
        "version": card.version,
    })
    db.commit()
    db.refresh(card)
    return card


@app.get("/api/flashcards", response_model=list[FlashcardOut])
def list_flashcards(
    due_only: bool = False,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    stmt = select(Flashcard).order_by(Flashcard.due_at.asc()).limit(limit)
    if due_only:
        stmt = stmt.where(Flashcard.due_at <= datetime.now(timezone.utc))
    return list(db.scalars(stmt).all())


@app.post("/api/flashcards/{card_id}/review", response_model=ReviewOut)
def review_flashcard(card_id: str, body: ReviewRequest, db: Session = Depends(get_db)):
    prior = db.scalar(select(ReviewLog).where(ReviewLog.operation_id == body.operation_id))
    if prior:
        card = db.get(Flashcard, prior.flashcard_id)
        return ReviewOut(
            flashcard_id=prior.flashcard_id,
            operation_id=prior.operation_id,
            rating=prior.rating,
            reviewed_at=prior.reviewed_at,
            due_at=prior.due_after,
            version=card.version if card else 0,
            duplicate=True,
        )
    card = db.get(Flashcard, card_id)
    if not card:
        raise HTTPException(status_code=404, detail="Flashcard not found")
    if body.expected_version is not None and body.expected_version != card.version:
        raise HTTPException(status_code=409, detail={
            "code": "CARD_VERSION_CONFLICT",
            "message": "Card changed on another device; pull latest state and resolve conflict.",
            "server_version": card.version,
        })
    try:
        state_json, log_json, reviewed_at, due_at = review_card_state(
            card.fsrs_card_json, body.rating, body.reviewed_at, body.review_duration_ms
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    card.fsrs_card_json = state_json
    card.due_at = due_at
    card.version += 1
    db.add(ReviewLog(
        flashcard_id=card.id,
        operation_id=body.operation_id,
        rating=body.rating,
        reviewed_at=reviewed_at,
        due_after=due_at,
        review_log_json=log_json,
    ))
    append_event(db, body.operation_id, "flashcard", card.id, "review", {
        "operation_id": body.operation_id,
        "rating": body.rating,
        "reviewed_at": reviewed_at.isoformat(),
        "due_at": due_at.isoformat(),
        "version": card.version,
    })
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        prior = db.scalar(select(ReviewLog).where(ReviewLog.operation_id == body.operation_id))
        if prior:
            latest = db.get(Flashcard, prior.flashcard_id)
            return ReviewOut(
                flashcard_id=prior.flashcard_id,
                operation_id=prior.operation_id,
                rating=prior.rating,
                reviewed_at=prior.reviewed_at,
                due_at=prior.due_after,
                version=latest.version if latest else 0,
                duplicate=True,
            )
        raise
    return ReviewOut(
        flashcard_id=card.id,
        operation_id=body.operation_id,
        rating=body.rating,
        reviewed_at=reviewed_at,
        due_at=due_at,
        version=card.version,
    )


@app.get("/api/sync/pull", response_model=SyncPullResult)
def sync_pull(
    cursor: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
):
    events = list(db.scalars(
        select(SyncEvent).where(SyncEvent.seq > cursor)
        .order_by(SyncEvent.seq.asc()).limit(limit)
    ).all())
    next_cursor = events[-1].seq if events else cursor
    return SyncPullResult(cursor=next_cursor, events=[
        {
            "seq": event.seq,
            "event_id": event.event_id,
            "entity_type": event.entity_type,
            "entity_id": event.entity_id,
            "operation": event.operation,
            "payload": json.loads(event.payload_json),
            "created_at": event.created_at.isoformat(),
        }
        for event in events
    ])


@app.get("/api/reviews/logs")
def review_logs(
    card_id: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    stmt = select(ReviewLog).order_by(ReviewLog.reviewed_at.desc()).limit(limit)
    if card_id:
        stmt = stmt.where(ReviewLog.flashcard_id == card_id)
    return [
        {
            "id": log.id,
            "flashcard_id": log.flashcard_id,
            "operation_id": log.operation_id,
            "rating": log.rating,
            "reviewed_at": log.reviewed_at.isoformat(),
            "due_after": log.due_after.isoformat(),
        }
        for log in db.scalars(stmt).all()
    ]


# Serve the PWA shell from the same origin so API requests need no CORS setup.
app.mount("/web", StaticFiles(directory=str(Path(__file__).resolve().parent.parent / "web")), name="web")
