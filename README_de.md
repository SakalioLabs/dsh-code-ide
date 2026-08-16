# dsh-code-ide

[简体中文](README_zh-CN.md) | [English](README_en.md) | [日本語](README_ja.md) | **Deutsch**

`dsh-code-ide` ergänzt [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) um eine optionale IDE-Arbeitsoberfläche. Startseite, Chat, Sitzungen, Einstellungen und Werkzeugoberflächen von Harness bleiben unverändert erhalten.

> [!IMPORTANT]
> Das Projekt steht derzeit bei `0.1.0-alpha.0`. Es gibt noch weder eine öffentliche Version noch ein unterstütztes npm-Paket. Entwicklungsbasis ist der DeepSeek-Harness-Quellstand `47f9438` (Manifestlinie `0.1.0-rc.5`).

> Den abgesicherten, chinesischsprachigen Assistenten-Prompt für die Installation findest du unter [Schnellinstallation](README.md#快速安装推荐). Die folgenden Schritte bleiben der nachvollziehbare manuelle Rückweg.

> **Schneller Kurzweg:** `dsh plugin --profile web add github:SakalioLabs/dsh-code-ide`. In einem Harness-Quell-Checkout verwende stattdessen `pnpm dsh`. Meldet pnpm `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, übernimm den exakt ausgegebenen Key in die vorhandene `allowBuilds`-Map in `$DSH_HOME/profiles/web/pnpm-workspace.yaml` und führe den Befehl erneut aus.

## Was ist das?

Nach der Installation erscheint in Harness-Unterhaltungen ein nativer, optionaler Reiter **IDE**. Der Chat bleibt die Standardansicht. Die IDE wird erst beim Auswählen des Reiters erzeugt; nur für die gerade dort angezeigte Sitzung wird die normale Nachrichteneingabe ausgeblendet. Beim Wechsel zurück zum Chat steht sie wieder zur Verfügung.

Die Arbeitsoberfläche wird gleichursprünglich unter `/dsh-code-ide/` ausgeliefert und in den nativen Reiter eingebettet. Sie übernimmt den Arbeitsbereich der zugehörigen Sitzung und folgt dem Hell-/Dunkelmodus sowie `en`-/`zh`-Sprachwechseln von Harness. Die Integration ist rein ergänzend und forkt den Harness-Client nicht.

Die Bedienstruktur orientiert sich an bekannten VS-Code-Konventionen. Das Projekt ist jedoch kein Code--OSS-Build und stellt keinen VS-Code-Erweiterungshost bereit.

## Funktionsübersicht

- Begrenzter, verzögert geladener Explorer mit Dateisymbolen, erhaltenem Aufklappzustand, barrierearmer Tastatursteuerung und geprüften arbeitsbereichsrelativen Pfaden.
- CodeMirror-6-Editor mit 20 Sprachmodi, mehreren Reitern, bis zu vier Editorgruppen, Teilung nach oben oder rechts, Drag-and-drop-/Tastatur-Sortierung, dokumentbezogenem Undo sowie Zeilenenden-, Einrückungs- und Umbruchsteuerung.
- Versionsbewusstes Speichern und Konfliktbehandlung, Wiederherstellung gelöschter Dateien, browserlokale Hot-Exit-Wiederherstellung und Abfrage externer Änderungen.
- Quick Open, Arbeitsbereichssuche, reguläre Ausdrücke, Groß-/Kleinschreibung, Ganzwort- und include/exclude-Filter sowie Vorschau vor Ersetzungen. Ersetzungen ändern Puffer, speichern aber nicht automatisch.
- Befehlspalette und editierbare ein- oder zweistufige Tastenkürzel mit Konflikterkennung.
- Mehrere benannte xterm.js-Terminals im Arbeitsbereich mit Suchen, Leeren, Umbenennen, Neustarten, Unterbrechen und Beenden. Das Einklappen blendet das Terminal nur aus; das PTY wird weder ausgehängt noch beendet.
- Größenverstellbare Bereiche und barrierearmes Kompaktlayout bis 760 CSS-Pixel.
- Englische und vereinfachte chinesische Oberfläche, die Harness ohne Neuladen folgt.
- Eigenständige Route `/dsh-code-ide/` für Diagnose. Regulär wird die IDE über den Reiter **IDE** auf `/` geöffnet.

## Voraussetzungen

- Node.js `^22.19.0` oder `>=24.0.0`.
- Corepack und pnpm. Dieses Repository fixiert pnpm `10.17.0`; der unterstützte Harness-Checkout derzeit `11.7.0`.
- DeepSeek-Harness-Commit `47f9438`.
- Moderner gleichursprünglicher Browser mit WebSocket, `localStorage` und Web Locks. Ohne Web Locks werden Wiederherstellungsbesitz und Kürzelbearbeitung deaktiviert oder schreibgeschützt.
- Das Plattformprogramm aus `@vscode/ripgrep@1.18.0`.
- Exakt `node-pty@1.1.0` als Peer aus dem unterstützten Harness-Host-Graphen. Eine fehlende oder andere Version ist ein Kompatibilitätsfehler; keine zweite native Kopie installieren.

Auf npm ist derzeit `@deepseek-ai/dsh@0.1.0-rc.6` veröffentlicht. Dieses Alpha wurde dagegen noch nicht Ende-zu-Ende verifiziert und ist daher keine zugesicherte Installationsbasis dieses Projekts.

## Installation aus einer lokalen `.tgz`

Für eine Installation müssen `plugin add`, `plugin list`, `--dump-config` und `web` mit demselben `DSH_HOME` laufen. Wird `DSH_HOME` ausdrücklich gesetzt, muss es vor den folgenden Befehlen einmal in derselben Shell exportiert werden. Ein anderer Wert wählt einen anderen Profilspeicher.

Harness vorbereiten:

~~~sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 47f9438
corepack pnpm install --frozen-lockfile
corepack pnpm build
~~~

Dieses Projekt bauen und packen:

~~~sh
git clone https://github.com/SakalioLabs/dsh-code-ide.git
cd dsh-code-ide
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm pack
~~~

Das erzeugte Tarball aus dem Harness-Checkout per absolutem Pfad installieren:

~~~sh
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide-0.1.0-alpha.0.tgz
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

## Installation aus lokalem Quellcode

~~~sh
# In dsh-code-ide
corepack pnpm install --frozen-lockfile
corepack pnpm build

# In deepseek-harness@47f9438
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

Dies ist ein Entwicklungsablauf, kein Versprechen für eine veröffentlichte Installation. Stoppt `strictDepBuilds` einen Git-Abhängigkeitsbau, darf nur der exakt erzeugte Paketschlüssel geprüft und freigegeben werden. Die Richtlinie niemals global abschalten.

## Konfiguration

Der `dsh.bundle`-Patch des Pakets fügt automatisch genau diesen Eintrag ein:

~~~yaml
- insert:
    - id: dsh-code-ide
      name: dsh-code-ide
      config:
        maxFileBytes: 4194304
        terminalShell: auto
~~~

`examples/dsh-code-ide.bundle.patch.yml` ist nur ein Beispiel. Zusätzliches Kopieren in einen Benutzer-Patch würde den Eintrag verdoppeln. Nach Änderungen mit `--dump-config` prüfen, dass genau ein IDE-Eintrag und weiterhin alle offiziellen Web-Einträge vorhanden sind.

| Option | Standard | Bedeutung |
|---|---:|---|
| `maxFileBytes` | 4 MiB | Maximale Größe editierbarer UTF-8-Dateien beim Lesen/Schreiben. |
| `maxDirectoryEntries` | 5.000 | Direkte Einträge einer Verzeichnisabfrage. |
| `terminalShell` | `auto` | Nutzt `COMSPEC` unter Windows bzw. `SHELL` unter Unix. |
| `terminalArgs` | Shellstandard | Expliziter Argumentvektor für die Shell. |
| `maxTerminalSessions` | 8 | Hostweites Limit aktiver/wartender PTYs; maximal 64. |
| `maxConcurrentSearches` | 2 | Gleichzeitig verwaltete Suchen. |
| `searchTimeoutMs` | 30.000 | Suchfrist in Millisekunden. |

Weitere begrenzte Optionen stehen in [`src/host/plugin.ts`](src/host/plugin.ts). Einstellungen für strukturelle Operationen begrenzen Zulassung und Wiederherstellungsressourcen; die tatsächliche Verfügbarkeit bestimmt das geprüfte Host-Backend samt Dateisystem. Das Routenpräfix ist fest `/dsh-code-ide`.

## Verwendung

1. Das Profil `web` starten und `http://127.0.0.1:3080/` öffnen.
2. Eine Sitzung öffnen oder anlegen, die einem Harness-Arbeitsbereich zugeordnet ist.
3. Im Ansichtsumschalter **IDE** wählen.
4. Eine Textdatei im Explorer oder mit Quick Open öffnen, bearbeiten und speichern.
5. Mit **Search** suchen und Ersetzungen vorab prüfen; geänderte Puffer separat speichern.
6. Über die Terminalleiste ein Terminal anlegen. Befehle laufen als aktueller lokaler Benutzer im Arbeitsbereich.
7. Zum Chat zurückkehren, wenn Nachrichteneingabe oder offizielle Konversationsoberfläche benötigt werden.

Ist der Sitzungsarbeitsbereich noch im Laden, nicht verfügbar oder nicht zugeordnet, zeigt die IDE einen klaren Status, statt stillschweigend einen anderen Bereich auszuwählen.

Direktes Öffnen von `http://127.0.0.1:3080/dsh-code-ide/` startet den eigenständigen Modus mit Arbeitsbereichsauswahl und Harness-Bereich. Im eingebetteten Modus liefert die Elternsitzung diesen Kontext.

## Standardkürzel

| Aktion | Windows/Linux | macOS |
|---|---|---|
| Befehlspalette | `Ctrl+Shift+P` oder `F1` | `Cmd+Shift+P` oder `F1` |
| Quick Open | `Ctrl+P` | `Cmd+P` |
| Speichern | `Ctrl+S` | `Cmd+S` |
| Explorer / Suche | `Ctrl+Shift+E` / `Ctrl+Shift+F` | `Cmd+Shift+E` / `Cmd+Shift+F` |
| Zu Zeile springen | `Ctrl+G` | `Cmd+G` |
| Tastenkürzel | `Ctrl+K`, dann `Ctrl+S` | `Cmd+K`, dann `Cmd+S` |
| Terminal umschalten | `Ctrl+Backtick` | `Cmd+Backtick` |
| Zeilenumbruch | `Alt+Z` | `Option+Z` |

Der Explorer nutzt Pfeiltasten, Pos1/Ende, Enter, Leertaste, `*` und Zeichensuche. Fokussierte Editorreiter nutzen Links/Rechts, Pos1/Ende, Entf zum Schließen und `Alt+Shift+Links/Rechts` zum Verschieben. In der Terminalsuche bedeutet Enter „weiter“, Shift+Enter „zurück“ und Escape „schließen“.

## Einschränkungen und Sicherheit

- Frühes, an einen Quellstand gebundenes lokales Werkzeug. Andere Harness-Commits, bewegliche Branches und Registry-RCs sind bis zur Prüfung nicht unterstützt.
- Unter Windows x64 unterstützt der aktuelle Host in lokalen NTFS-Arbeitsbereichen das Anlegen von Dateien und Ordnern, Verschieben/Umbenennen sowie endgültiges Löschen. Auf anderen Plattformen oder nicht unterstützten Dateisystemen sind diese Operationen nicht verfügbar. Endgültiges Löschen verwendet nicht den Papierkorb; Zielpfad und Wiederherstellungsstatus vor der Bestätigung prüfen.
- Keine VS-Code-Erweiterungen, kein Extension Host, keine LSP-Vervollständigung, kein Debugger, keine Versionsverwaltungsoberfläche, kein Binäreditor und kein Multi-Root.
- IDE-Endpunkte verlangen Loopback und passenden Origin. Dieses MVP nicht im LAN oder Internet bereitstellen; Remote-Authentifizierung, TLS, Prozessisolation, Quoten und Audit-Logs fehlen.
- Pfadprüfung verhindert Traversal und beobachtete Symlinks, ist aber keine OS-Sandbox gegen andere Prozesse desselben Benutzers.
- Das Terminal besitzt die Rechte des aktuellen Benutzers. Verdächtige Umgebungsvariablennamen werden per Denyliste entfernt; das ist keine geheimnissichere Sandbox. Prozessbaum-Bereinigung erfolgt bestmöglich.
- Ungespeicherter Text und Kürzel können unverschlüsselt im gleichursprünglichen `localStorage` liegen. Wiederherstellung ist begrenzt und bestmöglich.
- Externe Änderungen werden abgefragt, nicht nativ überwacht. Terminalzustand wird nach hartem Neuladen nicht wiederhergestellt.
- Die Anwendung selbst unterstützt derzeit nur Englisch und vereinfachtes Chinesisch; diese Übersetzung bedeutet keine deutsche UI.

Vor der Arbeit mit nicht vertrauenswürdigen Repositories [`docs/security.md`](docs/security.md) und [`docs/compatibility.md`](docs/compatibility.md) lesen.

## Entwicklung und Tests

~~~sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
~~~

`pnpm build:host`, `build:client` und `build:harness-client` bauen die getrennten Ziele. `pnpm dev` startet Vite; die Host-APIs benötigen weiterhin eine Integrationsumgebung. `dist/` nicht von Hand bearbeiten.

## Lizenzen

Das Projekt steht unter der [MIT-Lizenz](LICENSE), Copyright © 2026 SakalioLabs. Die enthaltenen Seti-UI-Dateisymbole sind ebenfalls MIT-lizenziert; Hinweise stehen in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

## Aktualisieren und Deinstallieren

Harness stoppen, ein neues Tarball packen und den Profileintrag ersetzen:

~~~sh
corepack pnpm dsh plugin --profile web remove dsh-code-ide
corepack pnpm dsh plugin --profile web add /absolute/path/to/new/dsh-code-ide-0.1.0-alpha.0.tgz
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
~~~

Danach `pnpm dsh web` mit demselben `DSH_HOME` neu starten und den Browser hart neu laden. Zur Deinstallation `remove`, `plugin list` und `--dump-config` ebenfalls mit diesem `DSH_HOME` ausführen. Browserlokale Wiederherstellungs- und Kürzeldaten werden nicht automatisch gelöscht.

## Versionshinweis

Es wurde noch keine öffentliche Version veröffentlicht. Der aktuelle Quellstand `0.1.0-alpha.0` ist für lokale Quell- oder `.tgz`-Tests mit exakt der oben genannten Harness-Basis gedacht. Historische Testartefakte sind keine Releases und kein Nachweis für den aktuellen Quellstand.
