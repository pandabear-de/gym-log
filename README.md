# Gym Log

Offline-Web-App fürs iPhone zum Protokollieren von Gerätetraining: Gerät, Einstellung, Gewicht, Wiederholungen, Pausentimer.

- Daten liegen nur im Browser-Speicher der Home-Bildschirm-App (localStorage), kein Server.
- Export als JSON über das iOS-Teilen-Menü → iCloud Drive / AirDrop.
- Optional: Pausen zusätzlich als iOS-Timer über Kurzbefehle starten (Apple Watch vibriert).

## Installation (iPhone)
1. GitHub-Pages-URL in **Safari** öffnen.
2. Teilen → **Zum Home-Bildschirm**.
3. Nur noch über das Home-Bildschirm-Icon öffnen (eigener Speicher, getrennt von Safari).

## Kurzbefehl für die Apple Watch
Kurzbefehle → neuer Kurzbefehl → Aktion „Timer starten“ → Dauer = Variable „Kurzbefehleingabe“, Einheit Sekunden → Name „Gym Pause“.
In der App unter Export → Apple Watch einschalten.

## Update ausrollen
Dateien ändern, in `sw.js` `CACHE` hochzählen (z. B. `gymlog-v2`), committen, pushen.
Die App lädt die neue Version im Hintergrund; sie ist beim übernächsten Öffnen aktiv.

## Exportformat (schemaVersion 1, ab App 1.3.0 erweitert)
```json
{
  "app": "gym-log", "schemaVersion": 1, "exportedAt": "ISO-8601 UTC",
  "machines": [{ "id", "name", "kind": "strength|cardio", "cardioType": "laufband|rad|stepper",
                 "setup", "restSec", "note", "created" }],
  "sessions": [{
    "id", "source": "import (nur übernommene Altdaten)", "start", "end", "durationMin", "note",
    "exercises": [{
      "machineId", "machine", "kind", "setup", "restPlannedSec", "effort": "easy|ok|hard|null", "note",
      "sets": [{ "set", "weightKg", "reps", "done", "doneAt", "restPlannedSec", "restTakenSec" }],
      "cardio": { "type", "minutes", "speedKmh", "inclinePct", "level", "watts", "startedAt", "doneAt", "done" }
    }]
  }],
  "activeSession": null
}
```
- `restTakenSec` = tatsächlich gelaufene Pause (bis Ablauf oder „Weiter“).
- `cardio` nur bei `kind: "cardio"`; `sets` ist dann leer. Werte = Hauptwert der Einheit.
- `effort` = eigenes Empfinden pro Gerät (leicht / passend / schwer).

## Lokal testen
```
python3 -m http.server 8765
```
Icons neu erzeugen: `python3 tools/make_icons.py icons`
