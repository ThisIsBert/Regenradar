# Regenradar

Minimale statische PWA fuer ein datensparsames Regenradar mit festem Heidelberg-Ausschnitt.

## Enthalten

- Leaflet-Karte fuer Heidelberg mit begrenztem Pan/Zoom und entsaettigter OpenStreetMap-Standardkarte (ohne API-Schluessel)
- Radar als DWD-WMS-Overlay
- Beim Laden zuerst ein zeitlich explizites Radarbild, danach automatisches Laden der Filmframes (`-60/+60 min` in 5-Minuten-Schritten)
- Radar-Anfragen enden nach maximal 20 Sekunden; fehlt das aktuelle Bild, werden bis zu zwei aeltere 5-Minuten-Slots versucht und als verzoegert gekennzeichnet
- Das Ladesymbol verschwindet mit dem ersten Bild; der Zeitverlauf wird schrittweise bedienbar. Fehler und unvollstaendige Filme werden angezeigt
- Fehlgeschlagene Anfragen werden nicht behalten; fruehere Prognoseframes werden bei Aktualisierungen auch im Browser neu geladen
- Kein Auto-Play: Navigation nur per Scrubbing ueber die Zeitleiste
- Zeitleiste signalisiert Verfuegbarkeit (grau ohne Verlauf, blau ab zwei geladenen Bildern)
- 14 explizite Stundenintervalle in Heidelberger Ortszeit; Temperatur/Bewoelkung am Intervallbeginn, Niederschlagsmenge und -wahrscheinlichkeit aus dem Datensatz am Intervallende (Bright Sky bilanziert die vorherige Stunde)
- SVG-Tropfen ausschliesslich nach Menge, Wahrscheinlichkeit separat in Prozent, fehlende Werte als Fragezeichen; Symbole fuer Gewitter, Schnee, Schneeregen, Hagel und Nebel
- Atmosphaerische Wolkenhintergruende mit kontrastreichen Beschriftungen; Tag/Nacht nach angenaehertem Sonnenstand fuer Heidelberg (NOAA: https://gml.noaa.gov/grad/solcalc/solareqns.PDF)
- Rohdaten-Cache fuer 15 Minuten; Stundenwechsel werden bei sichtbarer App alle 30 Sekunden und bei Rueckkehr geprueft. Fehlgeschlagene Aktualisierungen behalten noch passende Daten mit einem Hinweis
- Pull-to-refresh fuer manuelles Nachladen
- PWA-Basis mit `manifest.webmanifest` und `sw.js` (App-Shell-Caching)
- OSM-Tiles nutzen den Browser-HTTP-Cache gemaess den Server-Headern; Leaflet-CDN-Dateien werden lokal per Service Worker cache-first bedient

## Start lokal

- Dateien direkt mit einem statischen Webserver ausliefern (nicht ueber `file://`), z. B. VS Code Live Server.

## Deploy auf GitHub Pages

- Repo-Inhalt direkt auf Pages veroeffentlichen
- Alle Pfade sind relativ gehalten und damit mit Project-Pages kompatibel

## Tests

- `node --test tests/*.test.cjs` (Node.js, keine Zusatzpakete)
- Simuliert langsame/fehlgeschlagene Bildanfragen, Abbruch und Wiederholung, fehlende aktuelle Slots, progressive Zeitleiste und Cache-Aktualisierung
- Prueft Stundenintervall-Zuordnung, Datenluecken, Menge/Wahrscheinlichkeit, besondere Wetterlagen, Sonnenstand, Sommerzeit und Prognose-Cache mit Fehlerbehandlung
