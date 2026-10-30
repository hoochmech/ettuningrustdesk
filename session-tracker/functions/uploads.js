// Files a customer adds to X:\Uploads during a session. Each one is linked to the session
// in progress, and once that job is saved it is renamed with the job's details in front:
// "Uploads/log.bin" -> "Uploads/Smith Trucking_ISX15_CM871_2026-10-30_log.bin".
//
// The customer's drive writes with a shared account, so an upload doesn't say which
// computer it came from. The X: drive is only mounted during a remote desktop session,
// so it is linked to the one computer with such a session open (or just closed). With
// two computers connected at once it stays unlinked and keeps its name.
const { Timestamp } = require("firebase-admin/firestore");
const { folderName } = require("./files");

const UPLOADS = "uploads";
const RECENT_MS = 2 * 60 * 1000;
const TIME_ZONE = "America/Chicago";

function isUpload(path) {
  return path.split("/")[0].toLowerCase() === UPLOADS && !path.endsWith("/") && path.includes("/");
}

// "Smith Trucking", "ISX15", "CM871", 2026-10-30, "log.bin" -> "Smith Trucking_ISX15_CM871_2026-10-30_log.bin"
function uploadName(original, { customer, model, ecm, date }) {
  const day = date ? date.toLocaleDateString("en-CA", { timeZone: TIME_ZONE }) : "";
  const parts = [customer, model, ecm, day].map(folderName).filter(Boolean);
  return [...parts, original].join("_");
}

async function sessionAt(db, at) {
  const live = await db.collection("sessions").where("status", "in", ["connecting", "active"]).get();
  const ended = await db.collection("sessions").where("ended_at", ">=", Timestamp.fromMillis(at.toMillis() - RECENT_MS)).get();
  const desktop = [...live.docs, ...ended.docs].filter((d) => (d.get("conn_type") || 0) === 0 && d.get("status") !== "not_authorized");
  if (new Set(desktop.map((d) => d.get("rustdesk_id"))).size !== 1) return null;
  return desktop.sort((a, b) => (b.get("started_at")?.toMillis() ?? 0) - (a.get("started_at")?.toMillis() ?? 0))[0];
}

// `obj` is the Cloud Storage object from the bucket notification.
async function linkUpload(db, bucket, obj) {
  if (!isUpload(obj.name)) return null;
  // Our own rename landing.
  const mine = await db.collection("uploads").where("path", "==", obj.name).limit(1).get();
  const moving = await db.collection("uploads").where("renaming_to", "==", obj.name).limit(1).get();
  if (!mine.empty || !moving.empty) return null;
  const at = obj.timeCreated ? Timestamp.fromDate(new Date(obj.timeCreated)) : Timestamp.now();
  const session = await sessionAt(db, at);
  const slash = obj.name.lastIndexOf("/");
  const ref = db.collection("uploads").doc();
  await ref.set({
    path: obj.name,
    folder: obj.name.slice(0, slash),
    original_name: obj.name.slice(slash + 1),
    session_id: session?.id || null,
    rustdesk_id: session?.get("rustdesk_id") || null,
    size: Number(obj.size) || 0,
    uploaded_at: at,
  });
  // Uploaded after the job was already saved.
  if (session && ["complete", "merged"].includes(session.get("status"))) await renameSessionUploads(db, bucket, session.id);
  return ref.id;
}

// Gives the session's uploads their job-detail names. Runs again if the job is edited,
// always starting from the name the customer gave the file.
async function renameSessionUploads(db, bucket, sessionId) {
  let snap = await db.doc(`sessions/${sessionId}`).get();
  if (snap.get("status") === "merged" && snap.get("merged_into")) snap = await db.doc(`sessions/${snap.get("merged_into")}`).get();
  const job = snap.data();
  if (!job || job.status !== "complete") return [];
  const customer = job.customer_id ? (await db.doc(`customers/${job.customer_id}`).get()).get("name") : "";
  const details = { customer, model: job.engine_model, ecm: job.ecm_type, date: job.started_at?.toDate() };
  const ups = await db.collection("uploads").where("session_id", "==", sessionId).get();
  const renamed = [];
  for (const u of ups.docs) {
    const want = `${u.get("folder")}/${uploadName(u.get("original_name"), details)}`;
    if (u.get("path") === want) continue;
    const target = await freePath(bucket, want);
    const src = bucket.file(u.get("path"));
    const [exists] = await src.exists();
    if (!exists) continue;
    await u.ref.update({ renaming_to: target });
    await src.copy(bucket.file(target));
    await u.ref.update({ path: target, renaming_to: null });
    await src.delete({ ignoreNotFound: true });
    renamed.push(target);
  }
  return renamed;
}

// Never overwrite another file: "a.bin" -> "a (2).bin".
async function freePath(bucket, path) {
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.lastIndexOf("/") + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 1; ; n++) {
    const p = n === 1 ? path : `${stem} (${n})${ext}`;
    const [exists] = await bucket.file(p).exists();
    if (!exists) return p;
  }
}

async function forgetUploads(db, sessionId) {
  const ups = await db.collection("uploads").where("session_id", "==", sessionId).get();
  for (const u of ups.docs) await u.ref.delete();
}

module.exports = { isUpload, uploadName, linkUpload, renameSessionUploads, forgetUploads };
