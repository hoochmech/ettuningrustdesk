// Gives tune files on the X: drive (the ettuning-fileshare-files bucket) a permanent ID
// so a job can record exactly which file it used.
//
// Tune files live under Files/, in one folder per engine make named as on the Lists tab
// of the dashboard (e.g. "Files/Cummins/..."), with a folder per engine model and ECM
// type inside it. Each make has its own ID prefix and counter, and the ID is added in
// front of the file name, so "Stage 2.bin" in Files/Cummins/ becomes "CUM-00042_Stage 2.bin".
// Files outside a make folder (such as Software/ or customer Uploads/) are left alone.
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

const XDRIVE_BUCKET = "ettuning-fileshare-files";
const XDRIVE_TOPIC = "xdrive-files";
const FILES_ROOT = "Files";
const ID_PREFIX = /^([A-Z0-9]{2,6}-\d{5,})_/;

function defaultPrefix(makeName) {
  return makeName.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "ETF";
}

function formatFileId(prefix, n) {
  return `${prefix}-${String(n).padStart(5, "0")}`;
}

// "Cummins/6.7L/CUM-00042_Stage 2.bin" -> folder, base "Stage 2", ext ".bin", id "CUM-00042"
function splitPath(path) {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  let base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const m = base.match(ID_PREFIX);
  const id = m ? m[1] : "";
  if (m) base = base.slice(m[0].length);
  const parts = path.split("/");
  // The engine make's folder: the one right under Files/.
  const make = parts.length > 2 && parts[0].toLowerCase() === FILES_ROOT.toLowerCase() ? parts[1] : "";
  return { folder, top: parts[0], make, file, base, ext, id };
}

function withId(path, id) {
  const p = splitPath(path);
  return `${p.folder ? `${p.folder}/` : ""}${id}_${p.base}${p.ext}`;
}

async function findMake(db, top) {
  const makes = await db.collection("engine_makes").get();
  const want = top.toLowerCase();
  const doc = makes.docs.find((d) => folderName(d.get("folder") || d.get("name")).toLowerCase() === want);
  if (!doc) return null;
  return { name: doc.get("name"), prefix: doc.get("file_prefix") || defaultPrefix(doc.get("name")) };
}

// `obj` is Cloud Storage object metadata (name, generation, size, md5Hash, ...).
// Returns { id, renameTo } (renameTo empty when the name already carries the ID),
// or null when the file isn't tracked.
async function registerFile(db, obj) {
  if (!obj.name || obj.name.endsWith("/") || !obj.name.includes("/")) return null;
  const p = splitPath(obj.name);
  if (!p.make) return null;
  const make = await findMake(db, p.make);
  if (!make) return null;
  const gen = String(obj.generation);

  // Our own rename landing: the name carries an ID already registered for this path.
  if (p.id) {
    const existing = await db.doc(`files/${p.id}`).get();
    if (existing.exists && existing.get("path") === obj.name) {
      await db.batch()
        .update(existing.ref, { generation: gen, size: Number(obj.size) || 0, md5: obj.md5Hash || "", current: true, deleted: false })
        .set(db.doc(`file_generations/${gen}`), { file_id: p.id })
        .commit();
      return { id: p.id, renameTo: "" };
    }
  }

  // A new file (or a copy/rename of one): give it the next ID for its make.
  const sourceRef = db.doc(`file_sources/${gen}`);
  const counterRef = db.doc(`counters/files_${make.prefix}`);
  return db.runTransaction(async (tx) => {
    const source = await tx.get(sourceRef);
    // Event retried: this upload already has an ID and is being (or was) renamed.
    if (source.exists) return { id: source.get("file_id"), renameTo: source.get("rename_to") };
    const counter = await tx.get(counterRef);
    const next = counter.exists ? counter.get("next") : 1;
    const id = formatFileId(make.prefix, next);
    const path = withId(obj.name, id);
    tx.set(db.doc(`files/${id}`), {
      file_id: id,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      original_name: p.file,
      folder: p.folder,
      make: make.name,
      size: Number(obj.size) || 0,
      md5: obj.md5Hash || "",
      generation: "",
      uploaded_at: obj.timeCreated ? Timestamp.fromDate(new Date(obj.timeCreated)) : Timestamp.now(),
      current: true,
      deleted: false,
    });
    tx.set(sourceRef, { file_id: id, rename_to: path });
    tx.set(counterRef, { next: next + 1, updated_at: FieldValue.serverTimestamp() });
    return { id, renameTo: path };
  });
}

// Moves the upload to its ID'd name. `bucket` is a firebase-admin Storage bucket.
async function renameToId(bucket, obj, id, renameTo) {
  const src = bucket.file(obj.name, { generation: obj.generation });
  const [exists] = await src.exists();
  if (!exists) return;
  const [dest] = await src.copy(bucket.file(renameTo));
  await dest.setMetadata({ metadata: { et_file_id: id } });
  await src.delete();
}

async function markDeleted(db, obj) {
  const gen = await db.doc(`file_generations/${obj.generation}`).get();
  if (!gen.exists) return;
  await db.doc(`files/${gen.get("file_id")}`).update({ current: false, deleted: true });
}

// A name usable as a Windows folder on the X: drive.
function folderName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/[. ]+$/, "").trim();
}

// The X: drive folders a make should have: its own, one per engine model, and one per
// ECM type inside its model.
function makeFolders(make) {
  const root = folderName(make.folder || make.name);
  if (!root) return [];
  const out = [root];
  for (const m of make.models || []) {
    const model = folderName(m.name);
    if (!model) continue;
    out.push(`${root}/${model}`);
    for (const e of m.ecms || []) if (folderName(e)) out.push(`${root}/${model}/${folderName(e)}`);
  }
  return out;
}

// Files/ as it is already spelled in the bucket (the X: drive may have "files"), else "Files".
async function filesRoot(bucket) {
  const [, , res] = await bucket.getFiles({ delimiter: "/", autoPaginate: false, maxResults: 1000 });
  const found = (res?.prefixes || []).find((x) => x.toLowerCase() === `${FILES_ROOT.toLowerCase()}/`);
  return found ? found.slice(0, -1) : FILES_ROOT;
}

// Creates the folders (zero-byte "name/" objects, which rclone shows as folders) a make
// is missing. Never removes any: a folder may already hold files. Returns those created.
async function ensureMakeFolders(bucket, make) {
  const root = await filesRoot(bucket);
  const created = [];
  for (const f of makeFolders(make)) {
    const marker = bucket.file(`${root}/${f}/`);
    const [exists] = await marker.exists();
    if (exists) continue;
    await marker.save("", { resumable: false, contentType: "application/x-directory" });
    created.push(`${root}/${f}/`);
  }
  return created;
}

module.exports = { XDRIVE_BUCKET, XDRIVE_TOPIC, FILES_ROOT, folderName, makeFolders, ensureMakeFolders, defaultPrefix, formatFileId, splitPath, withId, registerFile, renameToId, markDeleted };
