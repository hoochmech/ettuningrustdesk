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

test("bad input is rejected", () => {
  assert.throws(() => parseConnEvent({ id: "../x", conn_id: 1 }), BadRequest);
  assert.throws(() => parseConnEvent({ id: "123", conn_id: "1" }), BadRequest);
  assert.throws(() => parseConnEvent([]), BadRequest);
});

const { splitPath, withId } = require("./files");

test("file IDs are appended to the readable name", () => {
  assert.strictEqual(withId("Cummins/6.7L/Stage 2.bin", "CUM-00042"), "Cummins/6.7L/Stage 2_CUM-00042.bin");
  assert.strictEqual(withId("Cummins/Old_CUM-00001.bin", "CUM-00042"), "Cummins/Old_CUM-00042.bin");
  assert.strictEqual(splitPath("Duramax/a_DMX-00007.hex").id, "DMX-00007");
});
