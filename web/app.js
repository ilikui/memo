const statusEl = document.querySelector("#status");
const cardsEl = document.querySelector("#cards");
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vibereading", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", {keyPath:"id"});
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", {keyPath:"operation_id"});
    };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function transact(name, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode); const result = callback(tx.objectStore(name));
    tx.oncomplete = () => {db.close(); resolve(result)}; tx.onerror = () => {db.close(); reject(tx.error)};
  });
}
async function getAll(name) {
  const db = await openDb();
  return new Promise((resolve,reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => {db.close(); resolve(req.result)}; req.onerror = () => {db.close(); reject(req.error)};
  });
}
async function refresh() {
  if (navigator.onLine) {
    try { const r = await fetch("/api/flashcards?limit=200");
      if (r.ok) for (const c of await r.json()) await transact("cards","readwrite",s=>s.put(c));
    } catch {}
  }
  cardsEl.replaceChildren(); const cards = await getAll("cards");
  if (!cards.length) cardsEl.textContent = "No cached cards yet. Connect and create a card first.";
  for (const card of cards) {
    const item=document.createElement("article"); item.className="card";
    const q=document.createElement("h3"); q.textContent=card.front;
    const a=document.createElement("p"); a.textContent=card.back;
    const due=document.createElement("small"); due.textContent="Due: "+new Date(card.due_at).toLocaleString();
    item.append(q,a,due);
    for(const [rating,label] of [[1,"Again"],[2,"Hard"],[3,"Good"],[4,"Easy"]]){
      const b=document.createElement("button"); b.textContent=label;
      b.addEventListener("click",()=>queueReview(card,rating)); item.append(b);
    }
    cardsEl.append(item);
  }
}
async function queueReview(card,rating) {
  const now=new Date().toISOString();
  const op={operation_id:crypto.randomUUID(),entity_type:"flashcard_review",entity_id:card.id,
    operation:"review",payload:{rating,expected_version:card.version,reviewed_at:now},client_created_at:now};
  await transact("outbox","readwrite",s=>s.put(op));
  statusEl.textContent="Review saved locally; attempting sync…"; await syncOutbox();
}
async function syncOutbox() {
  if(!navigator.onLine){statusEl.textContent="Offline: queued actions will retry when connection returns.";return;}
  const ops=await getAll("outbox");
  for(const op of ops){
    try{
      const r=await fetch("/api/flashcards/"+encodeURIComponent(op.entity_id)+"/review",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({operation_id:op.operation_id,rating:op.payload.rating,
          expected_version:op.payload.expected_version,reviewed_at:op.payload.reviewed_at})
      });
      if(r.ok){await transact("outbox","readwrite",s=>s.delete(op.operation_id));statusEl.textContent="Review synced.";}
      else if(r.status===409){statusEl.textContent="Multi-device conflict: operation retained locally for conflict resolution.";}
      else statusEl.textContent="Sync failed (HTTP "+r.status+"); operation retained.";
    }catch{statusEl.textContent="Network unavailable; operation retained locally.";return;}
  }
  await refresh();
}
document.querySelector("#create").addEventListener("click",async()=>{
  const front=document.querySelector("#front").value.trim(),back=document.querySelector("#back").value.trim();
  if(!front||!back){statusEl.textContent="Fill in both fields.";return;}
  if(!navigator.onLine){statusEl.textContent="Offline card creation is not implemented in this starter yet.";return;}
  const r=await fetch("/api/flashcards",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({front,back})});
  if(!r.ok){statusEl.textContent="Create failed: HTTP "+r.status;return;}
  const c=await r.json();await transact("cards","readwrite",s=>s.put(c));
  document.querySelector("#front").value="";document.querySelector("#back").value="";
  statusEl.textContent="Card created.";await refresh();
});
document.querySelector("#refresh").addEventListener("click",refresh);
addEventListener("online",syncOutbox);
addEventListener("offline",()=>statusEl.textContent="Offline: review actions are saved locally.");
if("serviceWorker" in navigator)navigator.serviceWorker.register("/web/sw.js").catch(console.error);
await openDb();statusEl.textContent=navigator.onLine?"Online":"Offline";await refresh();
