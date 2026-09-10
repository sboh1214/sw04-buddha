#!/usr/bin/env bash
# Deploy (or redeploy / roll back) the buddha stack on this host. Invoked as root by the SSM Run
# Command that .github/workflows/deploy.yml sends, after the deploy bundle has been unpacked from the
# api image into /data/buddha and host-setup.sh has run. Idempotent: safe to re-run with the same tag.
#
#   deploy.sh <image tag>     # deploy that tag (a git sha pushed to ECR)
#   deploy.sh                 # re-deploy the tag recorded in .env (e.g. after a secret rotation)
#
# Ordering matters: the one-shot `migrate` service (drizzle migrations, then the idempotent seed)
# must succeed BEFORE api/worker/web are replaced, so a failed migration leaves the previous
# release serving and makes this script — and the workflow — fail loudly.
set -euo pipefail

ROOT=/data/buddha
ENV_PARAMETER=/tf-buddha/env
export AWS_DEFAULT_REGION="${AWS_REGION:-ap-northeast-2}"

# /data is a separate EBS volume mounted by label (fstab, nofail). If it is missing, dockerd would
# happily create empty directories on the root filesystem and postgres would run a fresh initdb.
findmnt -rno TARGET /data >/dev/null || { echo "deploy.sh: /data is not mounted" >&2; exit 1; }
cd "$ROOT"

# One deploy at a time (a re-run while a previous command is still pulling would race compose).
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9

TAG="${1:-$(sed -n 's/^IMAGE_TAG=//p' .env 2>/dev/null | tail -n 1 || true)}"
: "${TAG:?deploy.sh: image tag (git sha) required as argument or IMAGE_TAG in .env}"

# Render .env from SSM (SecureString; the instance role may read exactly this parameter). Written
# to a temp file first so a failed fetch never truncates the live file.
umask 077
aws ssm get-parameter --name "$ENV_PARAMETER" --with-decryption \
  --query Parameter.Value --output text >.env.new
printf 'IMAGE_TAG=%s\n' "$TAG" >>.env.new
grep -q '^BETTER_AUTH_SECRET=.\+' .env.new || { echo "deploy.sh: rendered env looks empty" >&2; exit 1; }
mv -f .env.new .env

ECR_REGISTRY=$(sed -n 's/^ECR_REGISTRY=//p' .env | tail -n 1)
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null

docker compose pull --quiet
# First boot: postgres runs initdb with 01-roles.sql (repo file) then 02-passwords.sh (deploy-only).
docker compose up -d --wait postgres redis
# Gate: migrations + seed as a one-shot container. Non-zero exit stops here (set -e).
docker compose run --rm migrate
docker compose up -d --wait --wait-timeout 300 --remove-orphans
docker image prune -af >/dev/null
docker compose ps
