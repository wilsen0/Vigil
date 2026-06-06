#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ALPHAOS_BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${ALPHAOS_API_SECRET:-${API_SECRET:-}}"
OUT_DIR="${ALPHAOS_DEMO_OUT_DIR:-demo-output}"
STRATEGY="${ALPHAOS_DISCOVERY_STRATEGY:-spread-threshold}"
PAIRS_CSV="${ALPHAOS_DISCOVERY_PAIRS:-ETH/USDC,BTC/USDC}"
DURATION_MINUTES="${ALPHAOS_DISCOVERY_DURATION_MINUTES:-1}"
SAMPLE_INTERVAL_SEC="${ALPHAOS_DISCOVERY_SAMPLE_INTERVAL_SEC:-2}"
TOPN="${ALPHAOS_DISCOVERY_TOPN:-10}"
WAIT_SECONDS="${ALPHAOS_DISCOVERY_WAIT_SECONDS:-12}"
AUTO_APPROVE="${ALPHAOS_DISCOVERY_AUTO_APPROVE:-false}"
APPROVE_MODE="${ALPHAOS_DISCOVERY_APPROVE_MODE:-paper}"
STOP_AFTER="${ALPHAOS_DISCOVERY_STOP_AFTER:-true}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_JSON="$OUT_DIR/discovery-smoke-$STAMP.json"
HEALTH_WAIT_SECONDS="${ALPHAOS_HEALTH_WAIT_SECONDS:-20}"
HEALTH_RETRY_INTERVAL_SEC="${ALPHAOS_HEALTH_RETRY_INTERVAL_SEC:-1}"

request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local -a headers
  headers=(-H "Content-Type: application/json")
  if [[ -n "$API_TOKEN" ]]; then
    headers+=(-H "Authorization: Bearer $API_TOKEN")
  fi

  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$data"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

request_with_status() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local -a headers
  headers=(-H "Content-Type: application/json")
  if [[ -n "$API_TOKEN" ]]; then
    headers+=(-H "Authorization: Bearer $API_TOKEN")
  fi

  local response
  if [[ -n "$data" ]]; then
    response="$(curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$data" -w $'\n%{http_code}')"
  else
    response="$(curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -w $'\n%{http_code}')"
  fi

  local status="${response##*$'\n'}"
  local body="${response%$'\n'*}"
  printf '%s\n%s' "$status" "$body"
}

wait_for_health() {
  local elapsed=0
  while [[ "$elapsed" -lt "$HEALTH_WAIT_SECONDS" ]]; do
    if request GET /health > /dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_RETRY_INTERVAL_SEC"
    elapsed=$((elapsed + HEALTH_RETRY_INTERVAL_SEC))
  done
  return 1
}

json_get() {
  local dotted_path="$1"
  node -e '
const path = process.argv[1].split(".");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  let cur = data;
  for (const key of path) {
    if (cur === null || cur === undefined) process.exit(2);
    cur = cur[key];
  }
  if (cur === null || cur === undefined) process.exit(2);
  if (typeof cur === "string") {
    process.stdout.write(cur);
    return;
  }
  process.stdout.write(JSON.stringify(cur));
});
' "$dotted_path"
}

pairs_json="$(node -e '
const csv = process.argv[1];
const pairs = csv.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
process.stdout.write(JSON.stringify(pairs));
' "$PAIRS_CSV")"

start_payload="$(node -e '
const strategyId = process.argv[1];
const pairs = JSON.parse(process.argv[2]);
const durationMinutes = Number(process.argv[3]);
const sampleIntervalSec = Number(process.argv[4]);
const topN = Number(process.argv[5]);
process.stdout.write(JSON.stringify({
  strategyId,
  pairs,
  durationMinutes,
  sampleIntervalSec,
  topN,
}));
' "$STRATEGY" "$pairs_json" "$DURATION_MINUTES" "$SAMPLE_INTERVAL_SEC" "$TOPN")"

echo "[1/7] health check"
if ! wait_for_health; then
  echo "service not ready: $BASE_URL/health (waited ${HEALTH_WAIT_SECONDS}s)"
  echo "tip: run 'npm run dev' in another terminal first"
  exit 1
fi

echo "[2/7] start discovery session"
start_response="$(request_with_status POST /api/v1/discovery/sessions/start "$start_payload")"
start_status="$(printf '%s\n' "$start_response" | sed -n '1p')"
start_resp="$(printf '%s\n' "$start_response" | sed '1d')"
if [[ "$start_status" != "200" ]]; then
  echo "start session failed: http=$start_status body=$start_resp"
  if [[ "$start_status" == "401" ]]; then
    echo "tip: export ALPHAOS_API_SECRET=<API_SECRET> and retry"
  fi
  exit 1
fi
session_id="$(printf '%s' "$start_resp" | json_get "sessionId" 2>/dev/null || true)"
if [[ -z "$session_id" ]]; then
  echo "start response missing sessionId: $start_resp"
  exit 1
fi
echo "session_id=$session_id"

echo "[3/7] wait ${WAIT_SECONDS}s for sampling"
sleep "$WAIT_SECONDS"

echo "[4/7] load session state"
session_resp="$(request GET "/api/v1/discovery/sessions/$session_id")"

echo "[5/7] load candidates + report"
candidates_resp="$(request GET "/api/v1/discovery/sessions/$session_id/candidates?limit=20")"
report_resp="$(request GET "/api/v1/discovery/sessions/$session_id/report" || true)"

approve_resp="null"
candidate_id="$(printf '%s' "$candidates_resp" | json_get "items.0.id" 2>/dev/null || true)"
if [[ "$AUTO_APPROVE" == "true" && -n "$candidate_id" ]]; then
  echo "[6/7] approve top candidate ($candidate_id) mode=$APPROVE_MODE"
  approve_payload="{\"candidateId\":\"$candidate_id\",\"mode\":\"$APPROVE_MODE\"}"
  approve_resp="$(request POST "/api/v1/discovery/sessions/$session_id/approve" "$approve_payload")"
else
  echo "[6/7] skip approve (AUTO_APPROVE=$AUTO_APPROVE, topCandidate=${candidate_id:-none})"
fi

stop_resp="null"
if [[ "$STOP_AFTER" == "true" ]]; then
  echo "[7/7] stop session (idempotent)"
  stop_resp="$(request POST "/api/v1/discovery/sessions/$session_id/stop" || true)"
else
  echo "[7/7] skip stop (STOP_AFTER=$STOP_AFTER)"
fi

approved_candidate_json="null"
if [[ -n "$candidate_id" ]]; then
  approved_candidate_json="\"$candidate_id\""
fi

{
  echo '{'
  echo '  "capturedAt": "'"$(date -Is)"'",'
  echo '  "baseUrl": "'"$BASE_URL"'",'
  echo '  "strategy": "'"$STRATEGY"'",'
  echo '  "pairsCsv": "'"$PAIRS_CSV"'",'
  echo '  "sessionId": "'"$session_id"'",'
  echo '  "session": '"$session_resp"','
  echo '  "candidates": '"$candidates_resp"','
  if [[ "$report_resp" == "" ]]; then
    echo '  "report": null,'
  else
    echo '  "report": '"$report_resp"','
  fi
  echo '  "approvedCandidateId": '"$approved_candidate_json"','
  echo '  "approveResult": '"$approve_resp"','
  echo '  "stopResult": '"$stop_resp"''
  echo '}'
} > "$OUT_JSON"

echo "done: $OUT_JSON"
