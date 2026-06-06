#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${ALPHAOS_BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${ALPHAOS_API_SECRET:-${API_SECRET:-}}"

print_usage() {
  cat <<'EOF'
Usage: bash scripts/judge-demo.sh [--help]

Runs a judge-friendly demo flow with safe defaults:
1) prerequisite checks
2) local fixture demo: npm run demo:living-assistant
3) API-backed discovery demo when server is reachable/authenticated

Environment:
  ALPHAOS_BASE_URL     API base URL (default: http://127.0.0.1:3000)
  ALPHAOS_API_SECRET   Bearer token for authenticated API demos (optional)
  API_SECRET           Fallback token source if ALPHAOS_API_SECRET is unset
EOF
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

print_step() {
  printf '\n== %s ==\n' "$1"
}

print_info() {
  printf '[info] %s\n' "$1"
}

print_warn() {
  printf '[warn] %s\n' "$1"
}

print_error() {
  printf '[error] %s\n' "$1" >&2
}

http_status() {
  local path="$1"
  local -a args
  args=(-sS -o /dev/null -w "%{http_code}")
  if [[ -n "$API_TOKEN" ]]; then
    args+=(-H "Authorization: Bearer $API_TOKEN")
  fi
  curl "${args[@]}" "$BASE_URL$path" 2>/dev/null || echo "000"
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      print_error "Unknown argument: $arg"
      print_usage
      exit 1
      ;;
  esac
done

print_step "Judge Demo Overview"
print_info "This script reuses existing repo demos with conservative defaults."
print_info "Planned flow:"
print_info "  1) npm run demo:living-assistant"
print_info "  2) npm run discovery:smoke (only if $BASE_URL is ready and auth passes)"

print_step "Prerequisite Checks"
missing=0
for cmd in node npm curl; do
  if has_cmd "$cmd"; then
    print_info "Found $cmd"
  else
    print_error "Missing required command: $cmd"
    missing=1
  fi
done

if [[ ! -d node_modules ]]; then
  print_warn "node_modules not found. Run: npm install"
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

print_step "Run Stable Local Demo"
if npm run demo:living-assistant; then
  print_info "Local demo completed."
else
  print_error "Local demo failed."
  exit 1
fi

print_step "Check API Availability"
health_status="$(http_status "/health")"
if [[ "$health_status" != "200" ]]; then
  print_warn "API not reachable at $BASE_URL (health status: $health_status)."
  print_info "To run API-backed demo next:"
  print_info "  Terminal A: npm run dev"
  print_info "  Terminal B: npm run demo:judge"
  exit 0
fi

print_info "API health check passed at $BASE_URL."

print_step "Check API Auth"
auth_status="$(http_status "/api/v1/discovery/sessions/active")"
if [[ "$auth_status" == "401" || "$auth_status" == "403" ]]; then
  print_warn "API auth rejected (status $auth_status)."
  if [[ -z "$API_TOKEN" ]]; then
    print_info "Set ALPHAOS_API_SECRET to your API secret and rerun."
  else
    print_info "Verify ALPHAOS_API_SECRET/API_SECRET matches the running server."
  fi
  print_info "Skipping API-backed discovery demo."
  exit 0
fi

if [[ "$auth_status" != "200" ]]; then
  print_warn "Discovery endpoint readiness is unclear (status $auth_status)."
  print_info "Skipping API-backed discovery demo."
  exit 0
fi

print_step "Run API-Backed Discovery Demo"
if npm run discovery:smoke; then
  print_info "Discovery demo completed."
  print_info "Review evidence artifacts under demo-output/."
else
  print_warn "Discovery demo failed. Check API logs and env configuration."
  exit 1
fi

print_step "Done"
print_info "Primary outputs are available in demo-output/."
