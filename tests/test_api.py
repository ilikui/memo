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
        "expected_updated_at": note["updated_at"],
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["note_type"] == "literature"
    assert updated.json()["body_markdown"] == "A revised Markdown body."

    fetched = client.get(f"/api/notes/{note['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == f"Updated {unique}"


def test_note_create_is_idempotent_for_client_generated_id():
    note_id = str(uuid4())
    payload = {
        "id": note_id,
        "title": "Offline note",
        "body_markdown": "Created while offline.",
        "note_type": "permanent",
    }
    first = client.post("/api/notes", json=payload)
    second = client.post("/api/notes", json=payload)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] == second.json()["id"] == note_id


def test_stale_note_update_returns_conflict():
    note = client.post("/api/notes", json={"title": "Conflict target"}).json()
    response = client.put(f"/api/notes/{note['id']}", json={
        "title": "Offline edit",
        "body_markdown": "Local copy",
        "note_type": "permanent",
        "expected_updated_at": "2000-01-01T00:00:00+00:00",
    })
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "NOTE_VERSION_CONFLICT"



def test_note_update_retry_is_idempotent():
    note = client.post("/api/notes", json={"title": "Retry target"}).json()
    operation_id = f"note-update-{uuid4()}"
    payload = {
        "operation_id": operation_id,
        "title": "Updated exactly once",
        "body_markdown": "Stable retry payload",
        "note_type": "permanent",
        "expected_updated_at": note["updated_at"],
    }
    first = client.put(f"/api/notes/{note['id']}", json=payload)
    second = client.put(f"/api/notes/{note['id']}", json=payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["title"] == "Updated exactly once"


def test_wikilinks_and_backlinks_resolve_by_title():
    target = client.post("/api/notes", json={
        "title": f"Target {uuid4().hex}",
        "body_markdown": "Target body",
    }).json()
    source = client.post("/api/notes", json={
        "title": f"Source {uuid4().hex}",
        "body_markdown": (
            f"See [[{target['title']}]] and [[{target['title']}|friendly alias]]. "
            "Also see [[Missing Note]] and [[Missing Note#section]]."
        ),
    }).json()

    links_response = client.get(f"/api/notes/{source['id']}/links")
    assert links_response.status_code == 200
    links = links_response.json()["links"]
    assert len(links) == 2
    resolved = next(item for item in links if item["title"] == target["title"])
    unresolved = next(item for item in links if item["title"] == "Missing Note")
    assert resolved["resolved"] is True
    assert resolved["note_id"] == target["id"]
    assert unresolved["resolved"] is False

    backlinks_response = client.get(f"/api/notes/{target['id']}/backlinks")
    assert backlinks_response.status_code == 200
    assert any(item["id"] == source["id"] for item in backlinks_response.json()["backlinks"])


def test_wikilink_endpoints_return_404_for_missing_note():
    assert client.get("/api/notes/missing-note/links").status_code == 404
    assert client.get("/api/notes/missing-note/backlinks").status_code == 404

def test_note_validation_and_not_found():
    invalid = client.post("/api/notes", json={"title": "   ", "body_markdown": "content"})
    assert invalid.status_code == 422

    missing = client.get("/api/notes/not-a-real-note")
    assert missing.status_code == 404
