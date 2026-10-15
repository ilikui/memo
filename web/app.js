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

await openDb();
statusEl.textContent = navigator.onLine ? "在线" : "离线";
await Promise.all([loadNotes(), refresh()]);
