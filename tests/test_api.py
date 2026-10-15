from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    assert client.get("/api/health").json()["status"] == "ok"

def test_create_review_is_idempotent():
    r = client.post("/api/flashcards", json={"front": "What is FSRS?", "back": "A spaced-repetition scheduler."})
    assert r.status_code == 201, r.text
    card = r.json()
    payload = {"operation_id": f"review-{uuid4()}", "rating": 3, "expected_version": 1}
    first = client.post(f"/api/flashcards/{card['id']}/review", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 2
    second = client.post(f"/api/flashcards/{card['id']}/review", json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["duplicate"] is True
    logs = client.get("/api/reviews/logs", params={"card_id": card["id"]}).json()
    assert len(logs) == 1

def test_stale_version_is_conflict():
    card = client.post("/api/flashcards", json={"front": "Q", "back": "A"}).json()
    client.post(f"/api/flashcards/{card['id']}/review", json={
        "operation_id": f"review-{uuid4()}", "rating": 3, "expected_version": 1})
    response = client.post(f"/api/flashcards/{card['id']}/review", json={
        "operation_id": f"review-{uuid4()}", "rating": 4, "expected_version": 1})
    assert response.status_code == 409
