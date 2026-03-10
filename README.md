# Regenradar

Minimale statische PWA fuer ein datensparsames Regenradar mit festem Heidelberg-Ausschnitt.

## Enthalten

- Fester Leaflet-Ausschnitt mit OSM-Basiskarte (ohne Pan/Zoom)
- Radar/Radolan als DWD-WMS-Overlay
- Beim Laden zuerst aktuelles Lagebild, danach automatisches Laden der Filmframes (`-60/+60 min` in 5-Minuten-Schritten)
- Kein Auto-Play: Navigation nur per Scrubbing ueber die Zeitleiste
- Zeitleiste signalisiert Ladezustand (grau beim Laden, blau nach Abschluss)
- Pull-to-refresh fuer manuelles Nachladen
- PWA-Basis mit `manifest.webmanifest` und `sw.js` (App-Shell-Caching)
- OSM-Tiles und Leaflet-CDN-Dateien werden nach erstem Laden lokal per Service Worker cache-first bedient

## Start lokal

- Dateien direkt mit einem statischen Webserver ausliefern (nicht ueber `file://`), z. B. VS Code Live Server.

## Deploy auf GitHub Pages

- Repo-Inhalt direkt auf Pages veroeffentlichen
- Alle Pfade sind relativ gehalten und damit mit Project-Pages kompatibel
