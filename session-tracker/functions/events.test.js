const test = require("node:test");
const assert = require("node:assert");
const { BadRequest, parseConnEvent, applyConnEvent } = require("./events");

const base = { id: "123456789", uuid: "dXVpZA==", conn_id: 7 };
const at = (ms) => new Date(ms);

function run(events) {
  let open = null;
  let last = null;
  for (const [body, ms] of events) {
    const out = applyConnEvent(open, parseConnEvent({ ...base, ...body }), at(ms), "cust1");
    if (out.session) last = out.session;
    open = out.open === "delete" ? null : out.session || open;
  }
  return last;
}

test("a logged-in session that closes waits for its details", () => {
  const s = run([
    [{ action: "new", ip: "1.2.3.4" }, 0],
    [{ peer: ["987654321", "Sam"], type: 0 }, 5000],
    [{ action: "close" }, 65000],
  ]);
  assert.strictEqual(s.status, "needs_details");
  assert.strictEqual(s.duration_sec, 65);
  assert.strictEqual(s.technician_name, "Sam");
  assert.strictEqual(s.conn_type_name, "Remote desktop");
  assert.strictEqual(s.customer_id, "cust1");
});

test("a connection that never logs in stays out of the queue", () => {
  const s = run([
    [{ action: "new", ip: "1.2.3.4" }, 0],
    [{ action: "close" }, 3000],
  ]);
  assert.strictEqual(s.status, "not_authorized");
});

test("a job filled in during the session stays complete when it closes", () => {
  let open = null;
  for (const [body, ms] of [[{ action: "new", ip: "1.2.3.4" }, 0], [{ peer: ["987", "Sam"], type: 0 }, 5000]]) {
    open = applyConnEvent(open, parseConnEvent({ ...base, ...body }), at(ms), "cust1").session;
  }
  open = { ...open, status: "complete", category_id: "tune" };
  const s = applyConnEvent(open, parseConnEvent({ ...base, action: "close" }), at(65000), "cust1").session;
  assert.strictEqual(s.status, "complete");
  assert.strictEqual(s.category_id, "tune");
  assert.strictEqual(s.duration_sec, 65);
});

test("bad input is rejected", () => {
  assert.throws(() => parseConnEvent({ id: "../x", conn_id: 1 }), BadRequest);
  assert.throws(() => parseConnEvent({ id: "123", conn_id: "1" }), BadRequest);
  assert.throws(() => parseConnEvent([]), BadRequest);
});

const { splitPath, withId, makeFolders } = require("./files");

test("file IDs go in front of the readable name", () => {
  assert.strictEqual(withId("Files/Cummins/6.7L/Stage 2.bin", "CUM-00042"), "Files/Cummins/6.7L/CUM-00042_Stage 2.bin");
  assert.strictEqual(withId("Files/Cummins/CUM-00001_Old.bin", "CUM-00042"), "Files/Cummins/CUM-00042_Old.bin");
  assert.strictEqual(splitPath("Files/Duramax/DMX-00007_a.hex").id, "DMX-00007");
  assert.strictEqual(splitPath("Files/Duramax/DMX-00007_a.hex").base, "a");
});

test("a make gets a folder per model and per ECM type under it", () => {
  const make = { name: "Detroit", folder: "Detroit", models: [{ name: "DD15", ecms: ["DDEC 10", "MCM/ACM"] }, { name: "Series 60", ecms: [] }] };
  assert.deepStrictEqual(makeFolders(make), ["Detroit", "Detroit/DD15", "Detroit/DD15/DDEC 10", "Detroit/DD15/MCM-ACM", "Detroit/Series 60"]);
  assert.strictEqual(splitPath("Files/Detroit/DD15/a.bin").make, "Detroit");
  assert.strictEqual(splitPath("Software/a.exe").make, "");
});
