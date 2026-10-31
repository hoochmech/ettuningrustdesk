#!/usr/bin/env bash
# Sets up and deploys ET Tuning Sessions (the customer and session database).
# Run in Cloud Shell (the >_ button in the Google Cloud console), from this folder:
#   git clone https://github.com/hoochmech/ettuningrustdesk && cd ettuningrustdesk/session-tracker
#   bash setup.sh you@example.com
# The email is the Google account you'll sign in to the dashboard with; it is added
# to the staff list. Safe to run again: it redeploys and skips finished steps.
set -uo pipefail

EMAIL="${1:-}"
PROJECT="${2:-rustdesk-api-482222}"
SITE="$PROJECT-sessions"
REGION="us-central1"
BUCKET="ettuning-fileshare-files"

ok()   { echo "  OK: $*"; }
note() { echo "  NOTE: $*"; }
fail() { echo; echo "STOPPED: $*"; exit 1; }

[ -n "$EMAIL" ] || fail "pass your Google account email: bash setup.sh you@example.com"
cd "$(dirname "$0")" || fail "cannot find the session-tracker folder"
FB="npx --yes firebase-tools@15"

echo "== 1/7 Project and APIs"
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1 || fail "could not select project $PROJECT."
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" = "False" ]; then
  fail "billing is off for $PROJECT. Cloud Functions need the Blaze plan: Firebase console -> Upgrade."
fi
gcloud services enable firestore.googleapis.com cloudfunctions.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  storage.googleapis.com firebasehosting.googleapis.com identitytoolkit.googleapis.com \
  firebaserules.googleapis.com --project "$PROJECT" || fail "enabling APIs failed."
ok "APIs enabled"
# Newer projects build Cloud Functions as the default compute account, which starts
# without the permissions a build needs.
build_sa="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$build_sa" \
  --role roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null || fail "letting $build_sa build functions failed."
ok "function builds allowed"
# The same account runs the functions, which read and write Firestore.
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$build_sa" \
  --role roles/datastore.user --condition=None --quiet >/dev/null || fail "giving $build_sa Firestore access failed."
ok "functions can use Firestore"

echo "== 2/7 Firestore database"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT" >/dev/null 2>&1; then
  ok "database already exists"
else
  gcloud firestore databases create --database='(default)' --location="$REGION" --project "$PROJECT" \
    || fail "creating the Firestore database failed."
  ok "database created in $REGION"
fi

echo "== 3/7 Staff list"
TOKEN=$(gcloud auth print-access-token)
code=$(curl -s -o /tmp/staff.json -w "%{http_code}" -X PATCH \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fields":{"added_by":{"stringValue":"setup.sh"}}}' \
  "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents/staff/$EMAIL")
[ "$code" = "200" ] || { cat /tmp/staff.json; fail "adding $EMAIL to the staff list failed."; }
ok "$EMAIL can sign in"

echo "== 4/7 X: drive bucket"
bucket_number=$(curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://storage.googleapis.com/storage/v1/b/$BUCKET?fields=projectNumber" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("projectNumber", ""))' 2>/dev/null)
[ -n "$bucket_number" ] || fail "cannot read gs://$BUCKET. Check the name and that your account can see it."
bucket_project=$(gcloud projects describe "$bucket_number" --format='value(projectId)') || fail "cannot read project $bucket_number."
ok "bucket is in project $bucket_project"
# The bucket reports adds and deletes to a Pub/Sub topic here, which the xdriveFileChanged
# function listens on. This works whether or not the bucket is in this project.
TOPIC="xdrive-files"
gcloud pubsub topics describe "$TOPIC" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud pubsub topics create "$TOPIC" --project "$PROJECT" >/dev/null || fail "creating Pub/Sub topic $TOPIC failed."
gs_agent=$(gcloud storage service-agent --project "$bucket_project" 2>/dev/null)
# Make sure Google has actually created that project's storage agent before granting it anything.
gcloud beta services identity create --service=storage.googleapis.com --project "$bucket_project" --quiet >/dev/null 2>&1
xdrive_ok=1
if [ -n "$gs_agent" ] && gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project "$PROJECT" \
    --member "serviceAccount:$gs_agent" --role roles/pubsub.publisher --quiet >/dev/null 2>&1; then
  ok "bucket may publish to $TOPIC"
fi
if gcloud storage buckets notifications list "gs://$BUCKET" --format=json 2>/dev/null | grep -q "projects/$PROJECT/topics/$TOPIC"; then
  ok "bucket notification already set"
elif gcloud storage buckets notifications create "gs://$BUCKET" --topic="projects/$PROJECT/topics/$TOPIC" \
    --payload-format=json --event-types=OBJECT_FINALIZE,OBJECT_DELETE >/dev/null; then
  ok "bucket notification created"
else
  xdrive_ok=""
  note "could not connect gs://$BUCKET to $TOPIC. Continuing so the dashboard still deploys; X: drive file IDs stay off until this works."
fi
# The function renames new files to add their ID, so its account needs write access to the bucket.
number=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
if gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
    --member "serviceAccount:$number-compute@developer.gserviceaccount.com" \
    --role roles/storage.objectAdmin --condition=None >/dev/null; then
  ok "functions can rename files in gs://$BUCKET"
else
  xdrive_ok=""
  note "could not give the functions write access to gs://$BUCKET."
fi

# Screenshots taken during sessions are kept with the job in a private bucket here.
SHOTS="$PROJECT-job-screenshots"
if gcloud storage buckets describe "gs://$SHOTS" >/dev/null 2>&1; then
  ok "screenshot bucket exists"
else
  gcloud storage buckets create "gs://$SHOTS" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention >/dev/null || fail "creating gs://$SHOTS failed."
  ok "screenshot bucket created"
fi
gcloud storage buckets add-iam-policy-binding "gs://$SHOTS" \
  --member "serviceAccount:$number-compute@developer.gserviceaccount.com" \
  --role roles/storage.objectAdmin --condition=None >/dev/null || fail "giving the functions access to gs://$SHOTS failed."
ok "functions can store screenshots"

echo "== 5/7 Firebase sign-in, hosting site and web app"
# A saved Firebase sign-in can expire while still counting as "logged in", so reauth when it fails.
$FB projects:list >/dev/null 2>&1 || $FB login --reauth --no-localhost || fail "Firebase sign-in failed."
if $FB hosting:sites:get "$SITE" --project "$PROJECT" >/dev/null 2>&1; then
  ok "site $SITE exists"
else
  $FB hosting:sites:create "$SITE" --project "$PROJECT" || fail "creating hosting site $SITE failed (the name may be taken; change it in .firebaserc and here)."
  ok "site $SITE created"
fi
if $FB apps:list WEB --project "$PROJECT" 2>/dev/null | grep -q "ET Tuning Sessions"; then
  ok "web app registered"
else
  $FB apps:create WEB "ET Tuning Sessions" --project "$PROJECT" || fail "registering the web app failed."
  ok "web app registered"
fi

echo "== 6/7 Deploying (functions take a few minutes the first time)"
(cd functions && npm ci --no-audit --no-fund >/dev/null) || fail "installing function packages failed."
$FB deploy --only functions,firestore,hosting:sessions --project "$PROJECT" --non-interactive --force \
  || fail "deploy failed (see above). Running this script again usually gets past first-deploy permission delays."
ok "deployed"

echo "== 7/7 Files already on the X: drive"
gcloud auth application-default print-access-token >/dev/null 2>&1 || gcloud auth application-default login --quiet
(cd functions && node backfill-files.js "$PROJECT") || note "listing failed; run 'cd functions && node backfill-files.js $PROJECT' later."
note "the dashboard creates the engine list the first time you sign in, so if no files were listed, sign in first and run that again."
note "to give those files IDs (this renames them), run: cd functions && node backfill-files.js $PROJECT --apply"

[ -n "$xdrive_ok" ] || note "X: drive file IDs are not connected yet; paste the step 4 messages to Claude."

cat <<EOF2

Deployed. Two clicks are left in the Firebase console (https://console.firebase.google.com/project/$PROJECT/authentication):
  1. Authentication -> Sign-in method -> Add new provider -> Google -> Enable -> Save.
  2. Authentication -> Settings -> Authorized domains -> Add domain -> $SITE.web.app

Then open https://$SITE.web.app and sign in as $EMAIL.
Clients built from this repo report sessions to https://$SITE.web.app (API_SERVER in src/branding.rs).
To add another staff member, run step 3 again with their email, or add a document with
their email as the ID under "staff" in the Firestore console.
EOF2
