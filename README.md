# Regenradar

Minimale statische PWA fuer ein datensparsames Regenradar mit festem Heidelberg-Ausschnitt.

## Enthalten

- Fester Leaflet-Ausschnitt mit OSM-Basiskarte (ohne Pan/Zoom)
- Radar als DWD-WMS-Overlay
- Beim Laden zuerst ein zeitlich explizites Radarbild, danach automatisches Laden der Filmframes (`-60/+60 min` in 5-Minuten-Schritten)
- Radar-Anfragen enden nach maximal 20 Sekunden; fehlt das aktuelle Bild, werden bis zu zwei aeltere 5-Minuten-Slots versucht und als verzoegert gekennzeichnet
- Das Ladesymbol verschwindet mit dem ersten Bild; der Zeitverlauf wird schrittweise bedienbar. Fehler und unvollstaendige Filme werden angezeigt
- Fehlgeschlagene Anfragen werden nicht behalten; fruehere Prognoseframes werden bei Aktualisierungen auch im Browser neu geladen
- Kein Auto-Play: Navigation nur per Scrubbing ueber die Zeitleiste
- Zeitleiste signalisiert Verfuegbarkeit (grau ohne Verlauf, blau ab zwei geladenen Bildern)
- Kompakte Stundenprognose fuer Heidelberg mit Bright Sky (`Temperatur`, `Wolken`, `Regenwahrscheinlichkeit`, falls verfuegbar)
- Pull-to-refresh fuer manuelles Nachladen
- PWA-Basis mit `manifest.webmanifest` und `sw.js` (App-Shell-Caching)
- OSM-Tiles und Leaflet-CDN-Dateien werden nach erstem Laden lokal per Service Worker cache-first bedient

## Start lokal

- Dateien direkt mit einem statischen Webserver ausliefern (nicht ueber `file://`), z. B. VS Code Live Server.

## Deploy auf GitHub Pages

- Repo-Inhalt direkt auf Pages veroeffentlichen
- Alle Pfade sind relativ gehalten und damit mit Project-Pages kompatibel

## Tests

- `node --test tests/radar-loading.test.cjs` (Node.js, keine Zusatzpakete)
- Simuliert langsame/fehlgeschlagene Bildanfragen, Abbruch und Wiederholung, fehlende aktuelle Slots, progressive Zeitleiste und Cache-Aktualisierung
