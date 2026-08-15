#!/usr/bin/env bash
# Full randomised QA matrix. Exits non-zero if any run found a defect.
#
#   ./scripts/qa-sweep.sh [port]
#
# Always runs against a --mock server: the fuzzer types into whatever it finds,
# and mock mode cannot reach a real agent.
set -uo pipefail
PORT="${1:-4500}"
BASE="http://127.0.0.1:${PORT}/"

if [ "$PORT" = "4317" ]; then
  echo "refusing to fuzz port 4317 — that serves real agents" >&2
  exit 2
fi

profiles=(desktop laptop phone small landscape tablet)
seeds=(11 23 37 41 59 67 73 89 97 101 113 127)
fail=0
run=0

for i in "${!seeds[@]}"; do
  profile="${profiles[$((i % ${#profiles[@]}))]}"
  seed="${seeds[$i]}"
  steps=$(( 80 + (seed % 8) * 20 ))
  run=$((run + 1))
  out=$(node scripts/qa-fuzz.mjs --seed "$seed" --steps "$steps" --profile "$profile" --base "$BASE" 2>&1)
  if [ $? -ne 0 ]; then
    fail=$((fail + 1))
    echo "--- FAIL seed=$seed profile=$profile steps=$steps ---"
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); [print('   ', f['kind'], '|', f['detail'][:160]) for f in d['findings']]" 2>/dev/null || echo "$out" | tail -20
  else
    echo "ok   seed=$seed profile=$profile steps=$steps"
  fi
done

echo
echo "=== $run runs, $fail with findings ==="
exit $(( fail > 0 ? 1 : 0 ))
