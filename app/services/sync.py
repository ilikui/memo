import json
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..models import SyncEvent

def append_event(db: Session, event_id: str, entity_type: str, entity_id: str,
                 operation: str, payload: dict) -> SyncEvent:
    existing = db.scalar(select(SyncEvent).where(SyncEvent.event_id == event_id))
    if existing:
        return existing
    event = SyncEvent(event_id=event_id, entity_type=entity_type, entity_id=entity_id,
                      operation=operation, payload_json=json.dumps(payload, ensure_ascii=False, default=str))
    db.add(event)
    db.flush()
    return event
