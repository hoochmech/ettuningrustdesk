const test = require("node:test");
const assert = require("node:assert");
const { isUpload, uploadName } = require("./uploads");

test("customer uploads are named after the job", () => {
  const date = new Date("2026-10-30T02:00:00Z"); // Oct 29 in Texas
  assert.strictEqual(
    uploadName("log.bin", { customer: "Smith Trucking", model: "ISX15", ecm: "CM871", date }),
    "Smith Trucking_ISX15_CM871_2026-10-29_log.bin",
  );
  assert.strictEqual(uploadName("a.hex", { customer: "J/B Diesel", model: "", ecm: "", date }), "J-B Diesel_2026-10-29_a.hex");
  assert.ok(isUpload("Uploads/log.bin"));
  assert.ok(!isUpload("Uploads/"));
  assert.ok(!isUpload("Files/Cummins/a.bin"));
});
