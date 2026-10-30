// "Don't log this session": removes the session and everything recorded about its
// connection (the raw events, the open-connection pointer and its screenshots),
// leaving no record.
const crypto = require("crypto");
const { deleteScreenshots } = require("./screenshots");

// Jobs already saved can't be removed this way.
const FORGETTABLE = ["connecting", "active", "needs_details", "not_authorized", "dismissed"];

async function forgetSessions(db, ids, shotBucket) {
  let removed = 0;
  for (const id of ids) {
    const ref = db.doc(`sessions/${id}`);
    const snap = await ref.get();
    if (!snap.exists || !FORGETTABLE.includes(snap.get("status"))) continue;
    const s = snap.data();
    const uuidHash = crypto.createHash("sha256").update(s.device_uuid || "").digest("hex").slice(0, 16);
    const openRef = db.doc(`open_conns/${s.rustdesk_id}_${uuidHash}_${s.conn_id}`);
    // conn_id restarts when the client does, so only this session's time span counts.
    const from = (s.started_at?.toMillis() ?? 0) - 10000;
    const to = (s.ended_at?.toMillis() ?? Date.now()) + 10000;
    const events = await db.collection("conn_events")
      .where("id", "==", s.rustdesk_id).where("conn_id", "==", s.conn_id).get();
    const batch = db.batch();
    batch.delete(ref);
    const open = await openRef.get();
    if (open.exists && open.get("session_id") === id) batch.delete(openRef);
    for (const e of events.docs) {
      const at = e.get("received_at")?.toMillis() ?? 0;
      if (at >= from && at <= to) batch.delete(e.ref);
    }
    await batch.commit();
    if (shotBucket) await deleteScreenshots(db, shotBucket, id);
    removed++;
  }
  return removed;
}

module.exports = { forgetSessions };
