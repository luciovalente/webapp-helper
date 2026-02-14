# webapp-helper

Bozza iniziale di estensione Chrome (Manifest V3) per supportare la navigazione di webapp single-page.

## Funzioni incluse

- Ordinamento colonne tabelle cliccando sull'intestazione.
- Mostra/nascondi colonne della tabella selezionata.
- Filtro rapido su una colonna o su tutte le colonne.
- Salvataggio preset filtri su `chrome.storage.local` (scoped per dominio).
- Pannello flottante in pagina per usare tutto senza aprire DevTools.

## Installazione locale

1. Apri `chrome://extensions`.
2. Attiva **Modalità sviluppatore**.
3. Clicca **Carica estensione non pacchettizzata**.
4. Seleziona la cartella di questo repository.

## Struttura

- `manifest.json`: configurazione estensione.
- `src/content.js`: logica di analisi DOM / tabella / filtri.
- `src/content.css`: stile pannello helper.
- `src/popup.html`: popup informativo dell'azione estensione.

## Note

La versione è un MVP: utile per iniziare rapidamente e poi adattare i selettori alle specifiche della tua webapp.
