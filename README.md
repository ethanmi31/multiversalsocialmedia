# Multiversal Social Media

An AI-generated social network for your own fictional worlds. Upload your world document, add your own characters, let the AI generate other users, then post, read the feed, and chat with characters in real time. Powered by [OpenRouter](https://openrouter.ai), so you choose the models.

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm run dev          # http://localhost:5173
```

Open **Settings**, paste your OpenRouter API key, then pick a chat model and a cheap utility model. For production use, run `npm run build && npm start`.

All data is stored locally in `data/multiverse.db` (SQLite). Set `DATA_DIR` to change where it goes and `PORT` to change the port.

## How to use it

1. **Create a world.** Click ＋ in the sidebar.
2. **World & Lore → Source document.** Upload your document (.txt, .md, .docx or .pdf). Any size is fine. You can also import an existing SillyTavern lorebook `.json`.
3. **Structuring instructions.** Tell the compiler how to organize the material: what to split into separate entries, what to skip, which nicknames to use as triggers.
4. **Compile.** Click **Estimate cost** to see the one-time price, then **Compile with AI**. **Quick split** is a free alternative that makes one entry per heading.
5. Review and edit the generated **lorebook** and **world summary**. Use **Test triggers** to see exactly what a message would inject and how many tokens that costs.
6. **Characters.** Add your own characters. Mark one or more as **"You play"** to use them as your personas. Use **Generate users** to have the AI populate the world. The toggles control which characters are currently active on the world.
7. **Feed.** Post as your persona and characters reply. **Generate activity** creates a batch of posts, optionally around an event you name ("the king just died"). **Live** mode keeps the world posting every 2 minutes while the page is open.
8. **Messages.** Start a DM or a group chat. Replies stream in as they're written. In group chats you can pick who speaks next, press ▶ to let the characters keep talking, or press ↻ to regenerate a reply.

## How it saves credits

Your document is **never sent to the model in full** during normal use. It works the way SillyTavern lorebooks (World Info) do:

| Technique | What it does |
|---|---|
| **Compile once** | A cheap utility model rewrites each document chunk into dense, keyword-triggered entries. You pay this once, and the **Estimate cost** button shows the price beforehand. |
| **Keyword activation** | Each request only includes entries whose keywords appear in the last few messages (*scan depth*), capped by the **lore budget**. Constant entries and higher-priority entries win when space is tight. One level of recursion pulls in related entries (a character's hometown, for example). |
| **Short always-on context** | Only the world summary and world rules are sent every time. The token count is shown in the editor. |
| **Rolling chat memory** | Older messages are folded into a summary (viewable and editable under *Memory*). Only the last *N* messages are sent word for word. |
| **Two models** | The expensive model is used only for live chat. Compiling, generating users, posts and replies, and summaries all use the cheap utility model. |
| **Batching** | A whole batch of feed posts, or all the replies to a thread, is generated in one request with shared context. |
| **Cache-friendly prompts** | The stable parts of a prompt (world, character card) come first and stay identical between calls, so providers that support prompt caching bill them at a discount. |

The **Usage** page shows tokens and cost per task as reported by OpenRouter, so you can see where credits go. The main dials are in **Settings → Token budgets**: lore budget, scan depth, recent messages kept and max reply length.

## Project layout

```
server/
  index.js       Express API + serves the client
  db.js          SQLite schema and settings
  openrouter.js  OpenRouter client (streaming, JSON, usage logging, model prices)
  lorebook.js    Document parsing, chunking, AI/quick compile, keyword activation
  engine.js      Prompt building, character/feed/reply generation, chat, summaries
client/src/
  App.jsx        Layout and navigation
  views/         Feed, Chats, Characters, WorldEditor, Settings, Usage
```
