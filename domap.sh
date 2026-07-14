#!/data/data/com.termux/files/usr/bin/bash
# domap.sh - Interactive DOM/UI mapper for Termux
# Wraps map.js (Playwright) with a simple menu, history, and report viewer.

set -euo pipefail

BASE_DIR="$HOME/domap"
OUT_DIR="$BASE_DIR/reports"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HISTORY_FILE="$BASE_DIR/history.txt"

mkdir -p "$OUT_DIR"
touch "$HISTORY_FILE"

C_RESET="\033[0m"; C_BOLD="\033[1m"; C_CYAN="\033[36m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"

banner() {
  echo -e "${C_CYAN}${C_BOLD}"
  echo "  ┌─────────────────────────────────┐"
  echo "  │        DOMap - Termux Edition    │"
  echo "  │   DOM / UI structure mapper      │"
  echo "  └─────────────────────────────────┘"
  echo -e "${C_RESET}"
}

check_deps() {
  if ! command -v node >/dev/null 2>&1; then
    echo -e "${C_RED}Node.js not found.${C_RESET} Install with: pkg install nodejs-lts"
    exit 1
  fi
  if [ ! -d "$SCRIPT_DIR/node_modules/playwright-core" ] && [ ! -d "$SCRIPT_DIR/node_modules/playwright" ]; then
    echo -e "${C_YELLOW}Playwright not installed in $SCRIPT_DIR yet.${C_RESET}"
    read -rp "Install now? (y/n): " yn
    if [[ "$yn" == "y" || "$yn" == "Y" ]]; then
      (cd "$SCRIPT_DIR" && npm install playwright-chromium --no-audit --no-fund)
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

run_map() {
  local url depth wait_sel out_name
  read -rp "URL to map: " raw_url
  [ -z "$raw_url" ] && { echo -e "${C_RED}No URL given.${C_RESET}"; return; }
  url=$(normalize_url "$raw_url")

  read -rp "Follow same-site links? Depth 0 = single page only (0-3, default 0): " depth
  depth=${depth:-0}

  read -rp "CSS selector to wait for before capturing (optional, e.g. #app): " wait_sel

  out_name=$(echo "$url" | sed -E 's#https?://##; s#[^a-zA-Z0-9]+#_#g' | cut -c1-60)
  ts=$(date +%Y%m%d_%H%M%S)
  report_dir="$OUT_DIR/${out_name}_${ts}"
  mkdir -p "$report_dir"

  echo -e "${C_GREEN}Mapping $url (depth=$depth)...${C_RESET}"
  node "$SCRIPT_DIR/map.js" \
    --url "$url" \
    --depth "$depth" \
    --wait-selector "${wait_sel:-}" \
    --out "$report_dir" \
  && echo "$(date '+%Y-%m-%d %H:%M') | $url | $report_dir" >> "$HISTORY_FILE" \
  && echo -e "${C_GREEN}Done.${C_RESET} Report: $report_dir/report.html"
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
  if [ -f "$json" ]; then
    node "$SCRIPT_DIR/summarize.js" "$json"
  else
    echo -e "${C_RED}dom.json missing in $dir${C_RESET}"
  fi
}

main_menu() {
  banner
  check_deps
  while true; do
    echo ""
    echo -e "${C_BOLD}1)${C_RESET} Map a new URL"
    echo -e "${C_BOLD}2)${C_RESET} List past reports"
    echo -e "${C_BOLD}3)${C_RESET} Open a report (HTML)"
    echo -e "${C_BOLD}4)${C_RESET} Print quick summary of a report"
    echo -e "${C_BOLD}5)${C_RESET} Exit"
    read -rp "Choose: " choice
    case "$choice" in
      1) run_map ;;
      2) list_reports ;;
      3) open_report ;;
      4) show_summary ;;
      5) echo "Bye."; exit 0 ;;
      *) echo -e "${C_RED}Invalid choice.${C_RESET}" ;;
    esac
  done
}

main_menu
