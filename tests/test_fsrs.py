from datetime import datetime, timezone
import pytest
from fsrs import Card
from app.services.fsrs import new_card_state, review_card_state

def test_new_card_serializes():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    raw, due = new_card_state(now)
    assert Card.from_json(raw).due == due
    assert due == now

def test_good_review_schedules_future_due():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    raw, _ = new_card_state(now)
    review_time = datetime(2026, 1, 1, 12, 0, 1, tzinfo=timezone.utc)
    state, log, reviewed_at, due = review_card_state(raw, 3, review_time, 12000)
    assert Card.from_json(state).due == due
    assert reviewed_at == review_time
    assert log
    assert due > review_time

def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError):
        review_card_state(new_card_state()[0], 3, datetime(2026, 1, 1))
