from datetime import datetime, timedelta, timezone
from fsrs import Card, Rating, Scheduler

RATING_MAP = {1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy}

def utc_datetime(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must include a timezone")
    return value.astimezone(timezone.utc)

def new_card_state(now: datetime | None = None) -> tuple[str, datetime]:
    now_utc = utc_datetime(now)
    card = Card(due=now_utc)
    return card.to_json(), utc_datetime(card.due)

def review_card_state(card_json: str, rating_value: int, reviewed_at: datetime | None = None,
                      review_duration_ms: int | None = None) -> tuple[str, str, datetime, datetime]:
    if rating_value not in RATING_MAP:
        raise ValueError("rating must be 1=Again, 2=Hard, 3=Good, 4=Easy")
    when = utc_datetime(reviewed_at)
    card = Card.from_json(card_json)
    duration = timedelta(milliseconds=review_duration_ms) if review_duration_ms is not None else None
    scheduler = Scheduler()
    updated_card, log = scheduler.review_card(
        card, RATING_MAP[rating_value],
        review_datetime=when,
        review_duration=duration,
    )
    return updated_card.to_json(), log.to_json(), utc_datetime(log.review_datetime), utc_datetime(updated_card.due)
