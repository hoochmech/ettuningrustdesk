// ET Tuning Sessions: customers, devices, X: drive files, and the details filled in
// after each remote session. Sessions themselves are written by the `api` function
// from the reports the ET Tuning Remote client sends when a connection opens and closes.
const auth = firebase.auth();
const db = firebase.firestore();
const { FieldValue } = firebase.firestore;
if (location.hostname === "localhost") {
  auth.useEmulator("http://localhost:9099");
  db.useEmulator("localhost", 8080);
}

const S = {
  user: null,
  view: "queue",
  customers: [],
  categories: [],
  engines: [],
  vehicleMakes: [],
  devices: [],
  queue: [],
  sessions: [],
  files: [],
  loaded: new Set(),
  filters: { sessions: { q: "", category: "", billable: "", status: "complete" }, customers: "", devices: "", files: "" },
};
const VIEWS = {};
let unsubs = [];
let seeded = false;
let pendingDeepLink = null;
// Set by the client's "Job form" toolbar button: #device=<remote ID> of the computer
// being worked on, whose open session gets the form.
let pendingDeviceLink = null;

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function toDate(t) {
  if (!t) return null;
  if (t instanceof Date) return t;
  return typeof t.toDate === "function" ? t.toDate() : null;
}
function fmtDate(t) {
  const d = toDate(t);
  return d ? d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}
function fmtDur(sec) {
  if (sec === null || sec === undefined) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtSize(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const byId = (list, id) => list.find((x) => x.id === id);
const customerName = (id) => byId(S.customers, id)?.name || "";
const categoryName = (id) => byId(S.categories, id)?.name || "";
function deviceLabel(rustdeskId) {
  const d = byId(S.devices, rustdeskId);
  if (!d) return rustdeskId;
  return [d.label || d.hostname, rustdeskId].filter(Boolean).join(" · ");
}
function options(list, selected, placeholder) {
  return (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : "") +
    list.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}>${esc(o.label)}</option>`).join("");
}

// ---------- auth ----------
$("#signin-btn").onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((e) => {
  $("#signin-msg").textContent = e.message;
});

auth.onAuthStateChanged(async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  S.user = null;
  $("#tabs").hidden = true;
  $("#view").innerHTML = "";
  $("#who").innerHTML = "";
  if (!user) {
    $("#signin").hidden = false;
    return;
  }
  $("#who").innerHTML = `${esc(user.email)} <button class="btn ghost small" id="signout">Sign out</button>`;
  $("#signout").onclick = () => auth.signOut();
  let staff = false;
  try {
    staff = (await db.doc(`staff/${user.email}`).get()).exists;
  } catch (e) {
    staff = false;
  }
  if (!staff) {
    $("#signin").hidden = false;
    $("#signin-btn").hidden = true;
    $("#signin-msg").textContent = `${user.email} is not on the staff list. Ask the owner to add it in Firestore under "staff".`;
    return;
  }
  $("#signin").hidden = true;
  $("#tabs").hidden = false;
  S.user = user;
  subscribe();
  const m = location.hash.match(/^#session=([\w-]+)/);
  if (m) pendingDeepLink = m[1];
  const dm = location.hash.match(/^#device=([\w-]+)/);
  if (dm) pendingDeviceLink = dm[1];
  showView(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "queue");
});

function listen(key, query, map) {
  unsubs.push(query.onSnapshot((snap) => {
    S[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (map) S[key] = map(S[key]);
    S.loaded.add(key);
    onData();
  }, (err) => console.error(key, err)));
}

function subscribe() {
  const startedDesc = (a, b) => (toDate(b.started_at) || 0) - (toDate(a.started_at) || 0);
  listen("customers", db.collection("customers").orderBy("name"));
  listen("categories", db.collection("work_categories"), (l) => l.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name)));
  listen("engines", db.collection("engine_makes"), (l) => l.sort((a, b) => a.name.localeCompare(b.name)));
  listen("devices", db.collection("devices"));
  unsubs.push(db.doc("lists/vehicle_makes").onSnapshot((d) => {
    S.vehicleMakes = d.exists ? d.get("items") || [] : [];
    S.loaded.add("vehicleMakes");
    onData();
  }, (err) => console.error("vehicleMakes", err)));
  listen("queue", db.collection("sessions").where("status", "==", "needs_details"), (l) => l.sort(startedDesc));
  listen("sessions", db.collection("sessions").orderBy("started_at", "desc").limit(1000));
  listen("files", db.collection("files").where("current", "==", true), (l) => l.sort((a, b) => b.file_id.localeCompare(a.file_id)));
}

function onData() {
  if (!seeded && S.loaded.has("categories") && S.loaded.has("engines") && S.loaded.has("vehicleMakes")) {
    seeded = true;
    seedLists();
  }
  $("#queue-count").textContent = S.queue.length || "";
  if (pendingDeepLink && S.loaded.has("sessions") && S.loaded.has("queue")) {
    const id = pendingDeepLink;
    pendingDeepLink = null;
    openSessionForm(id);
  }
  if (pendingDeviceLink && ["customers", "categories", "engines", "vehicleMakes", "devices"].every((k) => S.loaded.has(k))) {
    const rid = pendingDeviceLink;
    pendingDeviceLink = null;
    history.replaceState(null, "", `#${S.view}`);
    // The latest session on that computer, whether it is still going, just ended, or
    // already has its details saved, so the form can be opened again at any point.
    // Asked of the server: the first S.sessions snapshot can come from the local cache.
    db.collection("sessions").where("rustdesk_id", "==", rid).where("status", "in", ["active", "needs_details", "complete"]).get().then((snap) => {
      // A file transfer window is its own connection; the remote desktop one is the job.
      const latest = snap.docs.sort((a, b) => (a.get("conn_type") === 0 ? 0 : 1) - (b.get("conn_type") === 0 ? 0 : 1) ||
        (toDate(b.get("started_at")) || 0) - (toDate(a.get("started_at")) || 0))[0];
      if (latest && Date.now() - (toDate(latest.get("started_at"))?.getTime() ?? 0) < 24 * 3600 * 1000) openSessionForm(latest.id);
      else alert(`No session on ${rid} yet. It shows up here a few seconds after you connect.`);
    });
  }
  VIEWS[S.view].body();
}

async function seedLists() {
  const batch = db.batch();
  let n = 0;
  if (!S.categories.length) {
    window.DEFAULT_CATEGORIES.forEach((c, i) => {
      batch.set(db.collection("work_categories").doc(), { ...c, order: i, active: true });
      n++;
    });
  }
  if (!S.engines.length) {
    window.DEFAULT_ENGINES.forEach((m) => {
      batch.set(db.collection("engine_makes").doc(), m);
      n++;
    });
  }
  if (!S.vehicleMakes.length) {
    batch.set(db.doc("lists/vehicle_makes"), { items: window.DEFAULT_VEHICLE_MAKES });
    n++;
  }
  if (n) await batch.commit();
}

// ---------- navigation ----------
$$("#tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(name) {
  S.view = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  if (!location.hash.startsWith("#session=")) history.replaceState(null, "", `#${name}`);
  $("#view").innerHTML = VIEWS[name].shell();
  VIEWS[name].bind?.();
  VIEWS[name].body();
}

// ---------- needs details ----------
VIEWS.queue = {
  shell: () => `<h1>Sessions that need details</h1>
    <p class="muted small">Every remote session that a technician logged into shows up here when it ends. You can also fill in a job while it's still in progress. Fill in the job details, or choose "Don't log" for a session that shouldn't be recorded as a job.</p>
    <div id="vb"></div>`,
  body() {
    const vb = $("#vb");
    if (!vb) return;
    if (!S.loaded.has("queue")) { vb.innerHTML = `<div class="empty">Loading…</div>`; return; }
    const live = S.sessions.filter((s) => s.status === "active");
    const liveHtml = live.length ? `<h2>In progress</h2>${live.map((s) => `
      <div class="card">
        <div class="row">
          <div class="session-head">
            <span><b>${esc(customerName(s.customer_id) || "No customer yet")}</b></span>
            <span>${esc(deviceLabel(s.rustdesk_id))}</span>
            <span>Started ${esc(fmtDate(s.started_at))}</span>
            <span class="muted">${esc(s.conn_type_name)}${s.technician_name ? ` by ${esc(s.technician_name)}` : ""}</span>
          </div>
          <span class="spacer"></span>
          <button class="btn small" data-open="${s.id}">Fill in now</button>
        </div>
      </div>`).join("")}<h2>Ended</h2>` : "";
    if (!S.queue.length) {
      vb.innerHTML = `${liveHtml}<div class="card empty">All caught up. No sessions are waiting for details.</div>`;
      $$("[data-open]", vb).forEach((b) => (b.onclick = () => openSessionForm(b.dataset.open)));
      return;
    }
    vb.innerHTML = liveHtml + S.queue.map((s) => `
      <div class="card">
        <div class="row">
          <div class="session-head">
            <span><b>${esc(customerName(s.customer_id) || "No customer yet")}</b></span>
            <span>${esc(deviceLabel(s.rustdesk_id))}</span>
            <span>${esc(fmtDate(s.started_at))}</span>
            <span>${esc(fmtDur(s.duration_sec))}</span>
            <span class="muted">${esc(s.conn_type_name)}${s.technician_name ? ` by ${esc(s.technician_name)}` : ""}</span>
          </div>
          <span class="spacer"></span>
          <button class="btn ghost small" data-dismiss="${s.id}">Don't log</button>
          <button class="btn small" data-open="${s.id}">Fill in details</button>
        </div>
      </div>`).join("");
    $$("[data-open]", vb).forEach((b) => (b.onclick = () => openSessionForm(b.dataset.open)));
    $$("[data-dismiss]", vb).forEach((b) => (b.onclick = () => dismissSession(b.dataset.dismiss)));
  },
};

// Deletes the session and its connection records, along with any overlapping
// connections to the same computer that the job form would have folded into it.
async function dismissSession(id) {
  if (!confirm("Don't log this session? It is deleted and leaves no record.")) return false;
  const s = findSession(id);
  const ids = [id];
  const start = (toDate(s?.started_at)?.getTime() ?? 0) - 60000;
  const end = (toDate(s?.ended_at)?.getTime() ?? Date.now()) + 60000;
  for (const o of S.queue) {
    if (!s || o.id === id || o.rustdesk_id !== s.rustdesk_id) continue;
    const os = toDate(o.started_at)?.getTime() ?? 0;
    const oe = toDate(o.ended_at)?.getTime() ?? os;
    if (os <= end && oe >= start) ids.push(o.id);
  }
  const res = await fetch("/api/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await S.user.getIdToken()}` },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    alert(`The session could not be removed (${res.status}). Try again.`);
    return false;
  }
  return true;
}

// ---------- session form ----------
function findSession(id) {
  return byId(S.queue, id) || byId(S.sessions, id);
}

async function openSessionForm(id) {
  let s = findSession(id);
  if (!s) {
    const snap = await db.doc(`sessions/${id}`).get();
    if (!snap.exists) { alert("That session was not found."); return; }
    s = { id: snap.id, ...snap.data() };
  }
  const device = byId(S.devices, s.rustdesk_id);
  const custId = s.customer_id || device?.customer_id || "";
  const cats = S.categories.filter((c) => c.active !== false || c.id === s.category_id);
  const files = [...(s.files || [])];
  const origFiles = s.original_file ? [s.original_file] : [];

  openDialog(`
    <h2>Job details</h2>
    <div class="session-head small" style="margin-bottom:12px">
      <span>${esc(deviceLabel(s.rustdesk_id))}</span>
      <span>${esc(fmtDate(s.started_at))}</span>
      <span>${esc(fmtDur(s.duration_sec))}</span>
      <span class="muted">${esc(s.conn_type_name)}${s.technician_name ? ` by ${esc(s.technician_name)}` : ""}</span>
    </div>
    <form id="sf">
      <label>Customer
        <select name="customer">${options(S.customers.map((c) => ({ value: c.id, label: c.company ? `${c.name} (${c.company})` : c.name })), custId, "Choose a customer")}<option value="__new">+ New customer…</option></select>
      </label>
      <div id="newcust" class="grid" hidden style="margin-top:8px">
        <label>Name<input name="nc_name"></label>
        <label>Company<input name="nc_company"></label>
        <label>Phone<input name="nc_phone"></label>
        <label>Email<input name="nc_email" type="email"></label>
      </div>
      ${device && !device.customer_id ? `<label class="radio"><label><input type="checkbox" name="link" checked> Link this computer (${esc(device.hostname || s.rustdesk_id)}) to the customer, so its future sessions fill in automatically</label></label>` : ""}
      <div class="grid" style="margin-top:12px">
        <label>Work category
          <select name="category">${options(cats.map((c) => ({ value: c.id, label: c.name })), s.category_id || "", "Choose a category")}</select>
        </label>
        <div><label>Billable</label>
          <div class="radio">
            <label><input type="radio" name="billable" value="yes"${s.billable === true ? " checked" : ""}> Yes</label>
            <label><input type="radio" name="billable" value="no"${s.billable === false ? " checked" : ""}> No</label>
          </div>
        </div>
      </div>
      <div id="issue-wrap" hidden>
        <label style="margin-top:12px">Original job
          <select name="original"></select>
        </label>
        <label id="pre-wrap" hidden style="margin-top:8px">Original job details (date, file, what was done)
          <input name="original_note" value="${esc(s.original_job_note)}" placeholder="Optional">
        </label>
        <label style="margin-top:12px">Issue experienced
          <textarea name="issue" placeholder="What went wrong?">${esc(s.warranty_issue)}</textarea>
        </label>
      </div>
      <div class="grid" style="margin-top:12px">
        <label>Vehicle make<select name="vehicle"></select></label>
        <label>Engine make<select name="make"></select></label>
        <label>Engine model<select name="model"></select></label>
        <label>ECM type<select name="ecm"></select></label>
      </div>
      <div id="origfile-wrap" hidden>
        <label style="margin-top:12px">Original file used (X: drive)
          <div class="picker"><input name="origsearch" placeholder="The file the earlier tune used: ID or part of the name" autocomplete="off"><div class="picker-list" hidden></div></div>
        </label>
        <div class="chips" id="origchips"></div>
      </div>
      <label style="margin-top:12px">File used (X: drive)
        <div class="picker"><input name="filesearch" placeholder="Type a file ID like CUM-00042 or part of the name" autocomplete="off"><div class="picker-list" hidden></div></div>
      </label>
      <div class="chips" id="filechips"></div>
      <label style="margin-top:12px">Notes<textarea name="notes">${esc(s.notes)}</textarea></label>
      <p class="err" id="sf-err"></p>
      <div class="row"><span class="spacer"></span>
        ${["needs_details", "active"].includes(s.status) ? `<button type="button" class="btn ghost" id="sf-skip">Don't log this session</button>` : ""}
        <button type="button" class="btn ghost" id="sf-cancel">Cancel</button>
        <button class="btn" id="sf-save">Save job</button>
      </div>
    </form>`);

  const f = $("#sf");
  const custSel = f.customer;

  // Warranty: the job being warrantied, from this customer's earlier jobs, or a bypass
  // for work done before sessions were tracked here.
  const PRE = "__pre";
  const fillOriginal = () => {
    const keepSel = f.original.value || (s.original_job_pre_tracking ? PRE : s.original_job_id || "");
    const jobs = S.sessions.filter((j) => j.id !== s.id && j.status === "complete" && j.customer_id === custSel.value &&
      !byId(S.categories, j.category_id)?.requires_issue);
    f.original.innerHTML = options(jobs.map((j) => ({
      value: j.id,
      label: [fmtDate(j.started_at), categoryName(j.category_id) || j.category_name, [j.vehicle_make, j.engine_make, j.engine_model].filter(Boolean).join(" "), (j.file_ids || []).join(", ")].filter(Boolean).join(" · "),
    })), keepSel, jobs.length ? "Choose the original job" : "No earlier jobs for this customer") +
      `<option value="${PRE}"${keepSel === PRE ? " selected" : ""}>Done before job tracking started</option>`;
    $("#pre-wrap").hidden = f.original.value !== PRE;
  };
  f.original.onchange = () => {
    $("#pre-wrap").hidden = f.original.value !== PRE;
    // Same truck as the original job, so start from its vehicle and engine.
    const o = findSession(f.original.value);
    if (o?.files?.length && !origFiles.length) {
      origFiles.push(o.files[0]);
      drawOrig();
    }
    if (o && !f.vehicle.value && !f.make.value) {
      fillVehicle(o.vehicle_make || "");
      fill(f.make, keep(S.engines.map((m) => m.name), o.engine_make), o.engine_make || "", "Choose make");
      fillModel(o.engine_model || "", o.ecm_type || "");
    }
  };
  custSel.onchange = () => {
    $("#newcust").hidden = custSel.value !== "__new";
    fillOriginal();
  };
  fillOriginal();

  const issueWrap = $("#issue-wrap");
  const syncIssue = () => {
    const c = byId(S.categories, f.category.value);
    issueWrap.hidden = !c?.requires_issue;
    $("#origfile-wrap").hidden = !asksOriginalFile(c);
  };
  f.category.onchange = syncIssue;
  syncIssue();

  // Make -> model -> ECM: each choice limits the next list. A stored value that is no
  // longer in the list stays selectable so editing an old job doesn't lose it.
  const keep = keepList;
  // Each list ends with "+ Add…", which saves a new entry to the Lists tab and picks it.
  // A model needs a make chosen first, and an ECM type a model.
  const ADD = "__add";
  const addLabel = { vehicle: "vehicle make", make: "engine make", model: "engine model", ecm: "ECM type" };
  const fill = (sel, list, v, ph) => {
    sel.innerHTML = options(list.map((x) => ({ value: x, label: x })), v, ph);
    if ((sel.name === "model" && !make()) || (sel.name === "ecm" && !model())) return;
    sel.insertAdjacentHTML("beforeend", `<option value="${ADD}">+ Add ${addLabel[sel.name]}…</option>`);
  };
  const make = () => S.engines.find((m) => m.name === f.make.value);
  const model = () => make()?.models?.find((m) => m.name === f.model.value);
  const fillEcm = (v) => fill(f.ecm, keep(model()?.ecms || [], v), v, model() || v ? "Choose ECM" : "Choose a model first");
  const fillModel = (v, ecm) => {
    fill(f.model, keep((make()?.models || []).map((m) => m.name), v), v, make() || v ? "Choose model" : "Choose a make first");
    fillEcm(ecm);
  };
  fill(f.make, keep(S.engines.map((m) => m.name), s.engine_make), s.engine_make || "", "Choose make");
  fillModel(s.engine_model || "", s.ecm_type || "");
  const fillVehicle = (v) => fill(f.vehicle, keep(S.vehicleMakes, v), v, "Choose vehicle make");
  fillVehicle(s.vehicle_make || "");
  f.vehicle.dataset.prev = s.vehicle_make || "";
  f.make.dataset.prev = s.engine_make || "";
  f.model.dataset.prev = s.engine_model || "";
  f.ecm.dataset.prev = s.ecm_type || "";
  // Returns the typed name, or "" (with the list put back as it was) when cancelled.
  const askNew = (sel, refill) => {
    const name = prompt(`New ${addLabel[sel.name]}`)?.trim() || "";
    if (!name) refill(sel.dataset.prev || "");
    return name;
  };
  const sameName = (list, name) => list.find((x) => x.toLowerCase() === name.toLowerCase());
  const saveModels = (m, models) => db.doc(`engine_makes/${m.id}`).update({ models });
  const copyModels = (m) => (m.models || []).map((x) => ({ name: x.name, ecms: [...(x.ecms || [])] }));
  f.vehicle.onchange = async () => {
    if (f.vehicle.value !== ADD) return (f.vehicle.dataset.prev = f.vehicle.value);
    const name = askNew(f.vehicle, fillVehicle);
    if (!name) return;
    const v = sameName(S.vehicleMakes, name) || name;
    if (v === name) await db.doc("lists/vehicle_makes").set({ items: [...S.vehicleMakes, name] });
    fillVehicle(v);
    f.vehicle.dataset.prev = v;
  };
  f.make.onchange = async () => {
    const refill = (v) => fill(f.make, keep(S.engines.map((m) => m.name), v), v, "Choose make");
    if (f.make.value === ADD) {
      const name = askNew(f.make, refill);
      if (!name) return;
      const v = sameName(S.engines.map((m) => m.name), name) || name;
      if (v === name) {
        await db.collection("engine_makes").add({ name, folder: name, file_prefix: name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase(), models: [] });
      }
      refill(v);
    }
    f.make.dataset.prev = f.make.value;
    fillModel("", "");
  };
  f.model.onchange = async () => {
    if (f.model.value === ADD) {
      const m = make();
      const name = askNew(f.model, (v) => fillModel(v, f.ecm.value));
      if (!name || !m) return;
      const list = copyModels(m);
      const v = sameName(list.map((x) => x.name), name) || name;
      if (v === name) await saveModels(m, [...list, { name, ecms: [] }]);
      fill(f.model, keep((make()?.models || []).map((x) => x.name), v), v, "Choose model");
    }
    f.model.dataset.prev = f.model.value;
    fillEcm("");
  };
  f.ecm.onchange = async () => {
    if (f.ecm.value !== ADD) return (f.ecm.dataset.prev = f.ecm.value);
    const m = make();
    const name = askNew(f.ecm, fillEcm);
    if (!name || !m || !model()) return;
    const list = copyModels(m);
    const entry = list.find((x) => x.name === f.model.value);
    const v = sameName(entry.ecms, name) || name;
    if (v === name) {
      entry.ecms.push(name);
      await saveModels(m, list);
    }
    fillEcm(v);
    f.ecm.dataset.prev = v;
  };

  filePicker(f.filesearch, $("#filechips"), files, 0, () => f.make.value);
  const drawOrig = filePicker(f.origsearch, $("#origchips"), origFiles, 1, () => f.make.value);

  $("#sf-cancel").onclick = closeDialog;
  if ($("#sf-skip")) $("#sf-skip").onclick = async () => { if (await dismissSession(s.id)) closeDialog(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#sf-err");
    err.textContent = "";
    const cat = byId(S.categories, f.category.value);
    const billable = f.billable.value;
    const newCust = custSel.value === "__new";
    if (!custSel.value) return (err.textContent = "Choose a customer.");
    if (newCust && !f.nc_name.value.trim()) return (err.textContent = "Enter the new customer's name.");
    if (!cat) return (err.textContent = "Choose a work category.");
    if (!billable) return (err.textContent = "Choose whether the job was billable.");
    if (cat.requires_issue && !f.original.value) return (err.textContent = `Choose the original job for ${cat.name}, or "Done before job tracking started".`);
    if (cat.requires_issue && !f.issue.value.trim()) return (err.textContent = `Describe the issue for ${cat.name}.`);
    const pre = cat.requires_issue && f.original.value === PRE;

    const batch = db.batch();
    let customerId = custSel.value;
    if (newCust) {
      const ref = db.collection("customers").doc();
      customerId = ref.id;
      batch.set(ref, {
        name: f.nc_name.value.trim(), company: f.nc_company.value.trim(), phone: f.nc_phone.value.trim(),
        email: f.nc_email.value.trim(), notes: "", created_at: FieldValue.serverTimestamp(),
      });
    }
    const done = { completed_at: FieldValue.serverTimestamp(), completed_by: S.user.email };
    batch.update(db.doc(`sessions/${s.id}`), {
      customer_id: customerId,
      category_id: cat.id,
      category_name: cat.name,
      billable: billable === "yes",
      warranty_issue: cat.requires_issue ? f.issue.value.trim() : "",
      original_job_id: cat.requires_issue && !pre ? f.original.value : null,
      original_job_pre_tracking: pre,
      original_job_note: pre ? f.original_note.value.trim() : "",
      vehicle_make: f.vehicle.value,
      engine_make: f.make.value,
      engine_model: f.model.value,
      ecm_type: f.ecm.value,
      files,
      file_ids: files.map((x) => x.file_id),
      original_file: asksOriginalFile(cat) ? origFiles[0] || null : null,
      notes: f.notes.value.trim(),
      status: "complete",
      ...done,
    });
    const linking = device && !device.customer_id && f.link?.checked;
    if (linking) batch.update(db.doc(`devices/${device.id}`), { customer_id: customerId });
    // A technician's file transfer or terminal window is its own connection; fold any that
    // overlapped this session on the same computer into this job.
    const start = (toDate(s.started_at)?.getTime() ?? 0) - 60000;
    const end = (toDate(s.ended_at)?.getTime() ?? Date.now()) + 60000;
    for (const o of S.queue) {
      if (o.id === s.id || o.rustdesk_id !== s.rustdesk_id) continue;
      const os = toDate(o.started_at)?.getTime() ?? 0;
      const oe = toDate(o.ended_at)?.getTime() ?? os;
      if (os <= end && oe >= start) {
        batch.update(db.doc(`sessions/${o.id}`), { status: "merged", merged_into: s.id, customer_id: customerId, ...done });
      } else if (linking && !o.customer_id) {
        batch.update(db.doc(`sessions/${o.id}`), { customer_id: customerId });
      }
    }
    $("#sf-save").disabled = true;
    try {
      await batch.commit();
      closeDialog();
      if (location.hash.startsWith("#session=")) history.replaceState(null, "", `#${S.view}`);
    } catch (e2) {
      err.textContent = e2.message;
      $("#sf-save").disabled = false;
    }
  };
}

function keepList(list, v) {
  return v && !list.includes(v) ? [v, ...list] : list;
}

// Searchable X: drive file list that adds picks to `picked` as chips. `max` 0 means no
// limit; with 1, a new pick replaces the old one. Returns a function that redraws the chips.
function filePicker(search, chips, picked, max, currentMake) {
  const list = search.parentElement.querySelector(".picker-list");
  const draw = () => {
    chips.innerHTML = picked.map((x, i) => `<span class="chip">${esc(x.file_id)} · ${esc(x.name)}<button type="button" data-i="${i}" title="Remove">×</button></span>`).join("");
    $$("button", chips).forEach((b) => (b.onclick = () => { picked.splice(+b.dataset.i, 1); draw(); }));
  };
  draw();
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { list.hidden = true; return; }
    const mk = currentMake();
    const hits = S.files.filter((x) => !picked.some((y) => y.file_id === x.file_id) &&
      (x.file_id.toLowerCase().includes(q) || x.path.toLowerCase().includes(q)))
      .sort((a, b) => (b.make === mk) - (a.make === mk)).slice(0, 12);
    list.innerHTML = hits.length
      ? hits.map((x) => `<div data-id="${esc(x.file_id)}"><b>${esc(x.file_id)}</b> ${esc(x.name)} <span class="muted small">${esc(x.folder)}</span></div>`).join("")
      : `<div class="muted">No matching files</div>`;
    list.hidden = false;
    $$("[data-id]", list).forEach((d) => (d.onclick = () => {
      const x = S.files.find((y) => y.file_id === d.dataset.id);
      if (max && picked.length >= max) picked.splice(0, picked.length);
      picked.push({ file_id: x.file_id, name: x.name, path: x.path });
      search.value = "";
      list.hidden = true;
      draw();
    }));
  };
  search.onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
  return draw;
}

// Categories made before this setting existed fall back to asking for Warranty and Tune revision.
function asksOriginalFile(c) {
  return !!c && (c.asks_original_file ?? /^(warranty|tune revision)$/i.test(c.name));
}

// ---------- sessions ----------
VIEWS.sessions = {
  shell: () => {
    const fl = S.filters.sessions;
    return `<div class="row"><h1>Sessions</h1><span class="spacer"></span><button class="btn ghost small" id="csv">Export CSV</button></div>
    <div class="card grid">
      <label>Search<input id="fq" value="${esc(fl.q)}" placeholder="Customer, computer, file ID, notes…"></label>
      <label>Category<select id="fc">${options(S.categories.map((c) => ({ value: c.id, label: c.name })), fl.category, "All")}</select></label>
      <label>Billable<select id="fb">${options([{ value: "yes", label: "Billable" }, { value: "no", label: "Not billable" }], fl.billable, "All")}</select></label>
      <label>Status<select id="fs">${options([
        { value: "complete", label: "Completed jobs" }, { value: "needs_details", label: "Needs details" },
        { value: "active", label: "In progress" }, { value: "all", label: "Everything" },
      ], fl.status)}</select></label>
    </div>
    <div id="vb"></div>`;
  },
  bind() {
    const fl = S.filters.sessions;
    $("#fq").oninput = (e) => { fl.q = e.target.value; this.body(); };
    $("#fc").onchange = (e) => { fl.category = e.target.value; this.body(); };
    $("#fb").onchange = (e) => { fl.billable = e.target.value; this.body(); };
    $("#fs").onchange = (e) => { fl.status = e.target.value; this.body(); };
    $("#csv").onclick = () => exportCsv(this.rows());
  },
  rows() {
    const fl = S.filters.sessions;
    const q = fl.q.trim().toLowerCase();
    return S.sessions.filter((s) => {
      if (fl.status === "active" ? !["active", "connecting"].includes(s.status) : fl.status !== "all" && s.status !== fl.status) return false;
      if (fl.status === "all" && ["not_authorized", "merged"].includes(s.status)) return false;
      if (fl.category && s.category_id !== fl.category) return false;
      if (fl.billable && s.billable !== (fl.billable === "yes")) return false;
      if (!q) return true;
      return [customerName(s.customer_id), deviceLabel(s.rustdesk_id), s.technician_name, s.notes, s.warranty_issue,
        s.vehicle_make, s.engine_make, s.engine_model, s.ecm_type, ...(s.file_ids || []), s.original_file?.file_id].join(" ").toLowerCase().includes(q);
    });
  },
  body() {
    const vb = $("#vb");
    if (!vb) return;
    const rows = this.rows();
    if (!rows.length) { vb.innerHTML = `<div class="card empty">No sessions match.</div>`; return; }
    vb.innerHTML = `<div class="card table-wrap"><table>
      <tr><th>Started</th><th>Length</th><th>Customer</th><th class="hide-sm">Computer</th><th>Category</th><th>Billable</th><th class="hide-sm">Vehicle / engine</th><th class="hide-sm">File</th><th class="hide-sm">Tech</th></tr>
      ${rows.map((s) => `<tr class="click" data-id="${s.id}">
        <td>${esc(fmtDate(s.started_at))}</td><td>${esc(fmtDur(s.duration_sec))}</td>
        <td>${esc(customerName(s.customer_id))}</td><td class="hide-sm">${esc(deviceLabel(s.rustdesk_id))}</td>
        <td>${esc(categoryName(s.category_id) || s.category_name || "")}${s.status !== "complete" ? ` <span class="pill warn">${esc(s.status.replace("_", " "))}</span>` : ""}</td>
        <td>${s.billable === true ? `<span class="pill ok">Yes</span>` : s.billable === false ? `<span class="pill">No</span>` : ""}</td>
        <td class="hide-sm">${esc([s.vehicle_make, s.engine_make, s.engine_model, s.ecm_type].filter(Boolean).join(" / "))}</td>
        <td class="hide-sm">${esc((s.file_ids || []).join(", "))}</td>
        <td class="hide-sm">${esc(s.technician_name)}</td></tr>`).join("")}
    </table></div>
    <p class="muted small">Showing the latest ${S.sessions.length >= 1000 ? "1000 " : ""}sessions.</p>`;
    $$("tr[data-id]", vb).forEach((tr) => (tr.onclick = () => {
      const s = findSession(tr.dataset.id);
      if (["complete", "needs_details"].includes(s.status)) openSessionForm(s.id);
    }));
  },
};

function exportCsv(rows) {
  const cols = [
    ["Started", (s) => toDate(s.started_at)?.toISOString() || ""],
    ["Ended", (s) => toDate(s.ended_at)?.toISOString() || ""],
    ["Minutes", (s) => (s.duration_sec ? Math.round(s.duration_sec / 60) : "")],
    ["Customer", (s) => customerName(s.customer_id)],
    ["RustDesk ID", (s) => s.rustdesk_id],
    ["Computer", (s) => byId(S.devices, s.rustdesk_id)?.hostname || ""],
    ["Category", (s) => categoryName(s.category_id) || s.category_name || ""],
    ["Billable", (s) => (s.billable === true ? "Yes" : s.billable === false ? "No" : "")],
    ["Warranty issue", (s) => s.warranty_issue],
    ["Original file", (s) => s.original_file?.file_id || ""],
    ["Original job", (s) => (s.original_job_pre_tracking ? `Before tracking: ${s.original_job_note || ""}` : s.original_job_id ? toDate(findSession(s.original_job_id)?.started_at)?.toISOString() || s.original_job_id : "")],
    ["Vehicle make", (s) => s.vehicle_make],
    ["Engine make", (s) => s.engine_make], ["Engine model", (s) => s.engine_model], ["ECM", (s) => s.ecm_type],
    ["Files", (s) => (s.file_ids || []).join(" ")],
    ["Technician", (s) => s.technician_name], ["Notes", (s) => s.notes], ["Status", (s) => s.status],
  ];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => cell(c[0])).join(","), ...rows.map((s) => cols.map((c) => cell(c[1](s))).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `et-tuning-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ---------- customers ----------
VIEWS.customers = {
  shell: () => `<div class="row"><h1>Customers</h1><span class="spacer"></span><button class="btn small" id="addc">Add customer</button></div>
    <div class="card"><input id="cq" value="${esc(S.filters.customers)}" placeholder="Search customers"></div><div id="vb"></div>`,
  bind() {
    $("#addc").onclick = () => openCustomerForm(null);
    $("#cq").oninput = (e) => { S.filters.customers = e.target.value; this.body(); };
  },
  body() {
    const vb = $("#vb");
    if (!vb) return;
    const q = S.filters.customers.trim().toLowerCase();
    const rows = S.customers.filter((c) => !q || [c.name, c.company, c.phone, c.email].join(" ").toLowerCase().includes(q));
    if (!rows.length) { vb.innerHTML = `<div class="card empty">${S.customers.length ? "No customers match." : "No customers yet. Add one here, or from the job form after a session."}</div>`; return; }
    vb.innerHTML = `<div class="card table-wrap"><table>
      <tr><th>Name</th><th>Company</th><th class="hide-sm">Phone</th><th class="hide-sm">Email</th><th>Computers</th><th>Jobs</th></tr>
      ${rows.map((c) => `<tr class="click" data-id="${c.id}"><td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td class="hide-sm">${esc(c.phone)}</td><td class="hide-sm">${esc(c.email)}</td>
        <td>${S.devices.filter((d) => d.customer_id === c.id).length}</td>
        <td>${S.sessions.filter((s) => s.customer_id === c.id && s.status === "complete").length}</td></tr>`).join("")}
    </table></div>`;
    $$("tr[data-id]", vb).forEach((tr) => (tr.onclick = () => openCustomerForm(tr.dataset.id)));
  },
};

function openCustomerForm(id) {
  const c = id ? byId(S.customers, id) : {};
  const devices = id ? S.devices.filter((d) => d.customer_id === id) : [];
  const jobs = id ? S.sessions.filter((s) => s.customer_id === id && s.status === "complete").slice(0, 20) : [];
  openDialog(`<h2>${id ? "Customer" : "New customer"}</h2>
    <form id="cf"><div class="grid">
      <label>Name<input name="name" value="${esc(c.name)}" required></label>
      <label>Company<input name="company" value="${esc(c.company)}"></label>
      <label>Phone<input name="phone" value="${esc(c.phone)}"></label>
      <label>Email<input name="email" type="email" value="${esc(c.email)}"></label>
    </div>
    <label style="margin-top:12px">Notes<textarea name="notes">${esc(c.notes)}</textarea></label>
    ${id ? `<h3>Computers</h3>${devices.length ? devices.map((d) => `<div class="small">${esc(deviceLabel(d.id))} <span class="muted">${esc(d.os || "")}</span></div>`).join("") : `<p class="muted small">None linked yet. Link one from the job form or the Devices tab.</p>`}
      <h3>Recent jobs</h3>${jobs.length ? jobs.map((s) => `<div class="small">${esc(fmtDate(s.started_at))} · ${esc(categoryName(s.category_id) || s.category_name)} · ${s.billable ? "billable" : "not billable"}${s.file_ids?.length ? ` · ${esc(s.file_ids.join(", "))}` : ""}</div>`).join("") : `<p class="muted small">No jobs yet.</p>`}` : ""}
    <p class="err" id="cf-err"></p>
    <div class="row"><span class="spacer"></span><button type="button" class="btn ghost" id="cf-cancel">Cancel</button><button class="btn">Save</button></div></form>`);
  $("#cf-cancel").onclick = closeDialog;
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = { name: f.name.value.trim(), company: f.company.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(), notes: f.notes.value.trim() };
    try {
      if (id) await db.doc(`customers/${id}`).update(data);
      else await db.collection("customers").add({ ...data, created_at: FieldValue.serverTimestamp() });
      closeDialog();
    } catch (e2) {
      $("#cf-err").textContent = e2.message;
    }
  };
}

// ---------- devices ----------
VIEWS.devices = {
  shell: () => `<h1>Computers</h1>
    <p class="muted small">Every computer running ET Tuning Remote that reported in. Link each one to its customer once, and its sessions fill the customer in by themselves.</p>
    <div class="card"><input id="dq" value="${esc(S.filters.devices)}" placeholder="Search by ID, computer name or customer"></div><div id="vb"></div>`,
  bind() {
    $("#dq").oninput = (e) => { S.filters.devices = e.target.value; this.body(); };
  },
  body() {
    const vb = $("#vb");
    if (!vb) return;
    const q = S.filters.devices.trim().toLowerCase();
    const rows = S.devices
      .filter((d) => !q || [d.id, d.hostname, d.label, d.username, customerName(d.customer_id)].join(" ").toLowerCase().includes(q))
      .sort((a, b) => !!a.customer_id - !!b.customer_id || (toDate(b.last_seen) || 0) - (toDate(a.last_seen) || 0));
    if (!rows.length) { vb.innerHTML = `<div class="card empty">${S.devices.length ? "No computers match." : "No computers have reported in yet."}</div>`; return; }
    const custOpts = S.customers.map((c) => ({ value: c.id, label: c.name }));
    vb.innerHTML = `<div class="card table-wrap"><table>
      <tr><th>RustDesk ID</th><th>Computer</th><th class="hide-sm">Windows user</th><th>Customer</th><th class="hide-sm">Label</th><th class="hide-sm">Last seen</th></tr>
      ${rows.map((d) => `<tr><td>${esc(d.id)}</td><td>${esc(d.hostname)}<div class="muted small">${esc(d.os || "")}</div></td>
        <td class="hide-sm">${esc(d.username)}</td>
        <td><select data-cust="${esc(d.id)}">${options(custOpts, d.customer_id || "", "Not linked")}</select></td>
        <td class="hide-sm"><input data-label="${esc(d.id)}" value="${esc(d.label)}" placeholder="e.g. Shop laptop"></td>
        <td class="hide-sm">${esc(fmtDate(d.last_seen))}</td></tr>`).join("")}
    </table></div>`;
    $$("[data-cust]", vb).forEach((s) => (s.onchange = () => db.doc(`devices/${s.dataset.cust}`).update({ customer_id: s.value || null })));
    $$("[data-label]", vb).forEach((i) => (i.onchange = () => db.doc(`devices/${i.dataset.label}`).update({ label: i.value.trim() })));
  },
};

// ---------- files ----------
VIEWS.files = {
  shell: () => `<h1>X: drive files</h1>
    <p class="muted small">Files put in an engine make's folder under Files on the X: drive (e.g. <code>Files\\Cummins\\6.7L\\CM2350B</code>) get an ID for that make added to their name, e.g. <code>Stage 2_CUM-00042.bin</code>. Pick it on the job form to record which file a job used. Other folders, such as Software and Uploads, don't get IDs.</p>
    <div class="card"><input id="fq2" value="${esc(S.filters.files)}" placeholder="Search by file ID, name or folder"></div><div id="vb"></div>`,
  bind() {
    $("#fq2").oninput = (e) => { S.filters.files = e.target.value; this.body(); };
  },
  body() {
    const vb = $("#vb");
    if (!vb) return;
    const q = S.filters.files.trim().toLowerCase();
    const rows = S.files.filter((x) => !q || `${x.file_id} ${x.path} ${x.make}`.toLowerCase().includes(q)).slice(0, 500);
    if (!rows.length) { vb.innerHTML = `<div class="card empty">${S.files.length ? "No files match." : "No files have IDs yet."}</div>`; return; }
    vb.innerHTML = `<div class="card table-wrap"><table>
      <tr><th>ID</th><th>File</th><th>Make</th><th class="hide-sm">Folder</th><th class="hide-sm">Size</th><th class="hide-sm">Added</th><th>Jobs</th></tr>
      ${rows.map((x) => `<tr><td><b>${esc(x.file_id)}</b></td><td>${esc(x.name)}</td><td>${esc(x.make)}</td><td class="hide-sm">${esc(x.folder)}</td>
        <td class="hide-sm">${esc(fmtSize(x.size))}</td><td class="hide-sm">${esc(fmtDate(x.uploaded_at))}</td>
        <td>${S.sessions.filter((s) => s.file_ids?.includes(x.file_id)).length || ""}</td></tr>`).join("")}
    </table></div>`;
  },
};

// ---------- lists ----------
VIEWS.settings = {
  shell: () => `<h1>Lists</h1>
    <div class="card"><div class="row"><h2>Work categories</h2><span class="spacer"></span><button class="btn small" id="addcat">Add category</button></div>
      <p class="muted small">"Asks for issue" shows the original-job and issue boxes on the job form, as Warranty does. "Asks for original file" shows a picker for the file the earlier tune used, as Warranty and Tune revision do. Turning a category off hides it from new jobs but keeps old ones.</p>
      <div id="cats"></div></div>
    <div class="card"><div class="row"><h2>Vehicle makes</h2><span class="spacer"></span><button class="btn small" id="savevm">Save</button></div>
      <p class="muted small">One per line.</p>
      <textarea id="vmakes" rows="6"></textarea></div>
    <div class="card"><div class="row"><h2>Engines</h2><span class="spacer"></span><button class="btn small" id="addmake">Add make</button></div>
      <p class="muted small">Each make lists its engine models, and each model its ECM types; the job form offers them in that order. Model and ECM changes save as you make them; Save stores the make's name, X: drive folder and file ID prefix. The folder is where this make's tune files go under Files on the X: drive, and the prefix starts their IDs. Adding a make, model or ECM type creates its folder there (Files\\Make\\Model\\ECM); removing one leaves the folder alone. Changing a prefix only affects files added afterwards.</p>
      <div id="makes"></div></div>`,
  bind() {
    $("#addcat").onclick = async () => {
      const name = prompt("Category name");
      if (name?.trim()) await db.collection("work_categories").add({ name: name.trim(), requires_issue: false, active: true, order: S.categories.length });
    };
    $("#savevm").onclick = async () => {
      const items = [...new Set($("#vmakes").value.split("\n").map((x) => x.trim()).filter(Boolean))];
      await db.doc("lists/vehicle_makes").set({ items });
    };
    $("#addmake").onclick = async () => {
      const name = prompt("Engine make");
      if (!name?.trim()) return;
      const prefix = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
      await db.collection("engine_makes").add({ name: name.trim(), folder: name.trim(), file_prefix: prefix, models: [] });
    };
  },
  body() {
    const cats = $("#cats");
    if (!cats) return;
    cats.innerHTML = `<table><tr><th>Name</th><th>Asks for issue</th><th>Asks for original file</th><th>In use</th></tr>
      ${S.categories.map((c) => `<tr><td><input data-cname="${c.id}" value="${esc(c.name)}"></td>
        <td><input type="checkbox" data-cissue="${c.id}"${c.requires_issue ? " checked" : ""}></td>
        <td><input type="checkbox" data-corig="${c.id}"${asksOriginalFile(c) ? " checked" : ""}></td>
        <td><input type="checkbox" data-cactive="${c.id}"${c.active !== false ? " checked" : ""}></td></tr>`).join("")}</table>`;
    $$("[data-cname]", cats).forEach((i) => (i.onchange = () => i.value.trim() && db.doc(`work_categories/${i.dataset.cname}`).update({ name: i.value.trim() })));
    $$("[data-cissue]", cats).forEach((i) => (i.onchange = () => db.doc(`work_categories/${i.dataset.cissue}`).update({ requires_issue: i.checked })));
    $$("[data-corig]", cats).forEach((i) => (i.onchange = () => db.doc(`work_categories/${i.dataset.corig}`).update({ asks_original_file: i.checked })));
    $$("[data-cactive]", cats).forEach((i) => (i.onchange = () => db.doc(`work_categories/${i.dataset.cactive}`).update({ active: i.checked })));

    const vm = $("#vmakes");
    if (document.activeElement !== vm) vm.value = S.vehicleMakes.join("\n");

    const makes = $("#makes");
    // Don't redraw while someone is typing in one of the boxes.
    if (document.activeElement?.tagName === "INPUT" && makes.contains(document.activeElement)) return;
    makes.innerHTML = S.engines.map((m) => `<div class="card" style="background:var(--panel2)">
        <div class="row"><label>Make<input data-mname="${m.id}" value="${esc(m.name)}"></label>
          <label>X: drive folder<input data-mfolder="${m.id}" value="${esc(m.folder ?? m.name)}"></label>
          <label style="max-width:120px">File ID prefix<input data-mprefix="${m.id}" value="${esc(m.file_prefix ?? "")}" maxlength="6"></label><span class="spacer"></span>
          <button class="btn ghost small" data-mdel="${m.id}">Delete make</button><button class="btn small" data-msave="${m.id}">Save</button></div>
        <table style="margin-top:8px"><tr><th style="width:34%">Engine model</th><th>ECM types</th><th></th></tr>
        ${(m.models || []).map((x, i) => `<tr>
          <td><input data-model="${m.id}:${i}" value="${esc(x.name)}"></td>
          <td><div class="chips" style="margin:0 0 6px">${(x.ecms || []).map((e, j) => `<span class="chip">${esc(e)}<button type="button" data-ecmdel="${m.id}:${i}:${j}" title="Remove ${esc(e)}">×</button></span>`).join("") || `<span class="muted small">None yet</span>`}</div>
            <div class="row"><input data-ecmnew="${m.id}:${i}" placeholder="New ECM type" style="max-width:200px"><button class="btn ghost small" data-ecmadd="${m.id}:${i}">Add ECM</button></div></td>
          <td><button class="btn ghost small" data-modeldel="${m.id}:${i}">Remove model</button></td></tr>`).join("")}
        <tr><td><input data-modelnew="${m.id}" placeholder="New engine model"></td><td colspan="2"><button class="btn ghost small" data-modeladd="${m.id}">Add model</button></td></tr>
        </table>
      </div>`).join("") || `<p class="muted">No engines yet.</p>`;

    const make = (id) => S.engines.find((x) => x.id === id);
    const models = (id) => (make(id)?.models || []).map((x) => ({ name: x.name, ecms: [...(x.ecms || [])] }));
    const save = async (id, list) => {
      document.activeElement?.blur();
      await db.doc(`engine_makes/${id}`).update({ models: list });
      VIEWS.settings.body();
    };
    const parts = (v) => v.split(":").map((x, k) => (k ? Number(x) : x));
    const onEnter = (input, button) => (input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); button.click(); } });

    $$("[data-modeladd]", makes).forEach((b) => {
      const id = b.dataset.modeladd;
      const input = $(`[data-modelnew="${id}"]`, makes);
      onEnter(input, b);
      b.onclick = () => {
        const name = input.value.trim();
        if (!name) return;
        const list = models(id);
        if (list.some((x) => x.name === name)) return alert(`${name} is already listed.`);
        save(id, [...list, { name, ecms: [] }]);
      };
    });
    $$("[data-model]", makes).forEach((input) => (input.onchange = () => {
      const [id, i] = parts(input.dataset.model);
      const name = input.value.trim();
      if (!name) return;
      const list = models(id);
      list[i].name = name;
      save(id, list);
    }));
    $$("[data-modeldel]", makes).forEach((b) => (b.onclick = () => {
      const [id, i] = parts(b.dataset.modeldel);
      const list = models(id);
      if (!confirm(`Remove ${list[i].name} and its ECM types? Jobs that already used it keep their values.`)) return;
      list.splice(i, 1);
      save(id, list);
    }));
    $$("[data-ecmadd]", makes).forEach((b) => {
      const key = b.dataset.ecmadd;
      const input = $(`[data-ecmnew="${key}"]`, makes);
      onEnter(input, b);
      b.onclick = () => {
        const [id, i] = parts(key);
        const ecm = input.value.trim();
        if (!ecm) return;
        const list = models(id);
        if (list[i].ecms.includes(ecm)) return alert(`${ecm} is already listed.`);
        list[i].ecms.push(ecm);
        save(id, list);
      };
    });
    $$("[data-ecmdel]", makes).forEach((b) => (b.onclick = () => {
      const [id, i, j] = parts(b.dataset.ecmdel);
      const list = models(id);
      list[i].ecms.splice(j, 1);
      save(id, list);
    }));
    $$("[data-msave]", makes).forEach((b) => (b.onclick = async () => {
      const id = b.dataset.msave;
      const name = $(`[data-mname="${id}"]`, makes).value.trim();
      const folder = $(`[data-mfolder="${id}"]`, makes).value.trim() || name;
      const prefix = $(`[data-mprefix="${id}"]`, makes).value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!name) return;
      if (prefix.length < 2) { alert("The file ID prefix needs 2 to 6 letters or numbers."); return; }
      if (S.engines.some((x) => x.id !== id && x.file_prefix === prefix)) { alert(`Another make already uses ${prefix}.`); return; }
      await db.doc(`engine_makes/${id}`).update({ name, folder, file_prefix: prefix });
      b.blur();
      VIEWS.settings.body();
    }));
    $$("[data-mdel]", makes).forEach((b) => (b.onclick = async () => {
      if (confirm("Delete this make and its models? Jobs that already used it keep their values.")) await db.doc(`engine_makes/${b.dataset.mdel}`).delete();
    }));
  },
};

// ---------- dialog ----------
function openDialog(html) {
  $("#dlg-body").innerHTML = html;
  const d = $("#dlg");
  if (!d.open) d.showModal();
}
function closeDialog() {
  $("#dlg").close();
}
