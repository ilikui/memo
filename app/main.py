import json
from datetime import datetime, timezone
from fastapi import Depends, FastAPI, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .db import Base, engine, get_db
from .models import Flashcard, ReviewLog, SyncEvent
from .schemas import FlashcardCreate, FlashcardOut, ReviewRequest, ReviewOut, SyncPullResult
from .services.fsrs import new_card_state, review_card_state
from .services.sync import append_event

app = FastAPI(title="VibeReading API", version="0.1.0")
Base.metadata.create_all(bind=engine)  # Development only. Use Alembic migrations in production.

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "vibereading"}

@app.post("/api/flashcards", response_model=FlashcardOut, status_code=201)
def create_flashcard(body: FlashcardCreate, db: Session = Depends(get_db)):
    card_json, due_at = new_card_state()
    card = Flashcard(front=body.front, back=body.back, source_note_id=body.source_note_id,
                     fsrs_card_json=card_json, due_at=due_at)
    db.add(card)
    db.flush()
    append_event(db, f"create-card:{card.id}", "flashcard", card.id, "create", {
        "id": card.id, "front": card.front, "back": card.back,
        "source_note_id": card.source_note_id, "due_at": card.due_at.isoformat(), "version": card.version
    })
    db.commit()
    db.refresh(card)
    return card

@app.get("/api/flashcards", response_model=list[FlashcardOut])
def list_flashcards(due_only: bool = False, limit: int = Query(100, ge=1, le=500),
                    db: Session = Depends(get_db)):
    stmt = select(Flashcard).order_by(Flashcard.due_at.asc()).limit(limit)
    if due_only:
        stmt = stmt.where(Flashcard.due_at <= datetime.now(timezone.utc))
    return list(db.scalars(stmt).all())

@app.post("/api/flashcards/{card_id}/review", response_model=ReviewOut)
def review_flashcard(card_id: str, body: ReviewRequest, db: Session = Depends(get_db)):
    prior = db.scalar(select(ReviewLog).where(ReviewLog.operation_id == body.operation_id))
    if prior:
        card = db.get(Flashcard, prior.flashcard_id)
        return ReviewOut(flashcard_id=prior.flashcard_id, operation_id=prior.operation_id,
                         rating=prior.rating, reviewed_at=prior.reviewed_at, due_at=prior.due_after,
                         version=card.version if card else 0, duplicate=True)
    card = db.get(Flashcard, card_id)
    if not card:
        raise HTTPException(status_code=404, detail="Flashcard not found")
    if body.expected_version is not None and body.expected_version != card.version:
        raise HTTPException(status_code=409, detail={
            "code": "CARD_VERSION_CONFLICT",
            "message": "Card changed on another device; pull latest state and resolve conflict.",
            "server_version": card.version
        })
    try:
        state_json, log_json, reviewed_at, due_at = review_card_state(
            card.fsrs_card_json, body.rating, body.reviewed_at, body.review_duration_ms)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    card.fsrs_card_json = state_json
    card.due_at = due_at
    card.version += 1
    db.add(ReviewLog(flashcard_id=card.id, operation_id=body.operation_id, rating=body.rating,
                     reviewed_at=reviewed_at, due_after=due_at, review_log_json=log_json))
    append_event(db, body.operation_id, "flashcard", card.id, "review", {
        "operation_id": body.operation_id, "rating": body.rating,
        "reviewed_at": reviewed_at.isoformat(), "due_at": due_at.isoformat(), "version": card.version
    })
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        prior = db.scalar(select(ReviewLog).where(ReviewLog.operation_id == body.operation_id))
        if prior:
            latest = db.get(Flashcard, prior.flashcard_id)
            return ReviewOut(flashcard_id=prior.flashcard_id, operation_id=prior.operation_id,
                rating=prior.rating, reviewed_at=prior.reviewed_at, due_at=prior.due_after,
                version=latest.version if latest else 0, duplicate=True)
        raise
    return ReviewOut(flashcard_id=card.id, operation_id=body.operation_id, rating=body.rating,
                     reviewed_at=reviewed_at, due_at=due_at, version=card.version)

@app.get("/api/sync/pull", response_model=SyncPullResult)
def sync_pull(cursor: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=500),
              db: Session = Depends(get_db)):
    events = list(db.scalars(select(SyncEvent).where(SyncEvent.seq > cursor)
                             .order_by(SyncEvent.seq.asc()).limit(limit)).all())
    next_cursor = events[-1].seq if events else cursor
    return SyncPullResult(cursor=next_cursor, events=[
        {"seq": e.seq, "event_id": e.event_id, "entity_type": e.entity_type, "entity_id": e.entity_id,
         "operation": e.operation, "payload": json.loads(e.payload_json), "created_at": e.created_at.isoformat()}
        for e in events])

@app.get("/api/reviews/logs")
def review_logs(card_id: str | None = None, limit: int = Query(100, ge=1, le=500),
                db: Session = Depends(get_db)):
    stmt = select(ReviewLog).order_by(ReviewLog.reviewed_at.desc()).limit(limit)
    if card_id:
        stmt = stmt.where(ReviewLog.flashcard_id == card_id)
    return [{"id": r.id, "flashcard_id": r.flashcard_id, "operation_id": r.operation_id,
             "rating": r.rating, "reviewed_at": r.reviewed_at.isoformat(), "due_after": r.due_after.isoformat()}
            for r in db.scalars(stmt).all()]
