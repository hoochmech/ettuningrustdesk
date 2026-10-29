# ET Tuning Sessions

Customer and job database for ET Tuning Remote. Every remote session a technician
logs into is recorded automatically; when it ends it waits on the dashboard for the
job details: customer, work category, billable, vehicle make, engine make → model →
ECM type, the X: drive file used, and for warranty jobs the original job and the
issue.

Runs on Firebase in the `rustdesk-api-482222` project:

| Piece | What it does |
| --- | --- |
| `functions/index.js` `api` | Receives the session reports clients send to their API server (`/api/audit/conn`, `/api/sysinfo`) |
| `functions/index.js` `xdriveFileChanged` | Gives X: drive tune files their IDs. The bucket sends its adds and deletes to the `xdrive-files` Pub/Sub topic, so it can live in another project |
| `public/` | The dashboard, at `https://rustdesk-api-482222-sessions.web.app` |
| `firestore.rules` | Only people on the staff list can read or edit |

## How sessions get in

The client's API server is set to the dashboard URL (`API_SERVER` in `src/branding.rs`).
The customer's PC then posts three records per connection to `/api/audit/conn`
(`src/server/connection.rs`, `post_conn_audit`): `new` when it connects, one with the
technician's ID and name when they log in, and `close` when it ends. The function
pairs them into one `sessions` document. Connections that never logged in (wrong
password, cancelled) are kept as `not_authorized` and never show in the queue.

The PC also posts its computer name, Windows user and OS to `/api/sysinfo`, which
fills in the `devices` list. Link a computer to a customer once (on the job form or
the Computers tab) and its later sessions arrive with the customer filled in.

A session that shouldn't be recorded as a job gets "Don't log" (in the queue or on the
form). The session, its connection records and any overlapping connections it would
have absorbed are deleted (through `/api/forget`, which checks the staff list), so no
record is left. A session that is still open when it's removed leaves nothing when it
closes either. Saved jobs can't be removed this way.

The job form can also be filled in while the session is still going: "Fill in now"
under "In progress" on the queue page, or the clipboard button ("Job form") in the
client's remote toolbar, which opens the dashboard at `#device=<remote ID>` with the form
for that computer's latest session (still going, waiting for details, or already saved),
so it can be opened and edited any number of times. Closing a logged-in remote desktop
session opens the same form. A job saved early stays complete when the session closes.

Vehicle make, engine make, engine model and ECM type lists end in "+ Add…" on the job
form, which saves the new entry to the Lists tab and picks it. A make added this way
gets its name as its X: drive folder and the first three letters as its file ID prefix;
change those on the Lists tab before putting files in its folder.

A file transfer or terminal window is a separate connection. When a job is saved,
other waiting connections on the same computer that overlap it (within a minute) are
folded into it.

Hosting answers every other API path the client tries (heartbeat, address book,
login) with an empty 404, which the client ignores, so idle heartbeats cost nothing.

## X: drive file IDs

Tune files live under `Files/` on the X: drive, in a folder per engine make (Lists tab;
defaults `Cummins` CUM, `Duramax` DMX, `Power Stroke` PSD) with a folder per engine model
and ECM type inside it. Adding a make, model or ECM type, on the Lists tab or with
"+ Add…" on the job form, creates its folder (`engineMakeFolders` function); removing one
leaves the folder, since it may hold files. A file added anywhere under a make's folder
is renamed to carry the next ID for that make:
`Files/Cummins/6.7L/CM2350B/Stage 2.bin` → `Files/Cummins/6.7L/CM2350B/Stage 2_CUM-00042.bin`.
The ID is also stored on the object as `et_file_id` metadata. Files in other folders
(`Software/`, customer `Uploads/`) are left alone. `backfill-files.js --apply` creates the
folders for makes that were on the Lists tab before the function was deployed.

## Data

| Collection | Holds |
| --- | --- |
| `customers` | name, company, phone, email, notes |
| `devices` | one per RustDesk ID: computer name, user, OS, linked customer, label |
| `sessions` | start/end, technician, status (`needs_details`, `complete`, `dismissed`, `merged`, `not_authorized`), and the job details |
| `work_categories` | name, `requires_issue` (shows the original-job and issue fields), active |
| `engine_makes` | name, X: drive folder, file ID prefix, models with their ECM types |
| `lists/vehicle_makes` | vehicle makes |
| `files` | one per file ID: path, make, size, upload time, whether it's still current |
| `conn_events` | every raw report from clients (audit log) |
| `staff` | document ID = Google account email allowed to sign in |

## Setup

In Cloud Shell (the `>_` button in the Google Cloud console):

```
git clone https://github.com/hoochmech/ettuningrustdesk
cd ettuningrustdesk/session-tracker
bash setup.sh you@example.com
```

It enables the APIs, creates the Firestore database, adds you to the staff list,
creates the `rustdesk-api-482222-sessions` hosting site and deploys everything. The
project needs the Blaze (pay-as-you-go) plan for Cloud Functions. At the end it lists
which X: drive files would be renamed; to rename them, run
`cd functions && node backfill-files.js rustdesk-api-482222 --apply`.

Then in the Firebase console, Authentication:
1. Sign-in method → Add new provider → Google → Enable.
2. Settings → Authorized domains → add `rustdesk-api-482222-sessions.web.app`.

To redeploy after a change, run `setup.sh` again.

## Known limits

- The `/api/audit/conn` endpoint can't check who is posting (the client sends no
  credentials), so anyone who finds the URL could add fake sessions to the queue.
  They can't read or change anything.
- If a customer's PC loses power mid-session, no `close` arrives; the session stays
  under "In progress" until that PC's next connection reuses the connection number.
- Renaming a file on the X: drive gives it a new ID; the old ID stays on jobs that
  used it. Overwriting a file in place keeps its ID.
- The Sessions tab loads the latest 1000 sessions.

## Tests

```
cd functions && npm install && npm test
```
