#!/usr/bin/env bash
# One-time Google Cloud setup for the download page's GitHub Actions deploy.
# Run in Cloud Shell. Safe to run again; finished steps are skipped.
#   bash setup-gcloud.sh [project-id]
set -uo pipefail

PROJECT="${1:-rustdesk-api-482222}"
SA_NAME="github-download-page"
SA_EMAIL="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
KEY_FILE="$HOME/key.json"
FIREBASE_API="https://firebase.googleapis.com/v1beta1/projects/$PROJECT"

ok()   { echo "  OK: $*"; }
fail() { echo; echo "STOPPED: $*"; exit 1; }

echo "== 1/5 Selecting project $PROJECT"
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1 || fail "could not select project $PROJECT. Check the ID."
ok "project selected"

echo "== 2/5 Enabling APIs (can take a minute)"
gcloud services enable firebase.googleapis.com firebasehosting.googleapis.com iam.googleapis.com --project "$PROJECT" \
  || fail "enabling APIs failed (see the error above)."
ok "APIs enabled"

echo "== 3/5 Adding Firebase to the project"
firebase_get() {
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "x-goog-user-project: $PROJECT" "$FIREBASE_API"
}
if [ "$(firebase_get)" = "200" ]; then
  ok "Firebase already enabled"
else
  resp=$(curl -s -X POST \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "x-goog-user-project: $PROJECT" \
    -H "Content-Type: application/json" -d '{}' "$FIREBASE_API:addFirebase")
  if echo "$resp" | grep -q '"error"'; then
    echo "$resp"
    echo
    echo "  Firebase could not be added from the command line. This usually means the"
    echo "  Firebase terms have not been accepted yet. Open https://console.firebase.google.com,"
    echo "  click 'Create a project', choose your existing Google Cloud project '$PROJECT',"
    echo "  accept the terms, then run this script again."
    exit 1
  fi
  for _ in $(seq 1 12); do
    [ "$(firebase_get)" = "200" ] && break
    sleep 5
  done
  [ "$(firebase_get)" = "200" ] || fail "Firebase is still being added. Wait a minute and run this script again."
  ok "Firebase added"
fi

echo "== 4/5 Creating the deploy service account and permissions"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  ok "service account already exists"
else
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name "GitHub download page deploy" || fail "creating the service account failed."
  sleep 10
  ok "service account created"
fi
for role in roles/firebasehosting.admin roles/serviceusage.apiKeysViewer roles/run.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" \
    --role "$role" --condition=None --quiet >/dev/null || fail "granting $role failed."
  ok "granted $role"
done

echo "== 5/5 Creating the key"
created=""
for _ in 1 2 3; do
  if gcloud iam service-accounts keys create "$KEY_FILE" --iam-account "$SA_EMAIL" --project "$PROJECT"; then
    created=1; break
  fi
  sleep 10
done
[ -n "$created" ] || fail "key creation failed. If the error mentions iam.disableServiceAccountKeyCreation, your organization blocks keys and an admin must allow it for this project."
ok "key saved to $KEY_FILE"

cat <<EOF

All done. Now in GitHub (repo -> Settings -> Secrets and variables -> Actions):
  1. Secrets tab   -> New repository secret   FIREBASE_SERVICE_ACCOUNT = the text printed below
  2. Variables tab -> New repository variable FIREBASE_PROJECT_ID      = $PROJECT
Then delete the key:  rm $KEY_FILE

----- copy everything between the lines -----
EOF
cat "$KEY_FILE"
echo
echo "----- end -----"
