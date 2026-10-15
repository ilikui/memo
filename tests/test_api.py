from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json()["status"] == "ok"


def test_create_review_is_idempotent():
    response = client.post("/api/flashcards", json={
        "front": "What is FSRS?",
        "back": "A spaced-repetition scheduler.",
    })
    assert response.status_code == 201, response.text
    card = response.json()
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
        "operation_id": f"review-{uuid4()}", "rating": 3, "expected_version": 1,
    })
    response = client.post(f"/api/flashcards/{card['id']}/review", json={
        "operation_id": f"review-{uuid4()}", "rating": 4, "expected_version": 1,
    })
    assert response.status_code == 409


def test_markdown_note_create_search_and_update():
    unique = uuid4().hex
    response = client.post("/api/notes", json={
        "title": f"Zettelkasten {unique}",
        "body_markdown": "## Atomic notes\n\nA note should express one idea.",
        "note_type": "permanent",
    })
    assert response.status_code == 201, response.text
    note = response.json()
    assert note["body_markdown"].startswith("## Atomic notes")

    found = client.get("/api/notes", params={"q": unique})
    assert found.status_code == 200
    assert any(item["id"] == note["id"] for item in found.json())

    updated = client.put(f"/api/notes/{note['id']}", json={
        "title": f"Updated {unique}",
        "body_markdown": "A revised Markdown body.",
        "note_type": "literature",
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["note_type"] == "literature"
    assert updated.json()["body_markdown"] == "A revised Markdown body."

    fetched = client.get(f"/api/notes/{note['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == f"Updated {unique}"


def test_note_validation_and_not_found():
    invalid = client.post("/api/notes", json={"title": "   ", "body_markdown": "content"})
    assert invalid.status_code == 422

    missing = client.get("/api/notes/not-a-real-note")
    assert missing.status_code == 404
