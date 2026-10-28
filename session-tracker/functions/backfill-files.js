// One-time: gives IDs to tune files that were already in the X: drive's engine-make
// folders before the upload trigger was deployed. That renames them (the ID is
// appended to the name), so it only lists what it would do unless given --apply.
// Safe to run again; files that already have an ID keep it.
//   node backfill-files.js <project-id> [--apply]
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { XDRIVE_BUCKET, registerFile, renameToId, splitPath } = require("./files");

async function main() {
  const projectId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!projectId) throw new Error("usage: node backfill-files.js <project-id> [--apply]");
  initializeApp({ projectId });
  const db = getFirestore();
  const bucket = getStorage().bucket(XDRIVE_BUCKET);
  const makes = (await db.collection("engine_makes").get()).docs.map((d) => String(d.get("folder") || d.get("name")).toLowerCase());
  const [files] = await bucket.getFiles();
  const todo = files
    .map((f) => f.metadata)
    .filter((o) => !o.name.endsWith("/") && o.name.includes("/") && makes.includes(splitPath(o.name).top.toLowerCase()))
    .sort((a, b) => String(a.timeCreated).localeCompare(String(b.timeCreated)));
  if (!apply) {
    for (const o of todo) console.log(`  ${o.name}`);
    console.log(`${todo.length} files in engine-make folders would get an ID. Run again with --apply to do it.`);
    return;
  }
  for (const o of todo) {
    const reg = await registerFile(db, o);
    if (reg?.renameTo) {
      await renameToId(bucket, o, reg.id, reg.renameTo);
      console.log(`  ${o.name} -> ${reg.renameTo}`);
    }
  }
  console.log(`${todo.length} files have IDs.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
