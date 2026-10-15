import json
from datetime import datetime, timezone

import pytest
from fsrs import Card

from app.services.fsrs import new_card_state, review_card_state


def test_new_card_serializes():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    raw, due = new_card_state(now)
    assert Card.from_json(raw).due == due
    assert due == now


def test_good_review_schedules_future_due_and_serializes_log():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    raw, _ = new_card_state(now)
    review_time = datetime(2026, 1, 1, 12, 0, 1, tzinfo=timezone.utc)

    state, log_json, reviewed_at, due = review_card_state(raw, 3, review_time, 12000)

    assert Card.from_json(state).due == due
    assert reviewed_at == review_time
    assert due > review_time
    log = json.loads(log_json)
    assert log
    assert log["review_duration"] == 12000


def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError, match="timezone"):
        review_card_state(new_card_state()[0], 3, datetime(2026, 1, 1))


def test_invalid_rating_is_rejected():
    with pytest.raises(ValueError, match="rating must be"):
        review_card_state(new_card_state()[0], 5)
