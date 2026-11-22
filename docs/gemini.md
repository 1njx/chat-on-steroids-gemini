# Gemini in Chat On Steroids (Gemini edition)

This fork adds **Google Gemini** (gemini.google.com) as a second provider next to ChatGPT. It is
an independent project. It is not affiliated with, endorsed by or approved by Google or OpenAI.
Gemini, Gemini 4 Neon, Hydrogen and Carbon are Google names; ChatGPT is an OpenAI name.

Everything in this page describes what the code does and what was tested. Section
[Verification record](#verification-record) lists exactly what was verified live and what was not.

## How Gemini gets the app's tools

Gemini uses this app the same way ChatGPT does: as an **MCP server**. Google lets Gemini call a
remote MCP server you add yourself, under **Gemini → Connectors → Custom** ("custom apps").

- **Core** (files, search, patches, terminal, skills, plan, workers), **Desktop** (screen,
  mouse/keyboard, browser control, clipboard) and **Plugins** (your MCP plugins, for example
  Roblox Studio) are three separate MCP servers. Add each one you want as its own custom app.
- Calls go through the same kernel as ChatGPT's: approved folders, read-only mode, the command
  allow/deny list, Desktop permissions, plugin read-only refusal and recording all apply.
- Gemini asks you itself before it runs a tool that is not marked read-only (for example
  `exec` or `apply_patch`): **Don't allow / Allow once / Always allow**. That is Google's
  confirmation; the app never answers it for you.
- Tool calls from Gemini are recorded in the app under **Unattributed activity** (Gemini sends no
  conversation proof the way ChatGPT does). The app recognizes Gemini's MCP client by its
  `User-Agent: Google` for presentation only; a header never grants identity or permission.

## Requirements (from Google, checked 2026-11-20)

Google offers custom apps to **personal Google accounts, 18 or older, in the US**, with **Gemini
history on**, in **English**. Work and school (Workspace) accounts are not supported by Google.
Google's help page: "Connect & manage custom apps for Gemini Apps".

Gemini needs an **https** MCP address:

- **Cloudflare quick tunnel** (Setup → Tunnel → Cloudflare): works, but the address changes every
  time the app starts, and Gemini cannot edit a custom app's address. Delete the app in Gemini
  and add it again after each start.
- **Your own Cloudflare tunnel for Gemini** (Set up Gemini → Tunnel → "Keep the same address"):
  a lasting address. Enter its public hostname and token; the app runs it next to ChatGPT's tunnel
  and turns on **Keep plugin URLs across restarts**, so the path and local port stay too. In
  Cloudflare, point the public hostname at the `http://localhost:<port>` the step shows. The token
  is kept in the system's secure storage. Recommended.
- **Your own HTTPS tunnel** for the whole app ("Local only" in Setup → Advanced) plus **Keep plugin
  URLs across restarts**: also lasting.
- The **OpenAI Secure MCP Tunnel only serves ChatGPT.** Gemini cannot use it. With it, Gemini gets
  its own Cloudflare quick tunnel that runs next to it (Set up Gemini, Tunnel step), so ChatGPT
  keeps working on the OpenAI tunnel.

## Setup

Open **Settings → Providers → Gemini**. **Set up Gemini** at the top of the page walks through
six steps, like ChatGPT's Setup: one step at a time, with pictures of Gemini's own pages, and
each step turns green by itself when the app sees it done.

1. **Browser** — the Chat On Steroids extension, the same one ChatGPT uses. "Install the
   extension" opens Setup's browser step. Done when the extension is connected.
2. **Sign in** — "Open Gemini" opens gemini.google.com in that browser. Lists Google's
   requirements (personal account, 18+, US, Gemini Apps Activity on, English). Done when the
   Gemini page reports a signed-in account.
3. **Folder** — "Add folder" shares a folder (the same folders and access as ChatGPT). Done
   when at least one folder is shared.
4. **Tunnel** — Gemini needs an https address. On the OpenAI Secure Tunnel (ChatGPT only),
   "Start a tunnel for Gemini" starts a Cloudflare quick tunnel for Gemini next to it and
   connects; ChatGPT stays on the OpenAI tunnel. "Turn off Gemini's tunnel" stops only that one.
   The setting is kept, so the Gemini tunnel starts again with every connection. On a Cloudflare
   or own tunnel, "Connect" is enough. If the whole app was switched to Cloudflare (what 2.2.0 to
   2.2.3 did here), "Switch ChatGPT back to the OpenAI tunnel" switches back and keeps Gemini's
   own tunnel; when no tunnel ID is saved, Setup asks for it. Done when connected with an https
   Core address. "Keep the same address" runs your own Cloudflare tunnel instead of a quick one.
5. **Add app** — "Fill in Gemini for me" uses the extension on your signed-in Gemini page: it opens
   custom apps and, when **Chat On Steroids Core** is already there, reads its address. Same
   address: nothing to do. Old address: Gemini cannot edit one, so it highlights **More options**
   for you to choose **Delete**, then press the button again. Otherwise it opens **Create custom
   app**, fills in the address and highlights **Next**. It never presses Next, Connect or Delete,
   and stores no Google password or cookie. A page it does not recognize gets nothing filled in, and
   the step says to add the app by hand. The step remembers a fingerprint of the address Gemini
   last got (copied, filled in or read there), never the address, so after a restart it says
   "Your Gemini custom app has an old address. Update it to …" instead of "not added".
   "Copy URL" copies the Core MCP address (treat it like a password), "Open
   custom apps" opens Gemini's connectors page. Pictures show: **+ Custom** → paste the
   address → **Next** → tick Google's notice → **Connect**; then **Connect** again under
   "Save your custom app". Done when Gemini's MCP client reaches the app (in this run: a quick
   tunnel's address is new on every start, so add the app again after a restart).
6. **Try it** — in a new Gemini chat type `@`, pick **Chat On Steroids Core** and ask for
   something in your folder (a ready prompt can be copied). Gemini asks **Allow once** /
   **Always allow** before a tool that changes something. Done when Gemini calls one of the
   app's tools.

**Ready** lists every check, with a way back to any step that is not done. Optional: add the
Desktop and Plugins URLs the same way (Plugins page and Setup show them).

### Sending from the app

**From the chat composer.** The composer's model menu lists every model Gemini's own picker
showed (Refresh in Settings → Gemini, or the menu's reload button while a Gemini page is open),
under a **Gemini** heading below ChatGPT's. A model that needs a higher plan is listed greyed out
with that reason. Pick one and the thinking slider offers Gemini's thinking levels (for example
Low, Medium, High). Send then goes to Gemini instead of ChatGPT: a new Gemini chat opens in the
app once Gemini has answered, and its messages keep going to that Gemini chat. In a Gemini chat
the menu lists only Gemini's models; in a ChatGPT chat only ChatGPT's. Gemini gets text only:
files, plans and edits are refused with a message.

**Settings → Gemini → Send to Gemini** sends a message into a new (or a recent) Gemini chat in
your browser through the extension, waits for the answer and records the turn in the app's
history as a `gemini:<id>` chat. It:

- selects the model and thinking level you chose (or keeps Gemini's), **before** typing, because
  Gemini hides its model picker while a long draft is open;
- starts the message with an @-mention of the connector name you set (default empty = no mention);
- sends **at most once**. If the page was allowed to press Send but never confirmed, the message is
  reported as **Outcome unknown** and is never sent again. Failures show Gemini's own words.

The app refuses a model Gemini marks as needing a higher plan (for example Gemini 4 Carbon on
Google AI Pro) instead of trying it.

## Models

The app reads the account's models from Gemini's own picker (Refresh) and never guesses. On the
tested Google AI Pro account the picker offered:

| Option in Gemini | Model | Available on the tested Pro account |
| --- | --- | --- |
| Auto | chosen by Gemini | yes |
| Everyday help | Gemini 4 Hydrogen | yes |
| Deeper analysis | **Gemini 4 Neon** | **yes** |
| Code & complex work | Gemini 4 Carbon | no (upgrade to Ultra) |

Thinking levels offered: Low, Medium, High. Your account may differ; the app shows what Gemini shows.

## Roblox Studio

Roblox ships its own MCP server with Studio (`StudioMCP.exe`, stdio). Add it as a plugin:

1. **Plugins**, add a custom plugin of type **Custom executable**, command = the `StudioMCP.exe` inside your newest
   `%LOCALAPPDATA%\Roblox\Versions\version-…` folder, no arguments.
2. Turn **read-only mode off** (the app refuses every plugin call while it is on).
3. Add the **Plugins** MCP URL to Gemini as another custom app, and mention it in the chat.
4. In Studio, open a place and enable the MCP server in the Assistant settings.

Any other Roblox MCP server works the same way if it speaks MCP over stdio or Streamable HTTP;
nothing in the app is specific to one Roblox implementation.

Known limit: `StudioMCP.exe` lives in a version-specific folder, so after a Studio update point
the plugin at the new folder (Roblox's own `mcp.bat` resolves it, but the app does not run
`.bat` files because that would need a shell).

## Security

- The extension never reads, stores or sends your Google password or cookies. It reports only
  whether a Google account is signed in, the plan badge (Pro/Ultra) and the account's display
  name; the Google address is deliberately not read into reports.
- To open Gemini's @ menu the extension types **one** trusted `@` into your own Gemini tab through
  Chrome's debugger API (Gemini ignores synthetic keys until a real one). Only its own Gemini
  content script can ask, only for that tab, and only that one character.
- MCP URLs are secret paths behind your tunnel. Anyone with a URL can call what you enabled.
  Use read-only mode and narrow approved folders when trying things out.
- Google states it does not control or secure third-party MCP servers; you are the operator of
  this one.
- Respect Google's terms, limits and safety decisions. Do not use workers, Goal/Loop or several
  accounts to evade a Gemini usage limit or a refusal.

## Known limitations

- **ChatGPT-only features.** Goal/Loop drivers, Compact & Resume, workers that open new chats,
  turn rotation, automatic Continue and recovery drive ChatGPT pages only. Gemini can *call* the
  tools behind them (`agents`, `update_plan`, …), but the app does not drive Gemini chats for
  them. Worker chats the `agents` tool opens are ChatGPT chats.
- **Composer sends to Gemini are plain text.** No files, plans, edits, Goal/Loop or queued delivery.
  The chat shows your message and Gemini's answer together once Gemini has finished.
- **Attachments** are not sent to Gemini from the app.
- **Streaming**: the app records Gemini's final answer, not token-by-token progress.
- **Unattributed recording**: Gemini's tool calls are filed under Unattributed activity, not inside
  the matching Gemini chat.
- **English only**: Google offers custom apps in English, and the page adapter reads English labels.
- **Quick tunnel address changes** on every start (see Requirements).

## Verification record

Live, 2026-11-20, Windows 11, Chrome, Google AI Pro personal account, this fork's code:

| Check | Result |
| --- | --- |
| Gemini custom app accepts the Core MCP URL (no-auth, Streamable HTTP) | **Pass** after fix 2 below; Gemini listed the tools |
| Gemini 4 Neon calls a Core tool in a real chat | **Pass**: Neon (mode label "Neon") called `read` on `PROOF.txt` in a test folder and answered with the random token that exists only in that file; the server log shows `tool read ok` at the same moment |
| Gemini asks before a non-read-only tool | Observed: "Let Gemini use exec? Don't allow / Allow once / Always allow" |
| Page adapter on the live page | Pass: sign-in, plan "Pro", modes incl. Carbon "requires-upgrade", thinking levels, select Neon |
| Roblox `StudioMCP.exe` through the app's Plugins MCP server | Pass with Studio closed: 39 tools discovered, `list_roblox_studios` answered `{"studios":[]}`; read-only mode refused the call as designed |
| Roblox tools against an open place in Studio | **Not run** (needs Studio open with a place; see procedure below) |
| Full extension loop (app → extension → Gemini page → app history) | **Not run live**: needs the unpacked extension loaded in your Chrome; covered by automated tests |

Bugs found live and fixed (each has a regression test):

1. Cloudflare quick tunnels returned Cloudflare's 404 for every request when
   `~/.cloudflared/config.yml` (a named tunnel with a catch-all `http_status:404`) existed:
   cloudflared loaded it and its ingress overrode `--url`. The app now gives cloudflared its own
   empty config. (`test/tunnel-lifecycle.test.ts`)
2. Gemini's MCP client keeps only one text part of a tool result, so it saw only the app's
   appended ChatGPT identity notice and not the file. Results for Gemini now carry all text in one
   part. (`test/mcp.test.ts`, `test/mcp-client-family.test.ts`)
3. Gemini keeps `processing-state-visible` on finished answers, so "answer finished" needs the
   page's Stop button instead. (`test/gemini-dom.test.ts`)
4. Text added after an @-mention chip was dropped when the adapter moved the caret itself; it now
   types at Gemini's own caret. (`test/gemini-dom.test.ts`)
5. Gemini's @ menu ignores synthetic keys until the page saw a real keystroke; the extension now
   asks for one trusted `@`. (`test/gemini-dom.test.ts`)

### Manual test procedures

**Neon + MCP** — Settings → Gemini shows the Core URL; add it in Gemini (Setup above). Put a file
with a random token in an approved folder. In a new Gemini chat choose Deeper analysis (4 Neon),
type `@`, pick Chat On Steroids Core and ask it to read the file and reply with the token. Pass
when the token matches and Settings → Gemini says Gemini reached the server.

**App → Gemini send** — Load the unpacked extension (Setup step 1), open gemini.google.com signed
in. Settings → Gemini should show the page as connected and your plan. Press Refresh under
Models, choose a model, set the connector name, write a message and press Send to Gemini. Pass
when the row reaches "Answered" and the chat appears in the app's chat list with the answer.

**Roblox Studio** — Add `StudioMCP.exe` as a plugin (above), open a place in Studio with the MCP
server enabled, add the Plugins URL to Gemini, and ask Gemini via `@Chat On Steroids Plugins` to
list the scripts in the place, read one with `script_read`, and change a value with `multi_edit`.
Pass when Studio shows the change and the plugin call history in the app shows the calls.
