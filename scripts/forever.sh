#!/bin/sh
# npm run forever: Peg Hunter that restarts itself after a crash (Termux or any server).
# Ctrl+C stops it for good; a crash restarts it after 10 seconds.
while true; do
  npx tsx src/hunter/main.ts "$@"
  code=$?
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then echo "stopped"; break; fi
  echo "Peg Hunter exited (code $code); restarting in 10 s (Ctrl+C to stop)"
  sleep 10 || break
done
