# webapp-helper

Estensione Chrome (Manifest V3) per supportare la gestione avanzata di tabelle in webapp single-page, con analisi AI opzionale e suggerimenti operativi.

## Funzioni incluse

- Scan multi-tabella con rilevazione vista corrente.
- Mostra/nascondi e riordino colonne con salvataggio su `chrome.storage.local`.
- Suggerimenti AI (anteprima, applicazione, rifiuto) con cache analisi per vista.
- Opzioni AI dedicate (`options_page`) per provider/model/endpoint e token.

## Installazione locale

1. Apri `chrome://extensions`.
2. Attiva **Modalità sviluppatore**.
3. Clicca **Carica estensione non pacchettizzata**.
4. Seleziona la cartella di questo repository.

## Configurazione AI

Apri **Opzioni AI** dall'icona dell'estensione (popup) oppure da `chrome://extensions`:

1. Seleziona provider:
   - **OpenAI (diretto)**: usa endpoint compatibile chat completions + token API.
   - **Backend proxy consigliato**: imposta URL del tuo backend proxy (in questo caso il token lato client può non essere necessario).
2. Imposta `model` ed `endpoint`.
3. (Solo provider diretto) inserisci il token API.
4. Opzionale: inserisci una **passphrase** per cifrare localmente il token (AES-GCM con chiave derivata PBKDF2).
5. Salva.

### Blocco runtime se configurazione mancante

Quando premi **Analizza pagina** nel popup, l'estensione verifica la configurazione AI runtime:

- se `provider/model/endpoint` non sono completi, l'analisi viene bloccata con messaggio chiaro;
- se provider diretto e token assente, analisi bloccata;
- se token cifrato e passphrase mancante/errata, analisi bloccata.

## Privacy e minimizzazione dati

L'analisi AI invia uno **snapshot minimizzato** e non l'intera pagina raw.

### Dati inviati

- Metadati pagina ridotti: `origin`, `pathname`, `title` troncato.
- Struttura DOM sintetica: numero headings/forms/buttons/input + elenco heading troncati.
- Metadati tabelle:
  - `table_id`, tag, numero colonne;
  - per colonna: `field`, `header`, `visible`, `inferred_type`.

### Dati NON inviati

- HTML completo della pagina.
- Testo completo della pagina.
- Script inline completi.
- Token API o segreti di configurazione.

## Sicurezza token

- Il content script **non** accede al token e non lo riceve mai.
- I segreti restano in contesto extension (`background` / `options`).
- Possibile cifrare localmente il token (passphrase utente).
- Best practice consigliata: usare un backend proxy per centralizzare policy, audit e protezione credenziali.

## Struttura

- `manifest.json`: configurazione estensione.
- `src/content.js`: logica in-page (scan/apply/snapshot minimizzato).
- `src/background.js`: orchestrazione AI, validazione schema, configurazione e segreti.
- `src/popup.html`, `src/popup.js`: azioni rapide + guardrail runtime.
- `src/options.html`, `src/options.js`: configurazione AI.
