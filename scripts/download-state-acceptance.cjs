const assert = require("node:assert/strict");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.LOCALFIRST_DATABASE;
if (!databasePath) throw new Error("LOCALFIRST_DATABASE is required.");

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const row = database.prepare(`
    SELECT
      d.download_id, d.server_id, d.user_id, d.item_id, d.media_source_id,
      d.state, d.bytes_downloaded, d.expected_size, d.error_code,
      m.name, m.item_type,
      l.local_path, l.file_state, l.probe_state, l.actual_size,
      l.expected_size AS local_expected_size
    FROM download_jobs d
    JOIN media_items m
      ON m.server_id = d.server_id AND m.user_id = d.user_id AND m.item_id = d.item_id
    LEFT JOIN local_versions l ON l.download_id = d.download_id
    ORDER BY d.created_at DESC
    LIMIT 1
  `).get();
  assert.ok(row, "No manual download has been recorded.");
  assert.ok(row.download_id && row.server_id && row.user_id && row.item_id && row.media_source_id, "Download identity is incomplete.");
  assert.equal(row.state, "completed");
  assert.equal(row.error_code, null);
  assert.equal(row.file_state, "finalized");
  assert.equal(row.probe_state, "valid");
  const file = fs.statSync(row.local_path);
  assert.equal(file.isFile(), true);
  assert.equal(file.size, row.bytes_downloaded);
  assert.equal(file.size, row.actual_size);
  if (row.expected_size !== null) assert.equal(file.size, row.expected_size);
  if (row.local_expected_size !== null) assert.equal(file.size, row.local_expected_size);
  process.stdout.write(`${JSON.stringify({
    item: row.name,
    itemType: row.item_type,
    state: row.state,
    bytes: file.size,
    fileState: row.file_state,
    probeState: row.probe_state,
    identityComplete: true,
  }, null, 2)}\n`);
} finally {
  database.close();
}
