from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

RatingValue = Literal[1, 2, 3, 4]
NoteType = Literal["fleeting", "literature", "permanent", "index"]


class FlashcardCreate(BaseModel):
    front: str = Field(min_length=1, max_length=20000)
    back: str = Field(min_length=1, max_length=20000)
    source_note_id: str | None = None


class FlashcardOut(BaseModel):
    id: str
    front: str
    back: str
    source_note_id: str | None
    due_at: datetime
    version: int


class ReviewRequest(BaseModel):
    operation_id: str = Field(min_length=8, max_length=100)
    rating: RatingValue
    expected_version: int | None = Field(default=None, ge=1)
    reviewed_at: datetime | None = None
    review_duration_ms: int | None = Field(default=None, ge=0, le=3600000)


class ReviewOut(BaseModel):
    flashcard_id: str
    operation_id: str
    rating: int
    reviewed_at: datetime
    due_at: datetime
    version: int
    duplicate: bool = False


class NoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    body_markdown: str = Field(default="", max_length=200000)
    note_type: NoteType = "permanent"
    document_id: str | None = None


class NoteUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    body_markdown: str = Field(default="", max_length=200000)
    note_type: NoteType = "permanent"
    document_id: str | None = None


class NoteOut(BaseModel):
    id: str
    title: str
    body_markdown: str
    note_type: str
    document_id: str | None
    created_at: datetime
    updated_at: datetime


class SyncPullResult(BaseModel):
    cursor: int
    events: list[dict[str, Any]]
