from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import Document, ReadingHighlight, ReadingProgress

router = APIRouter(prefix="/api", tags=["progressive-reading"])


class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    source_url: str | None = Field(default=None, max_length=2048)
    content_markdown: str = Field(default="", max_length=1_000_000)
    source_type: str = Field(default="article", max_length=30)


class DocumentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    source_url: str | None = Field(default=None, max_length=2048)
    content_markdown: str | None = Field(default=None, max_length=1_000_000)


class ProgressUpdate(BaseModel):
    status: Literal["unread", "reading", "completed"] | None = None
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    last_position: int | None = Field(default=None, ge=0)


class HighlightCreate(BaseModel):
    quote_text: str = Field(min_length=1, max_length=20000)
    note: str = Field(default="", max_length=20000)
    position_start: int | None = Field(default=None, ge=0)
    position_end: int | None = Field(default=None, ge=0)


def _document_out(document: Document) -> dict:
    return {
        "id": document.id,
        "title": document.title,
        "source_type": document.source_type,
        "source_url": document.source_url,
        "content_markdown": document.content_markdown,
        "created_at": document.created_at,
        "updated_at": document.updated_at,
    }


def _progress_out(progress: ReadingProgress) -> dict:
    return {
        "document_id": progress.document_id,
        "status": progress.status,
        "progress_percent": progress.progress_percent,
        "last_position": progress.last_position,
        "updated_at": progress.updated_at,
    }


def _get_document(db: Session, document_id: str) -> Document:
    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Reading document not found")
    return document


def _get_or_create_progress(db: Session, document_id: str) -> ReadingProgress:
    progress = db.scalar(select(ReadingProgress).where(ReadingProgress.document_id == document_id))
    if progress is None:
        progress = ReadingProgress(document_id=document_id)
        db.add(progress)
        db.flush()
    return progress


@router.get("/documents")
def list_documents(
    status: Literal["unread", "reading", "completed"] | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    documents = list(db.scalars(select(Document).order_by(Document.updated_at.desc()).limit(limit)).all())
    result = []
    for document in documents:
        progress = db.scalar(select(ReadingProgress).where(ReadingProgress.document_id == document.id))
        state = progress.status if progress else "unread"
        if status and state != status:
            continue
        item = _document_out(document)
        item["progress"] = _progress_out(progress) if progress else {
            "document_id": document.id, "status": "unread",
            "progress_percent": 0, "last_position": 0, "updated_at": document.updated_at,
        }
        item["highlight_count"] = db.scalar(
            select(ReadingHighlight.id).where(ReadingHighlight.document_id == document.id)
        ) is not None
        result.append(item)
    return result


@router.post("/documents", status_code=201)
def create_document(body: DocumentCreate, db: Session = Depends(get_db)):
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title must not be blank")
    if body.source_url and not body.source_url.startswith(("https://", "http://")):
        raise HTTPException(status_code=422, detail="source_url must use http or https")
    document = Document(
        title=title,
        source_url=body.source_url,
        content_markdown=body.content_markdown,
        source_type=body.source_type,
    )
    db.add(document)
    db.flush()
    db.add(ReadingProgress(document_id=document.id))
    db.commit()
    db.refresh(document)
    return _document_out(document)


@router.get("/documents/{document_id}")
def get_document(document_id: str, db: Session = Depends(get_db)):
    document = _get_document(db, document_id)
    progress = _get_or_create_progress(db, document_id)
    highlights = list(db.scalars(
        select(ReadingHighlight).where(ReadingHighlight.document_id == document_id)
        .order_by(ReadingHighlight.created_at.desc())
    ).all())
    db.commit()
    return {
        **_document_out(document),
        "progress": _progress_out(progress),
        "highlights": [{
            "id": item.id, "quote_text": item.quote_text, "note": item.note,
            "position_start": item.position_start, "position_end": item.position_end,
            "created_at": item.created_at,
        } for item in highlights],
    }


@router.put("/documents/{document_id}")
def update_document(document_id: str, body: DocumentUpdate, db: Session = Depends(get_db)):
    document = _get_document(db, document_id)
    changes = body.model_dump(exclude_unset=True)
    if "title" in changes:
        title = (changes["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=422, detail="title must not be blank")
        document.title = title
    if "source_url" in changes:
        source_url = changes["source_url"]
        if source_url and not source_url.startswith(("https://", "http://")):
            raise HTTPException(status_code=422, detail="source_url must use http or https")
        document.source_url = source_url
    if "content_markdown" in changes:
        document.content_markdown = changes["content_markdown"] or ""
    document.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(document)
    return _document_out(document)


@router.put("/documents/{document_id}/progress")
def update_progress(document_id: str, body: ProgressUpdate, db: Session = Depends(get_db)):
    _get_document(db, document_id)
    progress = _get_or_create_progress(db, document_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    for key, value in changes.items():
        setattr(progress, key, value)
    if progress.progress_percent == 100 and "status" not in changes:
        progress.status = "completed"
    elif progress.progress_percent < 100 and progress.status == "completed" and "status" not in changes:
        progress.status = "reading" if progress.progress_percent else "unread"
    progress.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(progress)
    return _progress_out(progress)


@router.get("/documents/{document_id}/highlights")
def list_highlights(document_id: str, db: Session = Depends(get_db)):
    _get_document(db, document_id)
    highlights = db.scalars(
        select(ReadingHighlight).where(ReadingHighlight.document_id == document_id)
        .order_by(ReadingHighlight.created_at.desc())
    ).all()
    return [{
        "id": item.id, "document_id": item.document_id, "quote_text": item.quote_text,
        "note": item.note, "position_start": item.position_start,
        "position_end": item.position_end, "created_at": item.created_at,
    } for item in highlights]


@router.post("/documents/{document_id}/highlights", status_code=201)
def create_highlight(document_id: str, body: HighlightCreate, db: Session = Depends(get_db)):
    _get_document(db, document_id)
    quote = body.quote_text.strip()
    if not quote:
        raise HTTPException(status_code=422, detail="quote_text must not be blank")
    if body.position_start is not None and body.position_end is not None and body.position_end < body.position_start:
        raise HTTPException(status_code=422, detail="position_end must be >= position_start")
    highlight = ReadingHighlight(
        document_id=document_id, quote_text=quote, note=body.note,
        position_start=body.position_start, position_end=body.position_end,
    )
    db.add(highlight)
    progress = _get_or_create_progress(db, document_id)
    if progress.status == "unread":
        progress.status = "reading"
    db.commit()
    db.refresh(highlight)
    return {
        "id": highlight.id, "document_id": highlight.document_id,
        "quote_text": highlight.quote_text, "note": highlight.note,
        "position_start": highlight.position_start, "position_end": highlight.position_end,
        "created_at": highlight.created_at,
    }


@router.delete("/documents/{document_id}/highlights/{highlight_id}")
def delete_highlight(document_id: str, highlight_id: str, db: Session = Depends(get_db)):
    _get_document(db, document_id)
    highlight = db.get(ReadingHighlight, highlight_id)
    if not highlight or highlight.document_id != document_id:
        raise HTTPException(status_code=404, detail="Highlight not found")
    db.delete(highlight)
    db.commit()
    return {"id": highlight_id, "deleted": True}
