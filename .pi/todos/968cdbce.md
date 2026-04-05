{
  "id": "968cdbce",
  "title": "Pi extension: core scaffold + lifecycle",
  "tags": [
    "midi-monitor",
    "extension"
  ],
  "status": "done",
  "created_at": "2026-04-05T12:18:20.813Z"
}

Implemented `index.ts`:
- Extension factory with session_start/session_shutdown lifecycle
- Spawns Python process, reads PORT from stdout, creates MidiIPC client
- Restores channel config from session entries on start/tree navigation
- Persists config via pi.appendEntry()
- /midi command (start/stop/restart)
- /project command for naming projects
- Ctrl+M shortcut to toggle widget
