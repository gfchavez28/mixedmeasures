#!/usr/bin/env bash
# Launch the Mixed Measures backend against the Track J stress DB (Pass B).
#
#   bash backend/run-stress-backend.sh            # launch on the existing stress.db
#   bash backend/run-stress-backend.sh --reseed   # rebuild stress.db + merge bundle first (clean slate)
#
# Then in a SECOND terminal:  cd frontend && npm run dev   (http://localhost:5173)
# Then in the browser console (one-time, clears UI prefs that bleed across DBs):
#   Object.keys(localStorage).filter(k=>/^mm-/.test(k)).forEach(k=>localStorage.removeItem(k))
#
# NOTE: stop any other backend on port 8000 first (e.g. your normal dev.db one),
# or this will fail to bind. Real dev.db is never touched by the stress run.
set -euo pipefail
cd "$(dirname "$0")"                 # → backend/
source venv/bin/activate

export MM_DATABASE_PATH=stress.db
export MM_DATA_DIR=stress_data
export MM_BACKUP_DIR=stress_data/backups

if [[ "${1:-}" == "--reseed" ]]; then
  echo "Re-seeding stress.db + merge bundle (clean slate)…"
  python seed_trackj_stress.py
  python seed_trackj_merge_files.py
  echo
fi

echo "Backend → http://localhost:8000  (DB: $MM_DATABASE_PATH)"
exec uvicorn app.main:app --reload --port 8000
