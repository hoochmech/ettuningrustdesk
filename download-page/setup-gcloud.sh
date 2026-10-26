#!/usr/bin/env bash
# One-time Google Cloud setup for the download page's GitHub Actions deploy.
# GitHub signs in with Workload Identity Federation, so no service account key is created.
# Run in Cloud Shell. Safe to run again; finished steps are skipped.
#   bash setup-gcloud.sh [project-id]
set -uo pipefail

PROJECT="${1:-rustdesk-api-482222}"
REPO="hoochmech/ettuningrustdesk"
SA_NAME="github-download-page"
SA_EMAIL="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
POOL="github"
PROVIDER="ettuningrustdesk"
FIREBASE_API="https://firebase.googleapis.com/v1beta1/projects/$PROJECT"

ok()   { echo "  OK: $*"; }
fail() { echo; echo "STOPPED: $*"; exit 1; }

echo "== 1/5 Selecting project $PROJECT"
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1 || fail "could not select project $PROJECT. Check the ID."
ok "project selected"

echo "== 2/5 Enabling APIs (can take a minute)"
gcloud services enable firebase.googleapis.com firebasehosting.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT" \
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
for role in roles/firebasehosting.admin roles/serviceusage.apiKeysViewer roles/run.viewer \
  roles/serviceusage.serviceUsageConsumer roles/serviceusage.serviceUsageViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA_EMAIL" \
    --role "$role" --condition=None --quiet >/dev/null || fail "granting $role failed."
  ok "granted $role"
done

echo "== 5/5 Letting GitHub Actions sign in without a key"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)') || fail "could not read the project number."
POOL_ID="projects/$NUMBER/locations/global/workloadIdentityPools/$POOL"
if gcloud iam workload-identity-pools describe "$POOL" --location global --project "$PROJECT" >/dev/null 2>&1; then
  ok "identity pool already exists"
else
  gcloud iam workload-identity-pools create "$POOL" --location global --project "$PROJECT" \
    --display-name "GitHub Actions" || fail "creating the identity pool failed."
  ok "identity pool created"
fi
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global \
    --workload-identity-pool "$POOL" --project "$PROJECT" >/dev/null 2>&1; then
  ok "GitHub provider already exists"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global \
    --workload-identity-pool "$POOL" --project "$PROJECT" --display-name "ettuningrustdesk repo" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository=='$REPO' && assertion.ref=='refs/heads/master'" \
    || fail "creating the GitHub provider failed."
  ok "GitHub provider created (only $REPO on master can sign in)"
fi
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser --condition=None --quiet \
  --member "principalSet://iam.googleapis.com/$POOL_ID/attribute.repository/$REPO" >/dev/null \
  || fail "allowing the repo to use the service account failed."
ok "repo allowed to deploy as $SA_EMAIL"

cat <<EOF

All done. Now in GitHub: repo -> Settings -> Secrets and variables -> Actions -> Variables tab.
Add these three repository variables (no secrets needed):

  GCP_WORKLOAD_IDENTITY_PROVIDER = $POOL_ID/providers/$PROVIDER
  GCP_SERVICE_ACCOUNT            = $SA_EMAIL
  FIREBASE_PROJECT_ID            = $PROJECT

Then Actions tab -> "Deploy download page" -> Run workflow.
EOF
