// Screenshots a technician takes during a remote session (toolbar > Take screenshot)
// are uploaded by ET Tuning Remote and kept with that session's job. The images live
// in their own private bucket; the dashboard fetches them through the api function.
const { Timestamp } = require("firebase-admin/firestore");
const { BadRequest } = require("./events");

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PER_SESSION = 100;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function screenshotBucket(project) {
  return `${project}-job-screenshots`;
}

// The session in progress on that computer. Screenshots come from remote desktop, so
// that connection wins over a file transfer or terminal open at the same time.
async function liveSession(db, rustdeskId) {
  const snap = await db.collection("sessions")
    .where("rustdesk_id", "==", rustdeskId).where("status", "in", ["connecting", "active"]).get();
  const [first] = snap.docs.sort((a, b) =>
    (a.get("conn_type") || 0) - (b.get("conn_type") || 0) ||
    (b.get("started_at")?.toMillis() ?? 0) - (a.get("started_at")?.toMillis() ?? 0));
  return first || null;
}

async function saveScreenshot(db, bucket, rustdeskId, data) {
  if (!/^[\w-]{1,64}$/.test(rustdeskId || "")) throw new BadRequest("bad id");
  if (!data?.length || data.length > MAX_BYTES || !data.subarray(0, 8).equals(PNG)) throw new BadRequest("not a PNG");
  const session = await liveSession(db, rustdeskId);
  if (!session) throw new BadRequest("no session in progress");
  const count = await db.collection("screenshots").where("session_id", "==", session.id).count().get();
  if (count.data().count >= MAX_PER_SESSION) throw new BadRequest("too many screenshots");
  const ref = db.collection("screenshots").doc();
  const path = `sessions/${session.id}/${ref.id}.png`;
  await bucket.file(path).save(data, { resumable: false, contentType: "image/png" });
  await ref.set({ session_id: session.id, rustdesk_id: rustdeskId, path, size: data.length, taken_at: Timestamp.now() });
  return { id: ref.id, session_id: session.id };
}

async function readScreenshot(db, bucket, id) {
  if (!/^[\w-]{1,64}$/.test(id || "")) throw new BadRequest("bad id");
  const snap = await db.doc(`screenshots/${id}`).get();
  if (!snap.exists) throw new BadRequest("not found");
  const [data] = await bucket.file(snap.get("path")).download();
  return data;
}

// Used by "Don't log": the session's screenshots go with it.
async function deleteScreenshots(db, bucket, sessionId) {
  const snap = await db.collection("screenshots").where("session_id", "==", sessionId).get();
  for (const d of snap.docs) {
    await bucket.file(d.get("path")).delete({ ignoreNotFound: true });
    await d.ref.delete();
  }
}

module.exports = { screenshotBucket, saveScreenshot, readScreenshot, deleteScreenshots };
