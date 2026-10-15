const statusEl = document.querySelector("#status");
const cardsEl = document.querySelector("#cards");
const noteListEl = document.querySelector("#noteList");
let editingNoteId = null;
let cachedNotes = [];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vibereading", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "operation_id" });
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
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

function getPendingNoteOperation(noteId) {
  // The renderer is synchronous; the most recent in-memory list is refreshed on each load.
  return pendingNoteOperations.find(op => op.entity_id === noteId) || null;
}

let pendingNoteOperations = [];

function renderNotes() {
  const query = document.querySelector("#noteSearch").value.trim().toLocaleLowerCase();
  const matches = cachedNotes.filter(note =>
    !query || (note.title + "\n" + note.body_markdown).toLocaleLowerCase().includes(query)
  );
  noteListEl.replaceChildren();
  if (!matches.length) {
    noteListEl.textContent = query ? "没有匹配的缓存笔记。" : "还没有笔记，创建第一条吧。";
    return;
  }
  for (const note of matches) {
    const row = document.createElement("div");
    row.className = "note-row";
    const title = document.createElement("strong");
    title.textContent = note.title;
    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = note.note_type + " · " + new Date(note.updated_at).toLocaleString();
    const excerpt = document.createElement("p");
    excerpt.textContent = note.body_markdown.slice(0, 180);
    const pending = getPendingNoteOperation(note.id);
    if (pending) {
      const syncState = document.createElement("p");
      syncState.className = "muted";
      syncState.textContent = pending.status === "conflict"
        ? "同步冲突：本地版本已保留。可放弃本地修改并重新加载服务器版本。"
        : "本地修改待同步；联网后自动重试。";
      row.append(syncState);
      if (pending.status === "conflict") {
        const discard = document.createElement("button");
        discard.textContent = "放弃本地修改";
        discard.addEventListener("click", async () => {
          if (!confirm("放弃本地修改会丢弃此笔记的待同步版本，继续吗？")) return;
          await transact("outbox", "readwrite", store => store.delete(pending.operation_id));
          await loadNotes();
          statusEl.textContent = "已放弃本地修改并刷新笔记列表。";
        });
        row.append(discard);
      }
    }
    const edit = document.createElement("button");
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      editingNoteId = note.id;
      document.querySelector("#noteTitle").value = note.title;
      document.querySelector("#noteBody").value = note.body_markdown;
      document.querySelector("#noteType").value = note.note_type;
      document.querySelector("#noteEditing").textContent = "正在编辑：" + note.title;
      document.querySelector("#saveNote").textContent = "更新笔记";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    row.append(title, meta, excerpt, edit);
    noteListEl.append(row);
  }
}

async function loadNotes() {
  if (navigator.onLine) {
    try {
      const response = await fetch("/api/notes?limit=500");
      if (response.ok) {
        const pending = (await getAll("outbox"))
          .filter(op => op.entity_type === "note_mutation")
          .map(op => op.entity_id);
        const pendingIds = new Set(pending);
        for (const note of await response.json()) {
          if (!pendingIds.has(note.id)) {
            await transact("notes", "readwrite", store => store.put(note));
          }
        }
      }
    } catch {
      statusEl.textContent = "网络不可用；显示本机缓存的笔记。";
    }
  }
  cachedNotes = (await getAll("notes")).sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  pendingNoteOperations = (await getAll("outbox")).filter(op => op.entity_type === "note_mutation");
  renderNotes();
}

function resetNoteEditor() {
  editingNoteId = null;
  document.querySelector("#noteTitle").value = "";
  document.querySelector("#noteBody").value = "";
  document.querySelector("#noteType").value = "permanent";
  document.querySelector("#noteEditing").textContent = "新建笔记";
  document.querySelector("#saveNote").textContent = "保存笔记";
}

async function saveNote() {
  const title = document.querySelector("#noteTitle").value.trim();
  const body_markdown = document.querySelector("#noteBody").value;
  const note_type = document.querySelector("#noteType").value;
  if (!title) {
    statusEl.textContent = "请填写笔记标题。";
    return;
  }
  const isEditing = Boolean(editingNoteId);
  const previous = isEditing ? cachedNotes.find(note => note.id === editingNoteId) : null;
  const now = new Date().toISOString();
  const note = {
    id: isEditing ? editingNoteId : crypto.randomUUID(),
    title, body_markdown, note_type,
    document_id: previous?.document_id ?? null,
    created_at: previous?.created_at ?? now,
    updated_at: now
  };
  const operation = {
    operation_id: crypto.randomUUID(),
    entity_type: "note_mutation",
    entity_id: note.id,
    operation: isEditing ? "update" : "create",
    payload: {
      note,
      expected_updated_at: previous?.updated_at ?? null
    },
    client_created_at: now,
    status: "pending"
  };
  await transact("notes", "readwrite", store => store.put(note));
  await transact("outbox", "readwrite", store => store.put(operation));
  statusEl.textContent = navigator.onLine
    ? "笔记已本地保存，正在同步…"
    : "离线：笔记已保存在本机，联网后自动同步。";
  resetNoteEditor();
  await loadNotes();
  await syncOutbox();
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
        statusEl.textContent = "刷新闪卡失败（HTTP " + response.status + "）；显示本机缓存。";
      }
    } catch {
      statusEl.textContent = "服务器不可用；显示本机缓存的闪卡。";
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
      ? "还没有闪卡，请先创建一张。"
      : "本设备没有缓存闪卡，请联网加载。";
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
        ? "同步冲突：需要你决定如何处理这条本地复习。"
        : "复习已保存在本机，等待同步；同步前不能重复复习此卡。";
      item.append(note);
      if (pending.status === "conflict") {
        const discard = document.createElement("button");
        discard.textContent = "放弃本地复习并重新加载服务器状态";
        discard.addEventListener("click", async () => {
          if (!confirm("这会删除本机排队的复习操作。确定继续吗？")) return;
          await transact("outbox", "readwrite", store => store.delete(pending.operation_id));
          statusEl.textContent = "本地复习操作已放弃，正在刷新服务器状态…";
          await refresh();
        });
        item.append(discard);
      }
      cardsEl.append(item);
      continue;
    }

    const reveal = document.createElement("button");
    reveal.textContent = "显示答案";
    reveal.addEventListener("click", () => {
      const answer = document.createElement("p");
      answer.textContent = card.back;
      answer.className = "answer";
      const due = document.createElement("small");
      due.textContent = "到期时间：" + new Date(card.due_at).toLocaleString();
      reveal.remove();
      item.append(answer, due);
      for (const [rating, label] of [[1, "重来"], [2, "困难"], [3, "良好"], [4, "简单"]]) {
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
    statusEl.textContent = "这张卡已有一条待同步复习。";
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
    ? "复习已本地保存，正在同步…"
    : "离线：复习已保存到本机，联网后自动同步。";
  await refresh();
  await syncOutbox();
}

async function syncOutbox() {
  if (!navigator.onLine) {
    statusEl.textContent = "离线：笔记和复习操作会在恢复连接后重试。";
    return;
  }
  const operations = (await getAll("outbox")).filter(op => op.status !== "conflict");
  for (const operation of operations) {
    try {
      let response;
      if (operation.entity_type === "note_mutation") {
        const note = operation.payload.note;
        const isCreate = operation.operation === "create";
        const payload = isCreate
          ? { id: note.id, title: note.title, body_markdown: note.body_markdown, note_type: note.note_type, document_id: note.document_id }
          : { operation_id: operation.operation_id, title: note.title, body_markdown: note.body_markdown, note_type: note.note_type, document_id: note.document_id, expected_updated_at: operation.payload.expected_updated_at };
        response = await fetch(isCreate ? "/api/notes" : "/api/notes/" + encodeURIComponent(note.id), {
          method: isCreate ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          const saved = await response.json();
          await transact("notes", "readwrite", store => store.put(saved));
          await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
          statusEl.textContent = "笔记已同步。";
        } else if (response.status === 409) {
          operation.status = "conflict";
          operation.server_message = "服务器上的笔记版本已变化。";
          await transact("outbox", "readwrite", store => store.put(operation));
          statusEl.textContent = "笔记同步冲突：本地版本已保留，请手动处理。";
        } else {
          statusEl.textContent = "笔记同步失败（HTTP " + response.status + "）；操作仍保留在本机。";
        }
        continue;
      }

      if (operation.entity_type !== "flashcard_review") continue;
      response = await fetch("/api/flashcards/" + encodeURIComponent(operation.entity_id) + "/review", {
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
        statusEl.textContent = "复习已同步。";
      } else if (response.status === 409) {
        operation.status = "conflict";
        operation.server_message = "The card changed on another device.";
        await transact("outbox", "readwrite", store => store.put(operation));
        statusEl.textContent = "检测到多设备冲突：请在对应闪卡上选择是否放弃本地复习。";
      } else {
        statusEl.textContent = "同步失败（HTTP " + response.status + "）；操作仍保留在本机。";
      }
    } catch {
      statusEl.textContent = "网络不可用；操作仍保留在本机。";
      return;
    }
  }
  await loadNotes();
  await refresh();
}

document.querySelector("#noteSearch").addEventListener("input", renderNotes);
document.querySelector("#saveNote").addEventListener("click", saveNote);
document.querySelector("#newNote").addEventListener("click", resetNoteEditor);

document.querySelector("#create").addEventListener("click", async () => {
  const front = document.querySelector("#front").value.trim();
  const back = document.querySelector("#back").value.trim();
  if (!front || !back) {
    statusEl.textContent = "请填写闪卡正反面。";
    return;
  }
  if (!navigator.onLine) {
    statusEl.textContent = "当前版本暂不支持离线创建闪卡。";
    return;
  }
  try {
    const response = await fetch("/api/flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ front, back })
    });
    if (!response.ok) {
      statusEl.textContent = "创建闪卡失败（HTTP " + response.status + "）。";
      return;
    }
    const card = await response.json();
    await transact("cards", "readwrite", store => store.put(card));
    document.querySelector("#front").value = "";
    document.querySelector("#back").value = "";
    statusEl.textContent = "闪卡已创建。";
    await refresh();
  } catch {
    statusEl.textContent = "无法连接服务器；闪卡未创建。";
  }
});

document.querySelector("#refresh").addEventListener("click", refresh);
addEventListener("online", async () => {
  await loadNotes();
  await syncOutbox();
});
addEventListener("offline", () => {
  statusEl.textContent = "离线：可查看已缓存笔记与闪卡，复习操作会保存到本机。";
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/web/sw.js").catch(console.error);
}

await openDb();
statusEl.textContent = navigator.onLine ? "在线" : "离线";
await Promise.all([loadNotes(), refresh()]);
