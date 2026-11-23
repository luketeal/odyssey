#!/usr/bin/env bash
# Opens, updates or closes the single "scraper-alert" GitHub issue.
#   alert.sh health            use reports/health.{json,md} from this run's scraper
#   alert.sh failure <job>     a job crashed or a deploy failed
# Needs GH_TOKEN (the workflow's token with issues: write) and the gh CLI (preinstalled on runners).
set -euo pipefail

LABEL="scraper-alert"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
gh label create "$LABEL" --color B60205 --description "Opened automatically by the nightly run" --force >/dev/null 2>&1 || true
OPEN=$(gh issue list --label "$LABEL" --state open --json number --jq '.[0].number // empty')

post() { # $1 title, $2 body file
  if [ -n "$OPEN" ]; then
    gh issue comment "$OPEN" --body-file "$2"
  else
    gh issue create --title "$1" --label "$LABEL" --body-file "$2"
  fi
}

case "${1:-}" in
  health)
    [ -f reports/health.json ] || { echo "No health report (the scraper didn't finish)."; exit 0; }
    if [ "$(jq -r .ok reports/health.json)" = "true" ]; then
      if [ -n "$OPEN" ]; then
        gh issue comment "$OPEN" --body-file reports/health.md
        gh issue close "$OPEN"
        echo "Healthy again: closed issue #$OPEN."
      else
        echo "Healthy."
      fi
    else
      ALERTS=$(jq '.alerts | length' reports/health.json)
      LOST=$(jq '.lost | length' reports/health.json)
      post "Scraper alert: ${ALERTS} problem(s), ${LOST} episode(s) no longer playable" reports/health.md
    fi
    ;;
  failure)
    BODY=$(mktemp)
    printf '❌ %s: the **%s** job failed.\n\nRun: %s\n' "$(date -u +%F)" "${2:-unknown}" "$RUN_URL" > "$BODY"
    post "Scraper alert: the ${2:-unknown} job failed" "$BODY"
    ;;
  *) echo "usage: alert.sh health | failure <job>" >&2; exit 2 ;;
esac
