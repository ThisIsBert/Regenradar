# Regenradar

Minimale statische PWA fuer ein datensparsames Regenradar mit festem Heidelberg-Ausschnitt.

## Enthalten

- Fester Leaflet-Ausschnitt mit OSM-Basiskarte (ohne Pan/Zoom)
- Radar als einzelner DWD-WMS-GetMap-Overlay-Request
- Basisfall ohne Animation: nur aktuelles Radarbild
- Optionaler Radarfilm: Rueckblick und Vorhersage (`-60/+60 min`) in 5-Minuten-Schritten
- Manuelles Aktualisieren + automatisches Update alle 5 Minuten
- PWA-Basis mit `manifest.webmanifest` und `sw.js` (App-Shell-Caching)
- OSM-Tiles und Leaflet-CDN-Dateien werden nach erstem Laden lokal per Service Worker cache-first bedient

## Start lokal

- Dateien direkt mit einem statischen Webserver ausliefern (nicht ueber `file://`), z. B. VS Code Live Server.

## Deploy auf GitHub Pages

- Repo-Inhalt direkt auf Pages veroeffentlichen
- Alle Pfade sind relativ gehalten und damit mit Project-Pages kompatibel
