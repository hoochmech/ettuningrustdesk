// Pure parsing and state logic for the events the ET Tuning client posts.
// The client side is src/server/connection.rs (post_conn_audit) and
// src/hbbs_http/sync.rs (sysinfo). Kept free of Firestore so it can be tested.
const crypto = require("crypto");

class BadRequest extends Error {}

const CONN_TYPES = ["Remote desktop", "File transfer", "Port forward", "View camera", "Terminal"];

function str(v, max) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" && typeof v !== "number") throw new BadRequest("bad field");
  return String(v).slice(0, max);
}

function int(v) {
  return Number.isInteger(v) ? v : null;
}

function deviceIds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be an object");
  const id = str(body.id, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequest("bad id");
  const uuid = str(body.uuid, 256);
  return { id, uuid };
}

// The client sends three records per connection, in order:
//   {action: "new", ip}                     connection accepted, not yet logged in
//   {peer: [tech_id, tech_name], type}      logged in
//   {action: "close"}                       connection ended
function parseConnEvent(body) {
  const { id, uuid } = deviceIds(body);
  const connId = int(body.conn_id);
  if (connId === null) throw new BadRequest("bad conn_id");
  let kind = "other";
  if (body.action === "new") kind = "new";
  else if (body.action === "close") kind = "close";
  else if (Array.isArray(body.peer)) kind = "authorized";
  const nonce = str(body.nonce, 64);
  const uuidHash = crypto.createHash("sha256").update(uuid).digest("hex").slice(0, 16);
  const ev = {
    kind,
    id,
    uuid,
    connId,
    nonce: /^[A-Za-z0-9-]{8,64}$/.test(nonce) ? nonce : "",
    connKey: `${id}_${uuidHash}_${connId}`,
  };
  if (kind === "new") ev.ip = str(body.ip, 64);
  if (kind === "authorized") {
    ev.technicianId = str(body.peer[0], 64);
    ev.technicianName = str(body.peer[1], 128);
    ev.connType = int(body.type);
  }
  return ev;
}

// Given the open session for this connection (or null) and an event, returns
// what to write: `session` is the full new session data (null = write nothing),
// `isNew` says it is a new session doc, `open` is "set", "delete" or "keep" for
// the open-connection pointer, and `stale` is the data to finish an old session
// whose close never arrived.
function applyConnEvent(open, ev, now, customerId) {
  const result = { session: null, isNew: false, open: "keep", stale: null };
  if (ev.kind === "new") {
    if (open) result.stale = finish(open, null, "no_close_event");
    result.session = {
      rustdesk_id: ev.id,
      device_uuid: ev.uuid,
      conn_id: ev.connId,
      ip: ev.ip || "",
      started_at: now,
      authorized_at: null,
      ended_at: null,
      duration_sec: null,
      technician_id: "",
      technician_name: "",
      conn_type: null,
      conn_type_name: "",
      status: "connecting",
      customer_id: customerId || null,
      category_id: null,
      billable: null,
      warranty_issue: "",
      original_job_id: null,
      original_job_pre_tracking: false,
      original_job_note: "",
      original_file: null,
      vehicle_make: "",
      engine_make: "",
      engine_model: "",
      ecm_type: "",
      notes: "",
      completed_at: null,
      completed_by: "",
    };
    result.isNew = true;
    result.open = "set";
    return result;
  }
  if (!open) return result;
  if (ev.kind === "authorized") {
    result.session = {
      ...open,
      authorized_at: now,
      technician_id: ev.technicianId,
      technician_name: ev.technicianName,
      conn_type: ev.connType,
      conn_type_name: CONN_TYPES[ev.connType] || "",
      status: "active",
    };
  } else if (ev.kind === "close") {
    result.session = finish(open, now, "closed");
    result.open = "delete";
  }
  return result;
}

function finish(session, endedAt, reason) {
  const started = toMillis(session.started_at);
  const ended = toMillis(endedAt);
  return {
    ...session,
    ended_at: endedAt,
    end_reason: reason,
    duration_sec: started !== null && ended !== null ? Math.max(0, Math.round((ended - started) / 1000)) : null,
    // The job form can be filled in while the session is still open; keep that result.
    status: ["complete", "dismissed", "merged"].includes(session.status)
      ? session.status
      : session.authorized_at ? "needs_details" : "not_authorized",
  };
}

function toMillis(t) {
  if (t === null || t === undefined) return null;
  if (t instanceof Date) return t.getTime();
  if (typeof t.toMillis === "function") return t.toMillis();
  return null;
}

function parseSysinfo(body) {
  const { id, uuid } = deviceIds(body);
  return {
    id,
    fields: {
      rustdesk_id: id,
      uuid,
      hostname: str(body.hostname, 128),
      username: str(body.username, 128),
      os: str(body.os, 256),
      cpu: str(body.cpu, 256),
      memory: str(body.memory, 32),
      client_version: str(body.version, 32),
    },
  };
}

module.exports = { BadRequest, parseConnEvent, applyConnEvent, parseSysinfo };
