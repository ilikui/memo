const statusEl = document.querySelector("#status");
const cardsEl = document.querySelector("#cards");

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vibereading", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "operation_id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transact(name, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const result = callback(tx.objectStore(name));
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("IndexedDB transaction aborted")); };
  });
}

async function getAll(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function refresh() {
  if (navigator.onLine) {
    try {
      const response = await fetch("/api/flashcards?limit=200");
      if (response.ok) {
        for (const card of await response.json()) {
          await transact("cards", "readwrite", store => store.put(card));
        }
      } else {
        statusEl.textContent = "Server refresh failed (HTTP " + response.status + "); showing cached cards.";
      }
    } catch {
      statusEl.textContent = "Server unavailable; showing cached cards.";
    }
  }

  cardsEl.replaceChildren();
  const [cards, operations] = await Promise.all([getAll("cards"), getAll("outbox")]);
  const pendingByCard = new Map();
  for (const operation of operations) {
    if (operation.entity_type === "flashcard_review") pendingByCard.set(operation.entity_id, operation);
  }

  if (!cards.length) {
    cardsEl.textContent = navigator.onLine
      ? "No cards yet. Create your first card above."
      : "No cards are cached on this device yet. Connect to load your cards.";
    return;
  }

  for (const card of cards) {
    const item = document.createElement("article");
    item.className = "card";
    const question = document.createElement("h3");
    question.textContent = card.front;
    item.append(question);

    const pending = pendingByCard.get(card.id);
    if (pending) {
      const note = document.createElement("p");
      note.textContent = pending.status === "conflict"
        ? "Sync conflict: this review needs your decision."
        : "Review queued on this device; another review is disabled until it syncs.";
      item.append(note);

      if (pending.status === "conflict") {
        const discard = document.createElement("button");
        discard.textContent = "Discard local review and reload server state";
        discard.addEventListener("click", async () => {
          if (!confirm("This removes the queued review from this device. Continue?")) return;
          await transact("outbox", "readwrite", store => store.delete(pending.operation_id));
          statusEl.textContent = "Local review discarded; refreshing server state…";
          await refresh();
        });
        item.append(discard);
      }
      cardsEl.append(item);
      continue;
    }

    const reveal = document.createElement("button");
    reveal.textContent = "Show answer";
    reveal.addEventListener("click", () => {
      const answer = document.createElement("p");
      answer.textContent = card.back;
      answer.className = "answer";
      const due = document.createElement("small");
      due.textContent = "Due: " + new Date(card.due_at).toLocaleString();
      reveal.remove();
      item.append(answer, due);
      for (const [rating, label] of [[1, "Again"], [2, "Hard"], [3, "Good"], [4, "Easy"]]) {
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", () => queueReview(card, rating));
        item.append(button);
      }
    });
    item.append(reveal);
    cardsEl.append(item);
  }
}

async function queueReview(card, rating) {
  const existing = (await getAll("outbox")).find(op => op.entity_id === card.id);
  if (existing) {
    statusEl.textContent = "This card already has a queued review.";
    await refresh();
    return;
  }

  const now = new Date().toISOString();
  const operation = {
    operation_id: crypto.randomUUID(),
    entity_type: "flashcard_review",
    entity_id: card.id,
    operation: "review",
    payload: { rating, expected_version: card.version, reviewed_at: now },
    client_created_at: now,
    status: "pending"
  };
  await transact("outbox", "readwrite", store => store.put(operation));
  statusEl.textContent = navigator.onLine
    ? "Review saved locally; attempting sync…"
    : "Offline: review saved on this device and will sync when connected.";
  await refresh();
  await syncOutbox();
}

async function syncOutbox() {
  if (!navigator.onLine) {
    statusEl.textContent = "Offline: queued reviews will retry when connection returns.";
    return;
  }

  const operations = (await getAll("outbox")).filter(op => op.status !== "conflict");
  for (const operation of operations) {
    try {
      const response = await fetch("/api/flashcards/" + encodeURIComponent(operation.entity_id) + "/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation_id: operation.operation_id,
          rating: operation.payload.rating,
          expected_version: operation.payload.expected_version,
          reviewed_at: operation.payload.reviewed_at
        })
      });

      if (response.ok) {
        await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
        statusEl.textContent = "Review synced.";
      } else if (response.status === 409) {
        operation.status = "conflict";
        operation.server_message = "The card changed on another device.";
        await transact("outbox", "readwrite", store => store.put(operation));
        statusEl.textContent = "Multi-device conflict: choose whether to discard the local review.";
      } else {
        statusEl.textContent = "Sync failed (HTTP " + response.status + "); operation retained.";
      }
    } catch {
      statusEl.textContent = "Network unavailable; operation retained locally.";
      return;
    }
  }
  await refresh();
}

document.querySelector("#create").addEventListener("click", async () => {
  const front = document.querySelector("#front").value.trim();
  const back = document.querySelector("#back").value.trim();
  if (!front || !back) {
    statusEl.textContent = "Fill in both fields.";
    return;
  }
  if (!navigator.onLine) {
    statusEl.textContent = "Offline card creation is not implemented in this starter yet.";
    return;
  }
  try {
    const response = await fetch("/api/flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ front, back })
    });
    if (!response.ok) {
      statusEl.textContent = "Create failed: HTTP " + response.status;
      return;
    }
    const card = await response.json();
    await transact("cards", "readwrite", store => store.put(card));
    document.querySelector("#front").value = "";
    document.querySelector("#back").value = "";
    statusEl.textContent = "Card created.";
    await refresh();
  } catch {
    statusEl.textContent = "Could not reach server; card was not created.";
  }
});

document.querySelector("#refresh").addEventListener("click", refresh);
addEventListener("online", syncOutbox);
addEventListener("offline", () => {
  statusEl.textContent = "Offline: review actions are saved locally.";
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/web/sw.js").catch(console.error);
}

await openDb();
statusEl.textContent = navigator.onLine ? "Online" : "Offline";
await refresh();
