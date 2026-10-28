// Receives the session reports ET Tuning Remote clients send to their API server.
// Firebase Hosting rewrites /api/audit/conn and /api/sysinfo here; every other
// /api path the client tries (heartbeat, address book, login) gets Hosting's 404,
// which the client handles, so idle heartbeats never start this function.
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { BadRequest, parseConnEvent, applyConnEvent, parseSysinfo } = require("./events");

initializeApp();
const db = getFirestore();

exports.api = onRequest(
  { region: "us-central1", memory: "256MiB", maxInstances: 5, concurrency: 40 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("");
      return;
    }
    try {
      const body = parseBody(req);
      if (req.path === "/api/audit/conn") {
        await handleConn(body);
        res.status(200).send("");
      } else if (req.path === "/api/sysinfo") {
        await handleSysinfo(body);
        // Tells the client to stop re-sending until its sysinfo changes.
        res.status(200).send("SYSINFO_UPDATED");
      } else {
        res.status(404).send("");
      }
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).send(err.message);
      } else {
        logger.error("request failed", { path: req.path, err: String(err) });
        res.status(500).send("");
      }
    }
  },
);

function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(req.rawBody ? req.rawBody.toString("utf8") : "");
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

async function handleConn(body) {
  const ev = parseConnEvent(body);
  const now = Timestamp.now();
  const eventRef = ev.nonce ? db.doc(`conn_events/${ev.nonce}`) : db.collection("conn_events").doc();
  const openRef = db.doc(`open_conns/${ev.connKey}`);
  const deviceRef = db.doc(`devices/${ev.id}`);
  await db.runTransaction(async (tx) => {
    const [eventSnap, openSnap, deviceSnap] = await tx.getAll(eventRef, openRef, deviceRef);
    // The client retries a post it thinks failed; the nonce makes that a no-op.
    if (eventSnap.exists) return;
    let openSessionRef = null;
    let open = null;
    if (openSnap.exists) {
      openSessionRef = db.doc(`sessions/${openSnap.get("session_id")}`);
      const s = await tx.get(openSessionRef);
      open = s.exists ? s.data() : null;
    }
    const customerId = deviceSnap.exists ? deviceSnap.get("customer_id") || null : null;
    const out = applyConnEvent(open, ev, now, customerId);

    tx.create(eventRef, { ...body, kind: ev.kind, received_at: now });
    tx.set(
      deviceRef,
      deviceSnap.exists
        ? { uuid: ev.uuid, last_seen: now }
        : { rustdesk_id: ev.id, uuid: ev.uuid, customer_id: null, label: "", first_seen: now, last_seen: now },
      { merge: true },
    );
    if (out.stale && openSessionRef) tx.set(openSessionRef, out.stale);
    if (out.session) {
      const ref = out.isNew ? db.collection("sessions").doc() : openSessionRef;
      tx.set(ref, out.session);
      if (out.open === "set") tx.set(openRef, { session_id: ref.id, created_at: now });
    }
    if (out.open === "delete") tx.delete(openRef);
  });
}

async function handleSysinfo(body) {
  const { id, fields } = parseSysinfo(body);
  await db.doc(`devices/${id}`).set(
    { ...fields, sysinfo_at: FieldValue.serverTimestamp(), last_seen: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

const { onObjectFinalized, onObjectDeleted } = require("firebase-functions/v2/storage");
const { getStorage } = require("firebase-admin/storage");
const { XDRIVE_BUCKET, registerFile, renameToId, markDeleted } = require("./files");

exports.xdriveFileAdded = onObjectFinalized(
  { bucket: XDRIVE_BUCKET, region: "us-central1", memory: "256MiB" },
  async (event) => {
    const reg = await registerFile(db, event.data);
    if (reg?.renameTo) await renameToId(getStorage().bucket(event.data.bucket), event.data, reg.id, reg.renameTo);
  },
);

exports.xdriveFileDeleted = onObjectDeleted(
  { bucket: XDRIVE_BUCKET, region: "us-central1", memory: "256MiB" },
  async (event) => markDeleted(db, event.data),
);
