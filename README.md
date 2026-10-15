# docex

Talk to Codex through a Google document. Start the watcher once, leave the Doc open, and submit prompts by wrapping them with two chosen characters. Answers appear directly underneath. No AI window opens or takes focus.

## Run

Requires Node.js 22+, Codex CLI, a signed-in Codex account (`codex login`), and the Google Drive plugin connected in ChatGPT/Codex with edit access to your document. Tested with Codex CLI 0.162.1 on macOS. No extra npm dependencies, API key, Google Cloud project, or separate Google OAuth credentials are needed with this setup.

```sh
git clone https://github.com/navkul/docex.git
cd docex
npm link

docex 'https://docs.google.com/document/d/YOUR_ID/edit?tab=t.0' \
  --prompt-chars '""' --background
```

If your npm global directory is not writable, run `npm install --global --prefix "$HOME/.local" .` from this project and ensure `~/.local/bin` is on `PATH`.

Omit `--background` to see progress in the terminal; Ctrl+C stops it. You can also run `node src/cli.js ...` without installing the command. `docex --help` lists all options.

## Write in the document

```text
"{1} Hi, what is your name?"
```

Once the closing delimiter is present and stable across polls, the prompt is submitted. Continue that conversation anywhere in the watched tab:

```text
"What did I just ask you? {1}"
```

Start a separate conversation with a number greater than any previously created session:

```text
"{2} Help me outline a short story."
```

Existing numbers can always be reused, including returning to `{1}` after `{2}`. A new, previously unseen smaller number is ignored and logged. Session numbers belong to each document and survive restarts. The number can appear anywhere inside the prompt, exactly once as `{digits}`. Zero is accepted; leading zeroes are normalized.

To use surrounding text, ask naturally:

```text
"{1} Read the rest of this document and summarize the reference notes."
```

The model receives only the submitted prompt and its conversation history unless it calls the read-document tool. That tool supplies current text from all tabs, tables, headers, footers, and footnotes. It does not interpret images or drawings.

Choose two distinct delimiters if you often quote text:

```sh
docex 'YOUR_DOC_URL' --prompt-chars '«»'
```

Then submit `«{1} your prompt»`. Exactly two Unicode characters are required. Straight double/single quotes also accept their Google Docs smart-quote equivalents. Prompts may span paragraphs and styled text runs, but must stay within one continuous text area (for example, one table cell). Use delimiters that do not occur inside your prompts. Write prompts in Editing mode, rather than Suggesting mode.

## Watcher controls

```sh
docex 'YOUR_DOC_URL' --status
docex 'YOUR_DOC_URL' --stop
docex 'YOUR_DOC_URL' --retry-errors --background
```

`--interval 2` sets the polling interval in seconds. `--all-tabs` watches every document tab; otherwise docex watches the URL's tab, or the first tab when none is specified. `--model NAME` and `--effort LEVEL` override your normal Codex settings. Model availability and usage limits come from your signed-in account. Answers are inserted when complete, rather than streamed character by character.

`--once` drains currently submitted prompts and exits; a nonzero exit reports outstanding failures. `--retry-errors` explicitly resubmits failed/interrupted AI turns. Network and revision conflicts retry automatically with backoff. If a turn's start has an uncertain outcome, docex retains it for reconciliation on restart instead of blindly sending it again.

State, cached answers, session mappings, and background logs are in `~/.local/state/docex/DOCUMENT_ID/` with owner-only permissions. Use `--state-dir PATH` or `DOCEX_STATE_DIR` to change the location, and use that same directory for `--status` and `--stop`. Retain the state directory to preserve session memory. Completed prompts are also marked in the document, so deleting local state does not intentionally re-submit them.

## How document edits work

docex launches a private `codex app-server` over stdio. One tool-only connection uses your existing Google Drive connection for deterministic reads and writes; each numbered conversation has its own persistent Codex thread. Polling does not invoke a language model. Chat threads expose an on-demand document reader and do not receive the document-editing tool.

Each submission receives an invisible Google Docs named range. After generating an answer, docex re-reads its current position and inserts only the new text at that position, guarded by the latest revision. Original text, formatting, tables, and other content are not rebuilt. The reply and its receipt marker are written in the same atomic batch, allowing recovery from a lost write response without duplicating the reply. Identical prompts at different positions are separate submissions.

If you edit, split, or delete a submitted prompt before its reply is inserted, docex retains the answer locally and cancels the insertion. Submit a fresh wrapped prompt to ask again. To write another prompt after a reply, start a new paragraph. Editing an already answered prompt does not automatically re-submit it.

Google Docs named ranges are invisible in normal document editing but are available to API clients. The integration uses the Codex app-server and connected Apps interfaces; their availability depends on the installed Codex version and account. If startup reports a missing Google Drive tool, connect/enable the Google Drive plugin and retry.

Protocol references: [Codex app server](https://learn.chatgpt.com/docs/app-server), [Google Docs named ranges](https://developers.google.com/workspace/docs/api/how-tos/named-ranges), [Google Docs batch updates](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate).

## Verification

```sh
npm test

# Writes a small test transcript to the named document and uses real Codex turns.
# Stop an existing watcher for this document before running it.
npm run smoke -- 'YOUR_TEST_DOC_URL'
```

The automated suite covers parsing, Unicode indices, session routing, reply positioning, restart recovery, concurrent edits, lost write responses, duplicate suppression, locking, and on-demand context. The live smoke test exercises the actual CLI, custom delimiters, an unfinished prompt, a concurrent edit, memory after restart, independent sessions, document context, and preservation of existing text/styles. It leaves the transcript in the test Doc and writes `artifacts/live-smoke.json` locally.
