# dsh-code-ide

[简体中文](README_zh-CN.md) | [English](README_en.md) | [日本語](README_ja.md) | **Deutsch**

<p align="center">
  <img src="docs/assets/dsh-code-ide-demo.png" alt="dsh-code-ide in DeepSeek Harness mit Dateiexplorer, Code-Editor und Terminal in einer browserbasierten IDE-Arbeitsoberfläche" width="100%" />
</p>

`dsh-code-ide` ergänzt [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) um eine optionale IDE-Arbeitsoberfläche. Startseite, Chat, Sitzungen, Einstellungen und Werkzeugoberflächen von Harness bleiben unverändert erhalten.

> [!IMPORTANT]
> `v0.1.0-alpha.0` ist ein GitHub-**Prerelease** mit einem vorgebauten Plugin-Paket; es wird nicht auf npm veröffentlicht. Der aktuelle Branch `main` wurde gegen DeepSeek Harness `0.1.1-rc.2` (Tag `dsh-v0.1.1-rc.2`, Quell-Commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) auf Kompatibilität geprüft. Andere Commits und künftige npm-RCs liegen außerhalb dieses Kompatibilitätsversprechens.

> Den abgesicherten, chinesischsprachigen Assistenten-Prompt für die Installation findest du unter [Schnellinstallation](README.md#快速安装推荐). Die folgenden Schritte bleiben der nachvollziehbare manuelle Rückweg.

> **Schnellinstallation:** `dsh plugin --profile web add github:SakalioLabs/dsh-code-ide`. In einem Harness-Quell-Checkout verwende `pnpm dsh` statt `dsh`. Dieses Repository enthält ein mit dem Quellstand synchron gehaltenes, vorgebautes `dist/` und definiert kein Build-Skript für die Installation. Eine Installation über GitHub baut das Plugin daher nicht auf dem Rechner des Nutzers neu und benötigt keinen `allowBuilds`-Eintrag für `dsh-code-ide`.

## Was ist das?

Nach der Installation erscheint in Harness-Unterhaltungen ein nativer, optionaler Reiter **IDE**. Der Chat bleibt die Standardansicht. Die IDE wird erst beim Auswählen des Reiters erzeugt; nur für die gerade dort angezeigte Sitzung wird die normale Nachrichteneingabe ausgeblendet. Beim Wechsel zurück zum Chat steht sie wieder zur Verfügung.

Die Arbeitsoberfläche wird gleichursprünglich unter `/dsh-code-ide/` ausgeliefert und in den nativen Reiter eingebettet. Sie übernimmt den Arbeitsbereich der zugehörigen Sitzung und folgt dem Hell-/Dunkelmodus sowie `en`-/`zh`-Sprachwechseln von Harness. Die Integration ist rein ergänzend und forkt den Harness-Client nicht.

Die Bedienstruktur orientiert sich an bekannten VS-Code-Konventionen. Das Projekt ist jedoch kein Code--OSS-Build und stellt keinen VS-Code-Erweiterungshost bereit.

## Funktionsübersicht

- Begrenzter, verzögert geladener Explorer mit Dateisymbolen, erhaltenem Aufklappzustand, barrierearmer Tastatursteuerung und geprüften arbeitsbereichsrelativen Pfaden.
- Vollständige Unterstützung für Anlegen, Verschieben/Umbenennen und endgültiges Löschen in lokalen NTFS-Arbeitsbereichen unter Windows x64. Linux-x64-Hosts mit erfolgreicher `openat2`-Laufzeitprüfung sowie lokale APFS-Arbeitsbereiche unter macOS x64/arm64 mit erfolgreicher `libSystem`-Laufzeitprüfung unterstützen nur das Anlegen von Dateien und Ordnern.
- CodeMirror-6-Editor mit 20 Sprachmodi, mehreren Reitern, bis zu vier Editorgruppen, Teilung nach oben oder rechts, Drag-and-drop-/Tastatur-Sortierung, dokumentbezogenem Undo sowie Zeilenenden-, Einrückungs- und Umbruchsteuerung.
- Umschaltung zwischen Quelltext und sicherer Vorschau für `.md`, `.markdown` und `.mdx`; die Vorschau zeigt den aktuellen Puffer einschließlich ungespeicherter Änderungen.
- Schreibgeschützte Vorschau gängiger Bilder (PNG, JPEG, GIF, WebP, AVIF), Audioformate (MP3, WAV, OGG, FLAC) und Videos (MP4, WebM, MOV). Audio und Video verwenden native Browsersteuerung und Range-Streaming und starten nie automatisch.
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
- DeepSeek Harness `0.1.1-rc.2` (Tag `dsh-v0.1.1-rc.2`, Quell-Commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`).
- Moderner gleichursprünglicher Browser mit WebSocket, `localStorage` und Web Locks. Ohne Web Locks werden Wiederherstellungsbesitz und Kürzelbearbeitung deaktiviert oder schreibgeschützt.
- Das Plattformprogramm aus `@vscode/ripgrep@1.18.0`.
- Das vom geprüften Harness-Host-Graphen bereitgestellte Peer `node-pty@1.2.0-beta.15`. Keine zweite native Kopie installieren.

Auf npm ist derzeit `@deepseek-ai/dsh@0.1.1-rc.2` veröffentlicht. Der aktuelle Branch `main` wurde gegen diese Veröffentlichung, ihren Tag und ihren Quell-Commit auf Kompatibilität geprüft. Für eine reproduzierbare Umgebung den untenstehenden Tag oder Commit fixieren.

## Installation über GitHub (empfohlen)

Für eine Installation müssen `plugin add`, `plugin list`, `--dump-config` und `web` mit demselben `DSH_HOME` laufen. Wird `DSH_HOME` ausdrücklich gesetzt, muss es vor den folgenden Befehlen einmal in derselben Shell exportiert werden. Ein anderer Wert wählt einen anderen Profilspeicher.

Harness vorbereiten:

~~~sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout dsh-v0.1.1-rc.2 # b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
corepack pnpm install --frozen-lockfile
corepack pnpm build
~~~

Den aktuellen `main`-Build direkt aus dem Harness-Checkout installieren:

~~~sh
corepack pnpm dsh plugin --profile web add github:SakalioLabs/dsh-code-ide
corepack pnpm dsh plugin --profile web list --depth 0
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

Das eingecheckte `dist/` wird durch CI geprüft. Dieser Befehl führt keinen Plugin-Build aus und benötigt keinen `allowBuilds`-Eintrag, folgt aber dem beweglichen Branch `main`.

Für eine feste, prüfbare oder offline archivierte Installation zuerst Release-Paket und Prüfsumme herunterladen:

~~~sh
curl -fLO https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/dsh-code-ide-0.1.0-alpha.0.tgz
curl -fLO https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/dsh-code-ide-0.1.0-alpha.0.tgz.sha256
sha256sum -c dsh-code-ide-0.1.0-alpha.0.tgz.sha256
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide-0.1.0-alpha.0.tgz
~~~

Prüfung unter Windows PowerShell:

~~~powershell
$asset = "dsh-code-ide-0.1.0-alpha.0.tgz"
Invoke-WebRequest "https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/$asset" -OutFile $asset
Invoke-WebRequest "https://github.com/SakalioLabs/dsh-code-ide/releases/download/v0.1.0-alpha.0/$asset.sha256" -OutFile "$asset.sha256"
$expected = (Get-Content "$asset.sha256").Split()[0].ToUpperInvariant()
$actual = (Get-FileHash $asset -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "SHA-256 mismatch" }
~~~

## Installation aus lokalem Quellcode

~~~sh
# In dsh-code-ide
corepack pnpm install --frozen-lockfile
corepack pnpm build

# In deepseek-harness@dsh-v0.1.1-rc.2
corepack pnpm dsh plugin --profile web add /absolute/path/to/dsh-code-ide
corepack pnpm dsh plugin --profile web list
corepack pnpm dsh --profile web --dump-config
corepack pnpm dsh web
~~~

Dies ist ein Entwicklungsablauf, nicht der empfohlene GitHub-Installationsweg. Um den vorgebauten Branch `main` ohne lokalen Checkout zu installieren, verwende:

~~~sh
corepack pnpm dsh plugin --profile web add github:SakalioLabs/dsh-code-ide
~~~

Das Repository enthält durch CI geprüftes, vorgebautes `dist/` und kein Build-Skript für die Installation; dieser Befehl benötigt daher keinen `allowBuilds`-Eintrag. Wenn Reproduzierbarkeit oder Prüfung wichtig sind, verwende das feste Release-Paket und die Prüfsumme oben.

## Konfiguration

Der `dsh.bundle`-Patch des Pakets fügt automatisch genau diesen Eintrag ein:

~~~yaml
- insert:
    - id: dsh-code-ide
      name: dsh-code-ide
      config:
        maxFileBytes: 4194304
        maxMediaBytes: 536870912
        terminalShell: auto
~~~

`examples/dsh-code-ide.bundle.patch.yml` ist nur ein Beispiel. Zusätzliches Kopieren in einen Benutzer-Patch würde den Eintrag verdoppeln. Nach Änderungen mit `--dump-config` prüfen, dass genau ein IDE-Eintrag und weiterhin alle offiziellen Web-Einträge vorhanden sind.

| Option | Standard | Bedeutung |
|---|---:|---|
| `maxFileBytes` | 4 MiB | Maximale Größe editierbarer UTF-8-Dateien beim Lesen/Schreiben. |
| `maxMediaBytes` | 512 MiB | Maximale Größe einer schreibgeschützten Medienvorschau; konfigurierbar bis zur festen Obergrenze von 8 GiB. |
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
4. Eine Text-, Markdown- oder unterstützte Mediendatei im Explorer oder mit Quick Open öffnen. Markdown kann zwischen Quelltext und Vorschau wechseln; die Vorschau folgt dem aktuellen ungespeicherten Puffer.
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
- Windows x64 verwendet in lokalen NTFS-Arbeitsbereichen eine starke Handle-Eingrenzung (handle containment) und unterstützt das Anlegen von Dateien und Ordnern, Verschieben/Umbenennen sowie endgültiges Löschen vollständig. Linux x64 unterstützt das Anlegen von Dateien und Ordnern nur nach erfolgreicher `openat2`-Laufzeitprüfung; auf Linux ARM64 und anderen Architekturen bleiben Strukturänderungen fail-closed, bis ein `openat2`-Shim mit fester Signatur verfügbar ist. macOS x64/arm64 unterstützt das Anlegen von Dateien und Ordnern nur in lokalen APFS-Arbeitsbereichen nach erfolgreicher `libSystem`-Laufzeitprüfung. Verschieben, Umbenennen und Löschen bleiben unter Linux und macOS deaktiviert. Deren trusted-local-`dirfd`-Stufe schützt nur vor Pfad-Traversal aus Browseranfragen, vorhandenen oder konkurrierenden symbolischen Links und Mount-Grenzüberschreitungen; sie widersteht keinem aktiven lokalen Prozess mit derselben UID, der rename/reparent ausführt. Fehlgeschlagene Prüfungen führen zu fail-closed; ein unbestimmtes Ergebnis nach dem Commit wird zu `recoveryRequired` oder fail-closed. Durchsuchen, Bearbeiten, Speichern, Suche und Terminals bleiben verfügbar. Endgültiges Löschen unter Windows verwendet nicht den Papierkorb; Zielpfad und Wiederherstellungsstatus vor der Bestätigung prüfen.
- Die Vorschau fügt keine Kompatibilität zu VS-Code-Erweiterungen hinzu. Extension Host, Marketplace, LSP-Vervollständigung, Debugger, Versionsverwaltungsoberfläche, beliebige Binärbearbeitung und Multi-Root bleiben nicht unterstützt.
- IDE-Endpunkte verlangen Loopback und passenden Origin. Dieses MVP nicht im LAN oder Internet bereitstellen; Remote-Authentifizierung, TLS, Prozessisolation, Quoten und Audit-Logs fehlen.
- Pfadprüfung verhindert Traversal und beobachtete Symlinks, ist aber keine OS-Sandbox gegen andere Prozesse desselben Benutzers.
- Das Terminal besitzt die Rechte des aktuellen Benutzers. Verdächtige Umgebungsvariablennamen werden per Denyliste entfernt; das ist keine geheimnissichere Sandbox. Prozessbaum-Bereinigung erfolgt bestmöglich.
- Ungespeicherter Text und Kürzel können unverschlüsselt im gleichursprünglichen `localStorage` liegen. Wiederherstellung ist begrenzt und bestmöglich.
- Die Markdown-Vorschau führt weder raw HTML noch MDX aus. Links erlauben nur `http:`, `https:` und `mailto:`; HTTP(S)-Links öffnen ohne Opener- oder Referrer-Berechtigung in einem neuen Reiter. Relative Bilder werden ausschließlich über den gleichursprünglichen, arbeitsbereichsbeschränkten Medienendpunkt geladen.
- Medien sind schreibgeschützt, nach Erweiterung freigegeben und durch `maxMediaBytes` begrenzt. Audio/Video akzeptiert zum Suchen einen einzelnen HTTP-Bytebereich und startet nie automatisch. SVG wird bewusst nicht unterstützt.
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

Harness stoppen und den aktuellen `main`-Build erneut hinzufügen. Wer geprüften Releases folgt, verwendet stattdessen eine neue feste Release-URL:

~~~sh
corepack pnpm dsh plugin --profile web remove dsh-code-ide
corepack pnpm dsh plugin --profile web add github:SakalioLabs/dsh-code-ide
corepack pnpm dsh plugin --profile web list --depth 0
corepack pnpm dsh --profile web --dump-config
~~~

Danach `pnpm dsh web` mit demselben `DSH_HOME` neu starten und den Browser hart neu laden. Zur Deinstallation `remove`, `plugin list` und `--dump-config` ebenfalls mit diesem `DSH_HOME` ausführen. Browserlokale Wiederherstellungs- und Kürzeldaten werden nicht automatisch gelöscht.

## Versionshinweis

`v0.1.0-alpha.0` ist ein GitHub-Prerelease. Die Release-Assets sind `dsh-code-ide-0.1.0-alpha.0.tgz` und die zugehörige SHA-256-Datei; es handelt sich nicht um ein npm-Release. Nur Assets auf dieser Release-Seite sind veröffentlichte Pakete. Frühere Actions-Artefakte und lokale `tmp/`-Ausgaben bleiben Entwicklungsaufzeichnungen; die Kompatibilität ist auf den oben fixierten Harness-Commit begrenzt.
