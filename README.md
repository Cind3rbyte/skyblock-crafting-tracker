# Skyblock Crafting Tracker

Gemeinsame Materialliste für Hypixel SkyBlock auf GitHub Pages. Abhaken wird per Firebase Realtime Database live zwischen allen Besuchern synchronisiert. Zugriff über ein gemeinsames Gruppen-Passwort.

## Neues Item hinzufügen

1. ID (NEU-Repo-Name, z. B. `TITANIUM_DRILL_DR_X355`) in `data/targets.json` eintragen.
2. Optional Beschaffungshinweise für neue Rohstoffe in `data/hints.json` ergänzen.
3. `node scripts/build-data.mjs` ausführen und `data/items.json` committen.

## Firebase einrichten

1. In der Firebase-Konsole ein Projekt anlegen, Realtime Database erstellen (Region Europa).
2. Projekteinstellungen, Web-App hinzufügen, die `firebaseConfig` in `firebase-config.js` eintragen (inkl. `databaseURL`).
3. Unter Realtime Database, Regeln einfügen:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "lists": {
      "<SHA-256 DES PASSWORTS>": {
        ".read": true,
        ".write": true,
        "$item": {
          "$entry": {
            ".validate": "newData.hasChildren(['c', 'h']) && newData.child('c').isBoolean() && newData.child('h').isNumber() && newData.child('h').val() >= 0 && newData.child('h').val() <= 10000000"
          }
        }
      }
    }
  }
}
```

Das Passwort wird im Browser per SHA-256 gehasht und dient als Datenbankpfad. Die Regeln erlauben nur genau diesen einen Pfad, jedes andere Passwort wird abgelehnt. Die Firebase-Config ist öffentlich und kein Geheimnis; der Schutz liegt im Passwort-Pfad.

## Lokal testen

```bash
node scripts/serve.mjs
```

Ohne Firebase-Config läuft die Seite im Nur-lokal-Modus (kein Sync).

## Quellen

Rezepte: NotEnoughUpdates-REPO. Namen und Seltenheit: Hypixel SkyBlock API.
