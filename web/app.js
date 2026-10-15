const statusEl = document.querySelector("#status");
const cardsEl = document.querySelector("#cards");
const noteListEl = document.querySelector("#noteList");
let editingNoteId = null;
let cachedNotes = [];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vibereading", 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "operation_id" });
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("readingDocuments")) db.createObjectStore("readingDocuments", { keyPath: "id" });
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

async function getById(name, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function applyPendingReadingOperations(documentRecord) {
  if (!documentRecord) return documentRecord;
  const operations = (await getAll("outbox"))
    .filter(op => op.entity_id === documentRecord.id && op.status !== "conflict")
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  let merged = { ...documentRecord };
  for (const operation of operations) {
    if (operation.entity_type === "reading_progress") {
      merged.progress = { ...(merged.progress || {}), ...operation.payload };
    } else if (operation.entity_type === "reading_highlight_create") {
      const highlight = { ...operation.payload, document_id: operation.entity_id, pending_sync: true };
      merged.highlights = [...(merged.highlights || []).filter(item => item.id !== highlight.id), highlight];
    }
  }
  return merged;
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
    title.textContent = note.title + (note._pending_delete ? "（待删除）" : "");
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
    edit.disabled = Boolean(note._pending_delete);
    edit.addEventListener("click", () => {
      editingNoteId = note.id;
      document.querySelector("#noteTitle").value = note.title;
      document.querySelector("#noteBody").value = note.body_markdown;
      document.querySelector("#noteType").value = note.note_type;
      document.querySelector("#noteEditing").textContent = "正在编辑：" + note.title;
      document.querySelector("#saveNote").textContent = "更新笔记";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const relationships = document.createElement("button");
    relationships.textContent = "链接关系";
    relationships.addEventListener("click", () => showNoteLinks(note.id));
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", () => queueDeleteNote(note));
    const makeCard = document.createElement("button");
    makeCard.textContent = "生成闪卡";
    makeCard.disabled = Boolean(note._pending_delete);
    makeCard.addEventListener("click", () => createFlashcardFromNote(note));
    row.append(title, meta, excerpt, edit, relationships, makeCard, remove);
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

async function createFlashcardFromNote(note) {
  if (!navigator.onLine) {
    statusEl.textContent = "请先联网，才能将笔记转换为闪卡。";
    return;
  }
  const front = prompt("闪卡正面（问题）", note.title);
  if (front === null || !front.trim()) return;
  const back = prompt("闪卡背面（答案）", note.body_markdown.slice(0, 2000));
  if (back === null || !back.trim()) return;
  try {
    const response = await fetch("/api/flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        front: front.trim(),
        back: back.trim(),
        source_note_id: note.id
      })
    });
    if (!response.ok) {
      statusEl.textContent = "生成闪卡失败（HTTP " + response.status + "）。";
      return;
    }
    const card = await response.json();
    await transact("cards", "readwrite", store => store.put(card));
    statusEl.textContent = "闪卡已创建，并关联来源笔记“" + note.title + "”。";
    await refresh();
  } catch {
    statusEl.textContent = "网络连接失败，闪卡尚未创建。";
  }
}

async function showKnowledgeGraph() {
  const panel = document.querySelector("#graphPanel");
  panel.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "知识图谱与孤立卡片";
  panel.append(heading);
  if (!navigator.onLine) {
    const message = document.createElement("p");
    message.textContent = "知识图谱需要联网获取完整的笔记关系。";
    panel.append(message);
    return;
  }
  try {
    const response = await fetch("/api/notes/graph");
    if (!response.ok) throw new Error("Graph request failed");
    const graph = await response.json();
    const summary = document.createElement("p");
    summary.textContent = "笔记 " + graph.stats.notes + " 条 · 链接 " + graph.stats.links
      + " 条 · 孤立卡片 " + graph.stats.orphans + " 条";
    panel.append(summary);
    if (!graph.nodes.length) {
      const empty = document.createElement("p");
      empty.textContent = "还没有笔记，先创建几张卡片吧。";
      panel.append(empty);
      return;
    }
    const svgNS = "http://www.w3.org/2000/svg";
    const width = 760;
    const height = Math.max(260, Math.ceil(graph.nodes.length / 4) * 110);
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "笔记关系图");
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.border = "1px solid #8885";
    svg.style.borderRadius = "12px";
    const positions = new Map();
    graph.nodes.forEach((node, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      positions.set(node.id, { x: 95 + col * 190, y: 48 + row * 110 });
    });
    for (const edge of graph.edges) {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) continue;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", from.x);
      line.setAttribute("y1", from.y);
      line.setAttribute("x2", to.x);
      line.setAttribute("y2", to.y);
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-opacity", "0.4");
      line.setAttribute("stroke-width", "1.5");
      svg.append(line);
    }
    for (const node of graph.nodes) {
      const point = positions.get(node.id);
      const group = document.createElementNS(svgNS, "g");
      group.style.cursor = "pointer";
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", point.x);
      circle.setAttribute("cy", point.y);
      circle.setAttribute("r", node.orphan ? "24" : "20");
      circle.setAttribute("fill", node.orphan ? "#d97706" : "#2563eb");
      circle.setAttribute("fill-opacity", "0.85");
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", point.x);
      label.setAttribute("y", point.y + 36);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "11");
      label.setAttribute("fill", "currentColor");
      label.textContent = node.title.length > 22 ? node.title.slice(0, 21) + "…" : node.title;
      const titleEl = document.createElementNS(svgNS, "title");
      titleEl.textContent = node.title + (node.orphan ? "（孤立卡片）" : "");
      group.append(circle, label, titleEl);
      group.addEventListener("click", async () => {
        const noteResponse = await fetch("/api/notes/" + encodeURIComponent(node.id));
        if (!noteResponse.ok) return;
        const selected = await noteResponse.json();
        editingNoteId = selected.id;
        document.querySelector("#noteTitle").value = selected.title;
        document.querySelector("#noteBody").value = selected.body_markdown;
        document.querySelector("#noteType").value = selected.note_type;
        document.querySelector("#noteEditing").textContent = "正在编辑：" + selected.title;
        document.querySelector("#saveNote").textContent = "更新笔记";
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      svg.append(group);
    }
    panel.append(svg);
    const orphanTitle = document.createElement("h4");
    orphanTitle.textContent = "孤立卡片（橙色节点）";
    panel.append(orphanTitle);
    const orphans = graph.nodes.filter(node => node.orphan);
    if (!orphans.length) {
      const none = document.createElement("p");
      none.textContent = "没有孤立卡片，所有笔记都至少参与一条链接。";
      panel.append(none);
    } else {
      const list = document.createElement("ul");
      for (const node of orphans) {
        const item = document.createElement("li");
        item.textContent = node.title;
        list.append(item);
      }
      panel.append(list);
    }
  } catch {
    const error = document.createElement("p");
    error.textContent = "加载知识图谱失败，请稍后重试。";
    panel.append(error);
  }
}

async function showNoteLinks(noteId) {
  const panel = document.querySelector("#noteLinks");
  panel.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "笔记链接与反向引用";
  panel.append(heading);
  if (!navigator.onLine) {
    const offline = document.createElement("p");
    offline.textContent = "离线时暂时无法查询服务器端的链接关系。";
    panel.append(offline);
    return;
  }
  try {
    const [linksResponse, backlinksResponse] = await Promise.all([
      fetch("/api/notes/" + encodeURIComponent(noteId) + "/links"),
      fetch("/api/notes/" + encodeURIComponent(noteId) + "/backlinks")
    ]);
    if (!linksResponse.ok || !backlinksResponse.ok) throw new Error("Unable to load links");
    const [linksData, backlinksData] = await Promise.all([linksResponse.json(), backlinksResponse.json()]);
    const outgoingTitle = document.createElement("h4");
    outgoingTitle.textContent = "正文中引用的笔记";
    panel.append(outgoingTitle);
    if (!linksData.links.length) {
      const empty = document.createElement("p");
      empty.textContent = "没有发现 [[双向链接]]。";
      panel.append(empty);
    }
    for (const link of linksData.links) {
      const line = document.createElement("p");
      line.textContent = (link.resolved ? "✓ " : "? ") + link.title + (link.resolved ? "（已解析）" : "（未找到目标笔记）");
      panel.append(line);
    }
    const incomingTitle = document.createElement("h4");
    incomingTitle.textContent = "反向引用";
    panel.append(incomingTitle);
    if (!backlinksData.backlinks.length) {
      const empty = document.createElement("p");
      empty.textContent = "还没有其他笔记引用这条笔记。";
      panel.append(empty);
    }
    for (const backlink of backlinksData.backlinks) {
      const line = document.createElement("p");
      line.textContent = backlink.title + " · " + backlink.note_type;
      const open = document.createElement("button");
      open.textContent = "打开";
      open.addEventListener("click", async () => {
        const response = await fetch("/api/notes/" + encodeURIComponent(backlink.id));
        if (!response.ok) return;
        const note = await response.json();
        editingNoteId = note.id;
        document.querySelector("#noteTitle").value = note.title;
        document.querySelector("#noteBody").value = note.body_markdown;
        document.querySelector("#noteType").value = note.note_type;
        document.querySelector("#noteEditing").textContent = "正在编辑：" + note.title;
        document.querySelector("#saveNote").textContent = "更新笔记";
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      line.append(open);
      panel.append(line);
    }
  } catch {
    const error = document.createElement("p");
    error.textContent = "加载链接关系失败，请稍后重试。";
    panel.append(error);
  }
}

function resetNoteEditor() {
  editingNoteId = null;
  document.querySelector("#noteTitle").value = "";
  document.querySelector("#noteBody").value = "";
  document.querySelector("#noteType").value = "permanent";
  document.querySelector("#noteEditing").textContent = "新建笔记";
  document.querySelector("#saveNote").textContent = "保存笔记";
}

async function queueDeleteNote(note) {
  if (!confirm("确定删除笔记“" + note.title + "”？同步到服务器后将无法通过此界面恢复。")) return;
  const operations = await getAll("outbox");
  const existing = operations.find(op => op.entity_type === "note_mutation" && op.entity_id === note.id);
  if (existing?.operation === "create") {
    await transact("outbox", "readwrite", store => store.delete(existing.operation_id));
    await transact("notes", "readwrite", store => store.delete(note.id));
    statusEl.textContent = "尚未同步的新笔记已取消创建。";
    await loadNotes();
    return;
  }
  const now = new Date().toISOString();
  const operation = {
    operation_id: crypto.randomUUID(),
    entity_type: "note_mutation",
    entity_id: note.id,
    operation: "delete",
    payload: {
      note: { ...note, _pending_delete: true },
      expected_updated_at: existing?.payload?.expected_updated_at ?? note.updated_at
    },
    client_created_at: now,
    status: "pending"
  };
  if (existing) await transact("outbox", "readwrite", store => store.delete(existing.operation_id));
  await transact("outbox", "readwrite", store => store.put(operation));
  await transact("notes", "readwrite", store => store.put({ ...note, _pending_delete: true }));
  statusEl.textContent = navigator.onLine ? "删除已排队，正在同步…" : "离线：删除操作已保存，联网后自动同步。";
  await loadNotes();
  await syncOutbox();
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
  const existingPending = isEditing
    ? (await getAll("outbox")).find(op => op.entity_type === "note_mutation" && op.entity_id === editingNoteId)
    : null;
  const now = new Date().toISOString();
  const note = {
    id: isEditing ? editingNoteId : crypto.randomUUID(),
    title, body_markdown, note_type,
    document_id: previous?.document_id ?? null,
    created_at: previous?.created_at ?? now,
    updated_at: now
  };
  const operation = existingPending
    ? {
        ...existingPending,
        operation_id: existingPending.operation === "create" ? existingPending.operation_id : crypto.randomUUID(),
        operation: existingPending.operation,
        payload: {
          note,
          expected_updated_at: existingPending.payload.expected_updated_at
        },
        client_created_at: now,
        status: "pending"
      }
    : {
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
        const isDelete = operation.operation === "delete";
        let url = "/api/notes";
        let method = "POST";
        let payload;
        if (isCreate) {
          payload = { id: note.id, title: note.title, body_markdown: note.body_markdown, note_type: note.note_type, document_id: note.document_id };
        } else if (isDelete) {
          url += "/" + encodeURIComponent(note.id)
            + "?operation_id=" + encodeURIComponent(operation.operation_id)
            + "&expected_updated_at=" + encodeURIComponent(operation.payload.expected_updated_at || "");
          method = "DELETE";
        } else {
          url += "/" + encodeURIComponent(note.id);
          method = "PUT";
          payload = { operation_id: operation.operation_id, title: note.title, body_markdown: note.body_markdown, note_type: note.note_type, document_id: note.document_id, expected_updated_at: operation.payload.expected_updated_at };
        }
        response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(payload ? { body: JSON.stringify(payload) } : {})
        });
        if (response.ok) {
          if (isDelete) {
            await transact("notes", "readwrite", store => store.delete(note.id));
          } else {
            const saved = await response.json();
            await transact("notes", "readwrite", store => store.put(saved));
          }
          await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
          statusEl.textContent = isDelete ? "笔记已删除并同步。" : "笔记已同步。";
        } else if (response.status === 409) {
          operation.status = "conflict";
          operation.server_message = "服务器上的笔记版本已变化。";
          await transact("outbox", "readwrite", store => store.put(operation));
          statusEl.textContent = "笔记同步冲突：本地版本已保留，请手动处理。";
        } else if (response.status === 404 && isDelete) {
          // The target is already absent on the server; treat deletion as completed.
          await transact("notes", "readwrite", store => store.delete(note.id));
          await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
          statusEl.textContent = "服务器上的笔记已不存在，已清理本地副本。";
        } else {
          statusEl.textContent = "笔记同步失败（HTTP " + response.status + "）；操作仍保留在本机。";
        }
        continue;
      }

      if (operation.entity_type === "reading_progress") {
        response = await fetch("/api/documents/" + encodeURIComponent(operation.entity_id) + "/progress", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation.payload)
        });
        if (response.ok) {
          const savedProgress = await response.json();
          const cached = await getById("readingDocuments", operation.entity_id);
          if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, progress: savedProgress }));
          await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
          statusEl.textContent = "离线阅读进度已同步。";
        } else {
          statusEl.textContent = "阅读进度同步失败（HTTP " + response.status + "）；操作仍保留在本机。";
        }
        continue;
      }

      if (operation.entity_type === "reading_highlight_create") {
        response = await fetch("/api/documents/" + encodeURIComponent(operation.entity_id) + "/highlights", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation.payload)
        });
        if (response.ok) {
          const savedHighlight = await response.json();
          const cached = await getById("readingDocuments", operation.entity_id);
          if (cached) {
            const highlights = cached.highlights || [];
            const merged = [...highlights.filter(item => item.id !== savedHighlight.id), savedHighlight];
            await transact("readingDocuments", "readwrite", store => store.put({ ...cached, highlights: merged }));
          }
          await transact("outbox", "readwrite", store => store.delete(operation.operation_id));
          statusEl.textContent = "离线摘录已同步。";
        } else if (response.status === 409) {
          operation.status = "conflict";
          operation.server_message = "同一摘录 ID 对应不同内容；本地数据已保留。";
          await transact("outbox", "readwrite", store => store.put(operation));
          statusEl.textContent = "摘录同步冲突：本地操作已保留，请检查。";
        } else {
          statusEl.textContent = "摘录同步失败（HTTP " + response.status + "）；操作仍保留在本机。";
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
  await loadReadingList();
  if (activeDocumentId) await reloadHighlights();
}

document.querySelector("#noteSearch").addEventListener("input", renderNotes);
document.querySelector("#showGraph").addEventListener("click", showKnowledgeGraph);
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


let activeDocumentId = null;
let activeDocumentTitle = "";
let activeDocumentUrl = "";
let activeSelectionStart = null;
let activeSelectionEnd = null;

async function loadReadingList() {
  const list = document.querySelector("#readingList");
  list.replaceChildren();
  let documents = [];
  if (navigator.onLine) {
    try {
      const response = await fetch("/api/documents?limit=500");
      if (!response.ok) throw new Error("Unable to load reading queue");
      documents = await response.json();
      for (let i = 0; i < documents.length; i++) {
        documents[i] = await applyPendingReadingOperations(documents[i]);
      }
      for (const item of documents) {
        const cached = await getById("readingDocuments", item.id);
        // Do not replace a full cached document with the shorter list summary.
        if (!cached || !cached.content_markdown) {
          await transact("readingDocuments", "readwrite", store => store.put(item));
        } else {
          await transact("readingDocuments", "readwrite", store => store.put({
            ...cached, title: item.title, source_url: item.source_url,
            progress: item.progress, highlight_count: item.highlight_count,
            updated_at: item.updated_at
          }));
        }
      }
    } catch {
      documents = await getAll("readingDocuments");
      statusEl.textContent = "服务器暂不可用，正在显示本机缓存的阅读清单。";
    }
  } else {
    documents = await getAll("readingDocuments");
  }
  if (!documents.length) {
    list.textContent = navigator.onLine
      ? "阅读清单还是空的，添加第一篇文章吧。"
      : "本机没有缓存的阅读材料；联网打开文章后即可离线阅读。";
    return;
  }
  for (const item of documents.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))) {
    const row = document.createElement("div");
    row.className = "note-row";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("p");
    meta.className = "muted";
    const progress = item.progress || { status: "unread", progress_percent: 0 };
    meta.textContent = (progress.status === "completed" ? "已完成" : progress.status === "reading" ? "阅读中" : "未开始")
      + " · " + progress.progress_percent + "%" + (item.content_markdown ? " · 已缓存正文" : " · 尚未缓存正文");
    const open = document.createElement("button");
    open.textContent = "继续阅读";
    open.disabled = !navigator.onLine && !item.content_markdown;
    open.addEventListener("click", () => openReadingDocument(item.id));
    row.append(title, meta, open);
    list.append(row);
  }
}

async function openReadingDocument(id) {
  try {
    let item;
    if (navigator.onLine) {
      try {
        const response = await fetch("/api/documents/" + encodeURIComponent(id));
        if (!response.ok) throw new Error("Document not found");
        item = await response.json();
        item = await applyPendingReadingOperations(item);
        await transact("readingDocuments", "readwrite", store => store.put(item));
      } catch {
        item = await getById("readingDocuments", id);
        if (!item || !item.content_markdown) throw new Error("No cached document available");
        statusEl.textContent = "已打开本机缓存的文章；离线状态下不能保存修改。";
      }
    } else {
      item = await getById("readingDocuments", id);
      if (!item || !item.content_markdown) throw new Error("No cached document available");
      statusEl.textContent = "离线阅读模式：正文来自本机缓存，保存与摘录功能需要联网。";
    }
    activeDocumentId = item.id;
    activeDocumentTitle = item.title;
    activeDocumentUrl = item.source_url || "";
    document.querySelector("#readingEditor").hidden = false;
    const offline = !navigator.onLine;
    for (const selector of ["#readingEditTitle", "#readingEditUrl", "#readingBody", "#saveReadingDocument"]) {
      document.querySelector(selector).disabled = offline;
    }
    document.querySelector("#readingCurrentTitle").textContent = item.title;
    document.querySelector("#readingSource").textContent = item.source_url || "未设置原文链接";
    document.querySelector("#readingEditTitle").value = item.title;
    document.querySelector("#readingEditUrl").value = item.source_url || "";
    document.querySelector("#readingBody").value = item.content_markdown || "";
    const resumePosition = Math.min(item.progress.last_position || 0, document.querySelector("#readingBody").value.length);
    document.querySelector("#readingBody").setSelectionRange(resumePosition, resumePosition);
    activeSelectionStart = null;
    activeSelectionEnd = null;
    document.querySelector("#readingStatus").value = item.progress.status;
    document.querySelector("#readingProgress").value = item.progress.progress_percent;
    document.querySelector("#readingProgressLabel").textContent = item.progress.progress_percent + "%";
    renderHighlights(item.highlights || []);
    document.querySelector("#readingEditor").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    statusEl.textContent = "打开文章失败，请稍后重试。";
  }
}

async function createReadingDocument() {
  const title = document.querySelector("#readingTitle").value.trim();
  const source_url = document.querySelector("#readingUrl").value.trim() || null;
  const content_markdown = document.querySelector("#readingContent").value;
  if (!title) {
    statusEl.textContent = "请先填写文章标题。";
    return;
  }
  if (source_url && !/^https?:\/\//i.test(source_url)) {
    statusEl.textContent = "原文链接必须以 http:// 或 https:// 开头。";
    return;
  }
  try {
    const response = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, source_url, content_markdown })
    });
    if (!response.ok) {
      statusEl.textContent = "加入阅读清单失败（HTTP " + response.status + "）。";
      return;
    }
    const item = await response.json();
    document.querySelector("#readingTitle").value = "";
    document.querySelector("#readingUrl").value = "";
    document.querySelector("#readingContent").value = "";
    statusEl.textContent = "已加入阅读清单。";
    await loadReadingList();
    await openReadingDocument(item.id);
  } catch {
    statusEl.textContent = "无法连接服务器，阅读材料尚未保存。";
  }
}

async function saveReadingDocument() {
  if (!activeDocumentId) return;
  const title = document.querySelector("#readingEditTitle").value.trim();
  const source_url = document.querySelector("#readingEditUrl").value.trim() || null;
  const content_markdown = document.querySelector("#readingBody").value;
  if (!title) {
    statusEl.textContent = "文章标题不能为空。";
    return;
  }
  try {
    const response = await fetch("/api/documents/" + encodeURIComponent(activeDocumentId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, source_url, content_markdown })
    });
    if (!response.ok) throw new Error("save failed");
    const saved = await response.json();
    const cached = await getById("readingDocuments", activeDocumentId);
    await transact("readingDocuments", "readwrite", store => store.put({
      ...(cached || {}), ...saved,
      id: activeDocumentId, title, source_url, content_markdown,
      progress: cached?.progress || { status: "unread", progress_percent: 0, last_position: 0 },
      highlights: cached?.highlights || []
    }));
    document.querySelector("#readingCurrentTitle").textContent = title;
    document.querySelector("#readingSource").textContent = source_url || "未设置原文链接";
    statusEl.textContent = "文章正文已保存。";
    await loadReadingList();
  } catch {
    statusEl.textContent = "保存正文失败，请检查网络后重试。";
  }
}

async function saveReadingProgress() {
  if (!activeDocumentId) return;
  const payload = {
    status: document.querySelector("#readingStatus").value,
    progress_percent: Number(document.querySelector("#readingProgress").value),
    last_position: document.querySelector("#readingBody").selectionStart || 0
  };
  const cached = await getById("readingDocuments", activeDocumentId);
  if (!navigator.onLine) {
    const operation = {
      operation_id: crypto.randomUUID(), entity_type: "reading_progress",
      entity_id: activeDocumentId, operation: "update",
      payload, status: "pending", created_at: new Date().toISOString()
    };
    await transact("outbox", "readwrite", store => store.put(operation));
    if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, progress: { ...payload } }));
    statusEl.textContent = "阅读进度已保存到本机，联网后会自动同步。";
    await loadReadingList();
    return;
  }
  try {
    const response = await fetch("/api/documents/" + encodeURIComponent(activeDocumentId) + "/progress", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("progress save failed");
    const savedProgress = await response.json();
    if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, progress: savedProgress }));
    statusEl.textContent = "阅读进度已保存。";
    await loadReadingList();
  } catch {
    const operation = {
      operation_id: crypto.randomUUID(), entity_type: "reading_progress",
      entity_id: activeDocumentId, operation: "update",
      payload, status: "pending", created_at: new Date().toISOString()
    };
    await transact("outbox", "readwrite", store => store.put(operation));
    if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, progress: { ...payload } }));
    statusEl.textContent = "网络暂不可用，阅读进度已暂存本机，联网后会重试。";
  }
}

function renderHighlights(highlights) {
  const panel = document.querySelector("#highlightList");
  panel.replaceChildren();
  if (!highlights.length) {
    panel.textContent = "还没有摘录。";
    return;
  }
  for (const item of highlights) {
    const card = document.createElement("article");
    card.className = "note-row";
    const quote = document.createElement("blockquote");
    quote.textContent = item.quote_text;
    card.append(quote);
    if (item.note) {
      const note = document.createElement("p");
      note.textContent = item.note;
      card.append(note);
    }
    const remove = document.createElement("button");
    remove.textContent = item.pending_sync ? "等待同步" : "删除摘录";
    remove.disabled = !navigator.onLine || Boolean(item.pending_sync);
    remove.addEventListener("click", async () => {
      if (!confirm("确定删除这条摘录吗？")) return;
      const response = await fetch("/api/documents/" + encodeURIComponent(activeDocumentId)
        + "/highlights/" + encodeURIComponent(item.id), { method: "DELETE" });
      if (response.ok) {
        await reloadHighlights();
        statusEl.textContent = "摘录已删除。";
      }
    });
    const makeLiterature = document.createElement("button");
    makeLiterature.textContent = "生成文献笔记";
    makeLiterature.disabled = !navigator.onLine || Boolean(item.pending_sync);
    makeLiterature.addEventListener("click", () => convertHighlightToKnowledge(item, "literature"));
    const makeNote = document.createElement("button");
    makeNote.textContent = "生成永久笔记";
    makeNote.disabled = !navigator.onLine || Boolean(item.pending_sync);
    makeNote.addEventListener("click", () => convertHighlightToKnowledge(item, "permanent"));
    const makeCard = document.createElement("button");
    makeCard.textContent = "生成闪卡";
    makeCard.disabled = !navigator.onLine || Boolean(item.pending_sync);
    makeCard.addEventListener("click", () => convertHighlightToKnowledge(item, "card"));
    card.append(makeLiterature, makeNote, makeCard, remove);
    panel.append(card);
  }
}

async function convertHighlightToKnowledge(highlight, target) {
  const literatureId = highlight.id;
  const permanentId = "p" + highlight.id.slice(1);
  const literatureTitle = activeDocumentTitle + "｜文献笔记｜" + highlight.id.slice(0, 8);
  const permanentTitle = activeDocumentTitle + "｜永久笔记｜" + highlight.id.slice(0, 8);
  const sourceLine = activeDocumentUrl
    ? "- 文献：[" + activeDocumentTitle + "](" + activeDocumentUrl + ")"
    : "- 文献：" + activeDocumentTitle;
  const marker = "<!-- source-highlight-id: " + highlight.id + " -->";
  const literatureBody = [
    marker, "", "## 原文摘录", "", highlight.quote_text, "",
    "## 阅读批注", "", highlight.note || "（待补充阅读时的即时想法）", "",
    "## 来源", "", sourceLine, "- 阅读材料 ID：" + activeDocumentId
  ].join("\n");
  const permanentBody = [
    marker, "", "## 核心观点", "",
    highlight.note || "（请用自己的话提炼这段摘录的核心观点）", "",
    "## 论据与原文", "", highlight.quote_text, "",
    "## 来源与关联", "",
    "- 文献笔记： [[" + literatureTitle + "]]", sourceLine,
    "- 阅读材料 ID：" + activeDocumentId
  ].join("\n");

  async function ensureNote(id, title, body, noteType) {
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title, body_markdown: body, note_type: noteType, document_id: activeDocumentId })
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error("保存笔记失败（HTTP " + response.status + "）：" + detail);
    }
    return response.json();
  }

  try {
    const literatureNote = await ensureNote(literatureId, literatureTitle, literatureBody, "literature");
    if (target === "literature") {
      statusEl.textContent = "文献笔记已保存；重复操作会复用同一条笔记。";
      await loadNotes();
      return;
    }

    const permanentNote = await ensureNote(permanentId, permanentTitle, permanentBody, "permanent");
    if (target === "card") {
      const existingCardsResponse = await fetch("/api/flashcards?limit=500");
      if (!existingCardsResponse.ok) throw new Error("永久笔记已保存，但无法检查已有闪卡。");
      const existingCards = await existingCardsResponse.json();
      if (existingCards.some(card => card.source_note_id === permanentNote.id)) {
        statusEl.textContent = "永久笔记和闪卡均已存在，已跳过重复创建。";
        await loadNotes();
        await refresh();
        return;
      }
      const front = prompt("闪卡正面：把核心观点转成一个值得回忆的问题", "这段摘录的核心观点是什么？");
      if (front === null) return;
      const back = prompt("闪卡背面：用自己的话概括答案", highlight.note || highlight.quote_text);
      if (back === null) return;
      if (!front.trim() || !back.trim()) {
        statusEl.textContent = "闪卡正反面不能为空；文献笔记和永久笔记已保存。";
        await loadNotes();
        return;
      }
      const cardResponse = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ front: front.trim(), back: back.trim(), source_note_id: permanentNote.id })
      });
      if (!cardResponse.ok) throw new Error("笔记已保存，但创建闪卡失败（HTTP " + cardResponse.status + "）。");
      const savedCard = await cardResponse.json();
      await transact("cards", "readwrite", store => store.put(savedCard));
      statusEl.textContent = "已保存文献笔记、永久笔记，并生成关联闪卡。";
      await refresh();
    } else {
      statusEl.textContent = "文献笔记与永久笔记已建立关联。";
    }
    await loadNotes();
  } catch (error) {
    statusEl.textContent = error.message || "转换失败，请检查网络后重试。";
  }
}

async function reloadHighlights() {
  if (!activeDocumentId || !navigator.onLine) return;
  const response = await fetch("/api/documents/" + encodeURIComponent(activeDocumentId) + "/highlights");
  if (!response.ok) return;
  const highlights = await response.json();
  const mergedHighlights = [...highlights];
  for (const operation of (await getAll("outbox")).filter(op =>
    op.entity_type === "reading_highlight_create" &&
    op.entity_id === activeDocumentId &&
    op.status !== "conflict"
  )) {
    if (!mergedHighlights.some(item => item.id === operation.payload.id)) {
      mergedHighlights.push({ ...operation.payload, document_id: activeDocumentId, pending_sync: true });
    }
  }
  renderHighlights(mergedHighlights);
  const cached = await getById("readingDocuments", activeDocumentId);
  if (cached) {
    await transact("readingDocuments", "readwrite", store => store.put({ ...cached, highlights: mergedHighlights }));
  }
}

async function createReadingHighlight() {
  if (!activeDocumentId) {
    statusEl.textContent = "请先从阅读清单打开一篇文章。";
    return;
  }
  const quote_text = document.querySelector("#highlightQuote").value.trim();
  const note = document.querySelector("#highlightNote").value.trim();
  if (!quote_text) {
    statusEl.textContent = "请填写要保存的摘录。";
    return;
  }
  const payload = {
    id: crypto.randomUUID(), quote_text, note,
    position_start: activeSelectionStart, position_end: activeSelectionEnd
  };
  const cached = await getById("readingDocuments", activeDocumentId);
  if (!navigator.onLine) {
    const operation = {
      operation_id: crypto.randomUUID(), entity_type: "reading_highlight_create",
      entity_id: activeDocumentId, operation: "create",
      payload, status: "pending", created_at: new Date().toISOString()
    };
    await transact("outbox", "readwrite", store => store.put(operation));
    const highlights = [...(cached?.highlights || []), { ...payload, document_id: activeDocumentId, pending_sync: true }];
    if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, highlights }));
    renderHighlights(highlights);
    document.querySelector("#highlightQuote").value = "";
    document.querySelector("#highlightNote").value = "";
    statusEl.textContent = "摘录已保存到本机，联网后会自动同步。";
    return;
  }
  try {
    const response = await fetch("/api/documents/" + encodeURIComponent(activeDocumentId) + "/highlights", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!response.ok) {
      if (response.status >= 500) throw new Error("server unavailable");
      statusEl.textContent = "保存摘录失败（HTTP " + response.status + "）。";
      return;
    }
    const saved = await response.json();
    const updatedCache = await getById("readingDocuments", activeDocumentId);
    if (updatedCache) {
      const highlights = [...(updatedCache.highlights || []).filter(item => item.id !== saved.id), saved];
      await transact("readingDocuments", "readwrite", store => store.put({ ...updatedCache, highlights }));
    }
    document.querySelector("#highlightQuote").value = "";
    document.querySelector("#highlightNote").value = "";
    await reloadHighlights();
    statusEl.textContent = "摘录已保存。";
    await loadReadingList();
  } catch {
    const operation = {
      operation_id: crypto.randomUUID(), entity_type: "reading_highlight_create",
      entity_id: activeDocumentId, operation: "create",
      payload, status: "pending", created_at: new Date().toISOString()
    };
    await transact("outbox", "readwrite", store => store.put(operation));
    const highlights = [...(cached?.highlights || []), { ...payload, document_id: activeDocumentId, pending_sync: true }];
    if (cached) await transact("readingDocuments", "readwrite", store => store.put({ ...cached, highlights }));
    renderHighlights(highlights);
    document.querySelector("#highlightQuote").value = "";
    document.querySelector("#highlightNote").value = "";
    statusEl.textContent = "网络异常，摘录已暂存本机，联网后会重试。";
  }
}

function updateReadingEditorAvailability() {
  const editor = document.querySelector("#readingEditor");
  if (editor.hidden) return;
  const offline = !navigator.onLine;
  for (const selector of ["#readingEditTitle", "#readingEditUrl", "#readingStatus", "#readingProgress", "#readingBody", "#saveReadingDocument", "#saveReadingProgress", "#highlightQuote", "#highlightNote", "#captureSelection", "#saveHighlight"]) {
    document.querySelector(selector).disabled = offline;
  }
}

window.addEventListener("online", async () => {
  statusEl.textContent = "网络已恢复。";
  updateReadingEditorAvailability();
  await Promise.all([loadNotes(), refresh(), loadReadingList()]);
if (navigator.onLine) await syncOutbox();
  await syncOutbox();
});
window.addEventListener("offline", async () => {
  statusEl.textContent = "当前离线：阅读正文可使用本机缓存。";
  updateReadingEditorAvailability();
  await loadReadingList();
});

document.querySelector("#createDocument").addEventListener("click", createReadingDocument);
document.querySelector("#saveReadingDocument").addEventListener("click", saveReadingDocument);
document.querySelector("#saveReadingProgress").addEventListener("click", saveReadingProgress);
document.querySelector("#saveHighlight").addEventListener("click", createReadingHighlight);
document.querySelector("#readingProgress").addEventListener("input", event => {
  document.querySelector("#readingProgressLabel").textContent = event.target.value + "%";
});
document.querySelector("#captureSelection").addEventListener("click", () => {
  const body = document.querySelector("#readingBody");
  const selection = body.value.slice(body.selectionStart, body.selectionEnd).trim();
  if (!selection) {
    statusEl.textContent = "请先在正文编辑框中选中一段文字。";
    return;
  }
  document.querySelector("#highlightQuote").value = selection;
  activeSelectionStart = body.selectionStart;
  activeSelectionEnd = body.selectionEnd;
});
document.querySelector("#readingStatus").addEventListener("change", event => {
  if (event.target.value === "completed") {
    document.querySelector("#readingProgress").value = 100;
    document.querySelector("#readingProgressLabel").textContent = "100%";
  }
});

await openDb();
statusEl.textContent = navigator.onLine ? "在线" : "离线";
await Promise.all([loadNotes(), refresh(), loadReadingList()]);
