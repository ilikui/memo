from datetime import datetime
from typing import Literal, Any
from pydantic import BaseModel, Field

RatingValue = Literal[1, 2, 3, 4]

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
    expected_version: int | None = None
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

class SyncPullResult(BaseModel):
    cursor: int
    events: list[dict[str, Any]]
