#!/usr/bin/env bash
# One-command deploy of Friday to AWS (ECS Fargate + ALB), building the image in CodeBuild.
#
#   infra/aws/deploy.sh --env-file infra/aws/app.env      # first deploy: stores settings, then deploys
#   infra/aws/deploy.sh                                   # later deploys: current commit, same settings
#
# Env: AWS_REGION (default ap-south-1), FRIDAY_STACK (default friday), CERTIFICATE_ARN (optional,
# enables HTTPS), DESIRED_COUNT (default 1). Needs: aws CLI v2 or v1, git, python3.
# Deploys the COMMITTED tree (git archive HEAD) — commit first.
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
NAME="${FRIDAY_STACK:-friday}"
SECRET_ID="$NAME/app-env"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export AWS_DEFAULT_REGION="$REGION"
aws() { command aws --region "$REGION" "$@"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Account"
aws sts get-caller-identity --query '[Account,Arn]' --output text

# ── 1. App settings → one Secrets Manager JSON secret (read by the API as FRIDAY_ENV_JSON).
if [[ -n "$ENV_FILE" ]]; then
  step "Storing settings from $ENV_FILE in Secrets Manager ($SECRET_ID)"
  JSON="$(python3 - "$ENV_FILE" <<'PY'
import json, sys, re
out = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip().removeprefix("export ").strip()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and value != "":
        out[key] = value
print(json.dumps(out))
PY
)"
  if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$JSON" >/dev/null
  else
    aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "$JSON" >/dev/null
  fi
  unset JSON
fi
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query ARN --output text)" || {
  echo "No settings secret yet — run with --env-file infra/aws/app.env (see app.env.example)" >&2; exit 1; }

# ── 2. Build pipeline (ECR + source bucket + CodeBuild).
step "Build pipeline stack ($NAME-build)"
aws cloudformation deploy --stack-name "$NAME-build" --template-file "$HERE/friday-build.yaml" \
  --parameter-overrides "AppSecretArn=$SECRET_ARN" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
REPO="$(out "$NAME-build" RepositoryUri)"
BUCKET="$(out "$NAME-build" SourceBucket)"
PROJECT="$(out "$NAME-build" ProjectName)"

# ── 3. Build the image in CodeBuild from the committed tree.
TAG="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- . ':!frontend/tsconfig.tsbuildinfo')" ]]; then
  echo "note: uncommitted changes are NOT deployed (building $TAG)"
fi
if aws ecr describe-images --repository-name "${REPO##*/}" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
  step "Image $TAG already built — skipping build"
else
  step "Building image $TAG in CodeBuild"
  ZIP="$(mktemp -d)/source.zip"
  git -C "$ROOT" archive --format=zip -o "$ZIP" HEAD
  aws s3 cp "$ZIP" "s3://$BUCKET/source.zip" --only-show-errors
  BUILD_ID="$(aws codebuild start-build --project-name "$PROJECT" \
    --environment-variables-override "name=IMAGE_TAG,value=$TAG,type=PLAINTEXT" --query build.id --output text)"
  echo "build: $BUILD_ID"
  while :; do
    STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)"
    PHASE="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].currentPhase' --output text)"
    printf '  %s (%s)\n' "$STATUS" "$PHASE"
    [[ "$STATUS" == "IN_PROGRESS" ]] || break
    sleep 20
  done
  if [[ "$STATUS" != "SUCCEEDED" ]]; then
    echo "Image build failed. Logs:" >&2
    aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].logs.deepLink' --output text >&2
    exit 1
  fi
fi

# ── 4. The app stack.
step "App stack ($NAME) with $REPO:$TAG"
aws cloudformation deploy --stack-name "$NAME" --template-file "$HERE/friday-stack.yaml" --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset --parameter-overrides \
  "ImageUri=$REPO:$TAG" "AppSecretArn=$SECRET_ARN" "CertificateArn=${CERTIFICATE_ARN:-}" "DesiredCount=${DESIRED_COUNT:-1}"
CLUSTER="$(out "$NAME" ClusterName)"
SERVICE="$(out "$NAME" ServiceName)"
step "Waiting for the service to be stable"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

URL="$(out "$NAME" AppUrl)"
step "Deployed"
echo "App:     $URL"
echo "Health:  $URL/api/health/ready"
echo "Logs:    aws logs tail $(out "$NAME" LogGroup) --follow --region $REGION"
curl -fsS "$URL/api/health/live" && echo
