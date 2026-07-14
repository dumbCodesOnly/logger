#!/data/data/com.termux/files/usr/bin/bash
# domap.sh - Interactive DOM/UI mapper for Termux
# Wraps map.js (Playwright) with a simple menu, history, and report viewer.

set -euo pipefail

BASE_DIR="$HOME/logger"
OUT_DIR="$BASE_DIR/reports"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HISTORY_FILE="$BASE_DIR/history.txt"

mkdir -p "$OUT_DIR"
touch "$HISTORY_FILE"

C_RESET="\033[0m"; C_BOLD="\033[1m"; C_CYAN="\033[36m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"

banner() {
  echo -e "${C_CYAN}${C_BOLD}"
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │        DOMap - Termux Edition    │"
  echo "  │   DOM / UI structure mapper      │"
  echo "  └─────────────────────────────────────────┘"
  echo -e "${C_RESET}"
}

# Token is stored outside the repo dir so it can never accidentally get
# committed/pushed. Stored with chmod 600 (owner read/write only).
BROWSERLESS_TOKEN_FILE="$BASE_DIR/browserless_token"

check_deps() {
  if ! command -v node >/dev/null 2>&1; then
    echo -e "${C_RED}Node.js not found.${C_RESET} Install with: pkg install nodejs-lts"
    exit 1
  fi
  if [ ! -d "$SCRIPT_DIR/node_modules/playwright-core" ] && [ ! -d "$SCRIPT_DIR/node_modules/playwright" ]; then
    echo -e "${C_YELLOW}Playwright not installed in $SCRIPT_DIR yet.${C_RESET}"
    read -rp "Install now? (y/n): " yn
    if [[ "$yn" == "y" || "$yn" == "Y" ]]; then
      # We only ever connect to a remote Browserless.io session, never launch
      # a local browser, so skip Playwright's bundled-browser download
      # entirely (saves ~300-450MB of unused binary).
      (cd "$SCRIPT_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright-chromium --no-audit --no-fund)
    else
      echo "Cannot continue without it. Exiting."
      exit 1
    fi
  fi
}

normalize_url() {
  local u="$1"
  if [[ "$u" != http://* && "$u" != https://* ]]; then
    u="https://$u"
  fi
  echo "$u"
}

get_browserless_ws_url() {
  local token
  if [ -f "$BROWSERLESS_TOKEN_FILE" ]; then
    token=$(cat "$BROWSERLESS_TOKEN_FILE")
  else
    read -rsp "Browserless API token (input hidden, stored in $BROWSERLESS_TOKEN_FILE): " token
    echo ""
    [ -z "$token" ] && { echo -e "${C_RED}No token given.${C_RESET}"; return 1; }
    echo -n "$token" > "$BROWSERLESS_TOKEN_FILE"
    chmod 600 "$BROWSERLESS_TOKEN_FILE"
  fi
  # Playwright-native protocol path, per Browserless docs (not the raw CDP path).
  echo "wss://production-sfo.browserless.io/chromium/playwright?token=${token}"
}

run_map() {
  local url depth wait_sel out_name ws_url
  read -rp "URL to map: " raw_url
  [ -z "$raw_url" ] && { echo -e "${C_RED}No URL given.${C_RESET}"; return; }
  url=$(normalize_url "$raw_url")

  read -rp "Follow same-site links? Depth 0 = single page only (0-3, default 0): " depth
  depth=${depth:-0}

  read -rp "CSS selector to wait for before capturing (optional, e.g. #app): " wait_sel

  read -rp "Attempt an image upload? (y/n): " do_upload
  local upload_selector="" upload_file="" click_after=""
  if [[ "$do_upload" == "y" || "$do_upload" == "Y" ]]; then
    read -rp "  File input CSS selector (blank = auto-detect first input[type=file]): " upload_selector
    read -rp "  Path to image file to upload (blank = generate a throwaway 1x1 PNG): " upload_file
    read -rp "  CSS selector of a submit/upload button to click afterward (optional): " click_after
  fi

  ws_url=$(get_browserless_ws_url) || return

  out_name=$(echo "$url" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#_#g' | cut -c1-60)
  ts=$(date +%Y%m%d_%H%M%S)
  report_dir="$OUT_DIR/${out_name}_${ts}"
  mkdir -p "$report_dir"

  echo -e "${C_GREEN}Mapping $url (depth=$depth) via Browserless.io...${C_RESET}"
  BROWSERLESS_WS_URL="$ws_url" node "$SCRIPT_DIR/map.js" \
    --url "$url" \
    --depth "$depth" \
    --wait-selector "${wait_sel:-}" \
    --upload-selector "${upload_selector:-}" \
    --upload-file "${upload_file:-}" \
    --click-after-upload "${click_after:-}" \
    --out "$report_dir" \
  && echo "$(date '+%Y-%m-%d %H:%M') | $url | $report_dir" >> "$HISTORY_FILE" \
  && echo -e "${C_GREEN}Done.${C_RESET} Report: $report_dir/report.html (see Network tab for logged requests)"
}

run_map_static() {
  local url out_name
  read -rp "URL to map (static, no browser): " raw_url
  [ -z "$raw_url" ] && { echo -e "${C_RED}No URL given.${C_RESET}"; return; }
  url=$(normalize_url "$raw_url")

  if [ ! -d "$SCRIPT_DIR/node_modules/cheerio" ]; then
    echo -e "${C_YELLOW}cheerio not installed in $SCRIPT_DIR yet.${C_RESET}"
    read -rp "Install now? (y/n): " yn
    if [[ "$yn" == "y" || "$yn" == "Y" ]]; then
      (cd "$SCRIPT_DIR" && npm install cheerio --no-audit --no-fund)
    else
      echo "Cannot continue without it."
      return
    fi
  fi

  out_name=$(echo "$url" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#_#g' | cut -c1-60)
  ts=$(date +%Y%m%d_%H%M%S)
  report_dir="$OUT_DIR/${out_name}_${ts}_static"
  mkdir -p "$report_dir"

  echo -e "${C_GREEN}Mapping $url (static fetch, no JS)...${C_RESET}"
  node "$SCRIPT_DIR/map-static.js" \
    --url "$url" \
    --out "$report_dir" \
  && echo "$(date '+%Y-%m-%d %H:%M') | $url | $report_dir" >> "$HISTORY_FILE" \
  && echo -e "${C_GREEN}Done.${C_RESET} JSON: $report_dir/dom-static.json"
}

list_reports() {
  echo -e "${C_CYAN}Past reports:${C_RESET}"
  if [ ! -s "$HISTORY_FILE" ]; then
    echo "  (none yet)"
    return
  fi
  nl -w2 -s') ' "$HISTORY_FILE"
}

open_report() {
  list_reports
  [ ! -s "$HISTORY_FILE" ] && return
  read -rp "Enter number to open (or blank to cancel): " n
  [ -z "$n" ] && return
  line=$(sed -n "${n}p" "$HISTORY_FILE") || true
  [ -z "$line" ] && { echo "Invalid selection."; return; }
  dir=$(echo "$line" | awk -F'| ' '{print $NF}' | xargs)
  html="$dir/report.html"
  if [ -f "$html" ]; then
    termux-open "$html" 2>/dev/null || echo "Open manually: $html"
  else
    echo -e "${C_RED}Report file missing: $html${C_RESET}"
  fi
}

show_summary() {
  list_reports
  [ ! -s "$HISTORY_FILE" ] && return
  read -rp "Enter number to summarize: " n
  line=$(sed -n "${n}p" "$HISTORY_FILE") || true
  [ -z "$line" ] && { echo "Invalid selection."; return; }
  dir=$(echo "$line" | awk -F'| ' '{print $NF}' | xargs)
  json="$dir/dom.json"
  [ ! -f "$json" ] && json="$dir/dom-static.json"
  if [ -f "$json" ]; then
    node "$SCRIPT_DIR/summarize.js" "$json"
  else
    echo -e "${C_RED}No dom.json or dom-static.json found in $dir${C_RESET}"
  fi
}

main_menu() {
  banner
  check_deps
  while true; do
    echo ""
    echo -e "${C_BOLD}1)${C_RESET} Map a new URL (Browserless.io, JS-rendered)"
    echo -e "${C_BOLD}2)${C_RESET} Map a new URL (static fetch, no browser)"
    echo -e "${C_BOLD}3)${C_RESET} List past reports"
    echo -e "${C_BOLD}4)${C_RESET} Open a report (HTML)"
    echo -e "${C_BOLD}5)${C_RESET} Print quick summary of a report"
    echo -e "${C_BOLD}6)${C_RESET} Exit"
    read -rp "Choose: " choice
    case "$choice" in
      1) run_map ;;
      2) run_map_static ;;
      3) list_reports ;;
      4) open_report ;;
      5) show_summary ;;
      6) echo "Bye."; exit 0 ;;
      *) echo -e "${C_RED}Invalid choice.${C_RESET}" ;;
    esac
  done
}

main_menu
