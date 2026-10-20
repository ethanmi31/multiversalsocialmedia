# Multiversal Social Media

An AI-generated social network for your own fictional worlds. Upload your world document, add your own characters, let the AI generate other users, then post, read the feed, and chat with characters in real time. Powered by [OpenRouter](https://openrouter.ai), so you choose the models.

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm run dev          # http://localhost:5173
```

Open **Settings**, paste your OpenRouter API key, then pick a chat model and a cheap utility model. For production use, run `npm run build && npm start`.

All data is stored locally in `data/multiverse.db` (SQLite). Set `DATA_DIR` to change where it goes and `PORT` to change the port. The app only accepts connections from your own computer, because it spends your OpenRouter credits. Set `HOST=0.0.0.0` if you deliberately want other devices on your network to reach it.

**Backups:** under **World & Lore → Backup**, export a whole universe to one file, and import it again on any computer. Importing always creates a separate copy.

## How to use it

1. **Create a universe.** Click ＋ in the sidebar. Each universe is fully separate: its own lore, characters, posts, DMs, memories and drama.
2. **World & Lore.**
   - **Source document:** upload your world document (.txt, .md, .docx or .pdf, any size). Tick *Append* to add more documents.
   - **Import SillyTavern lorebooks** (in the Lorebook section): select one or more World Info `.json` exports or character cards (`.json`/`.png` with an embedded lorebook). Keywords, always-on, order and disabled state carry over, and re-importing skips duplicates.
   - **Structuring instructions:** how the compiler should organize the document into lore entries.
   - **Compile:** **Estimate cost**, then **Compile with AI** (it keeps short dialogue samples so characters sound right), or use the free **Quick split**.
   - **Random users:** how the AI should create random accounts for this universe.
   - **World rules:** story-specific instructions that apply to this universe only.
3. **Characters.**
   - Add characters with **Name, Handle, Bio and Description**. Paste a description in, or drop a file onto the box.
   - **Bulk import** splits one document of many descriptions into characters. Use the free heading split, or the cheap AI split, which also suggests handles and bios. You review everything before importing.
   - Mark your own characters **"You play"**. The AI never writes posts, replies, DMs or actions for them.
   - **Add characters from your lorebook:** ask in your own words ("add 5 characters from the stories", "add all the characters", "add the villains").
     - It skims the lorebook to find the character entries, reading titles and first lines only. Entries already categorized "Character" or "Location" cost nothing, and the results are remembered so only new or edited entries get skimmed next time.
     - It picks the characters that match and writes account details that follow your username rules. Each character's lorebook entry becomes their description word-for-word.
     - Characters already on the platform are skipped, and you review everything before it's added. The Director can do this too.
   - **Who knows who:** for each character, the cheap model reads every lorebook entry about them, within a size limit. From that it records what they know (their universe and variant, events they lived through, people they've met, crossovers included) and their relationships with the other accounts. This knowledge is always part of the character rather than depending on keywords. It runs automatically for characters added from the lorebook, and **Learn from lore for all characters** re-runs it after you add more people. You can edit "What they know" in each character's editor.
   - **Generate random users** follows your random-user instructions.
   - The toggles control who is currently on the platform.
4. **You are…** Pick which persona you're using in the sidebar.
5. **Feed.**
   - **Let time pass** runs one batched "world tick": new posts, replies to existing threads, follows and unfollows, likes, DMs to you, platform events and storyline progress.
   - Coming back after a while (30 minutes by default) runs a "while you were away" tick.
   - Replying to a post gets answers aimed at you.
   - Opening a thread sometimes has people already typing.
   - **Hashtags and communities:** characters use #hashtags naturally, and **# Explore** shows trending tags and all communities. Click a tag to see every post with it. Explore also has search (posts, names, @handles), and feeds have **Load older posts**.
     - Communities (e.g. "Snowdin", a group for one universe) form on their own as topics come up, or you can create one, or ask the Director.
     - Join one to get its tab on the feed, where you can post and **Let time pass here** so its members talk inside it.
     - Replies stay in their thread's community.
6. **Notifications:** replies, @mentions, follows, likes, DMs and trending drama.
7. **Messages:** DMs and group chats with real-time streaming and texting style (several short messages in a row). Characters can also DM you first.
8. **Real Life:** in-person scenes outside the app, on your own or with characters, such as *"I drive to his house and cuss him out"* or *"I go pick up the package she asked for"*. People can join a scene partway through.
   - A narrator plays every character present, and never acts for you.
   - What happens is remembered and can show up on the feed as venting, subtweets or leaks.
   - **Let it spread** pushes it into the world immediately. **Meet IRL** in a DM takes that conversation offline.
9. **Director:** an out-of-character chat with the engine for the current universe. Tell it what to fix or stop doing ("wrap up that storyline", "Lira went home, stop putting her at the gas station").
   - It changes the world state directly: storylines, memories, relationships, who's on the platform.
   - Lasting corrections become **notes**, standing rules added to every prompt in that universe. You can edit them or switch them off in the side panel.
   - It only reads and changes its own universe.
10. **Profiles:** click any name to see posts, followers, follow/unfollow, Message, Meet IRL, and what that character remembers (editable).

### How memory and drama work

The engine tracks a hidden world state per universe. It's visible under **World & Lore → World state** if you want a "system update":

- **Storylines:** ongoing drama, plots and platform events, each with a *heat* value. Hot storylines trend and pull their characters into the next tick.
- **Relationships:** how X feels about Y (−100 to 100) plus a short status, changing on their own over time.
- **Memories:** what each character remembers from posts, threads, DMs and scenes.

Storylines nobody touches cool down each time time passes and wrap up once they go cold. Memories and storylines are given to the AI with their age ("3d ago"), so old details like where someone was aren't treated as current.

These updates ride along on calls the app already makes (ticks, replies), plus a cheap "continuity" pass every few DM or scene messages. The relevant part is injected into each prompt under its own token budget. DMs also get your shared public history with that character and your recent public posts.

The **global style guide** (Settings) holds the engine instructions for every universe: internet cadence, mature and unmoderated tone, no omniscient summaries, variant tracking, never writing for the human. Story-specific instructions belong in each universe's World rules.

## How it saves credits

Your document is **never sent to the model in full** during normal use. It works the way SillyTavern lorebooks (World Info) do:

| Technique | What it does |
|---|---|
| **Compile once** | A cheap utility model rewrites each document chunk into dense, keyword-triggered entries. You pay this once, and the **Estimate cost** button shows the price beforehand. |
| **Keyword activation** | Each request only includes entries whose keywords appear in the last few messages (*scan depth*), capped by the **lore budget**. Constant entries and higher-priority entries win when space is tight. One level of recursion pulls in related entries (a character's hometown, for example). |
| **Short always-on context** | Only the world summary and world rules are sent every time. The token count is shown in the editor. |
| **Rolling chat memory** | Older messages are folded into a summary (viewable and editable under *Memory*). Only the last *N* messages are sent word for word. |
| **Two models** | The expensive model is used only for live chat. Compiling, generating users, posts and replies, and summaries all use the cheap utility model. |
| **Batching** | A world tick (posts, replies, DMs, follows, likes, drama updates) or a whole round of thread replies is one request with shared context. Engagement numbers grow by a free local simulation. |
| **Cache-friendly prompts** | The stable parts of a prompt (world, character card) come first and stay identical between calls, so providers that support prompt caching bill them at a discount. |

Set a **daily spending limit** in Settings: once today's spending reaches it, all AI calls stop until the next day (background jobs and Live mode included). The **Usage** page shows today's spend against the limit, plus tokens and cost per task as reported by OpenRouter, so you can see where credits go. The main dials are in **Settings → Token budgets**: lore budget, scan depth, recent messages kept and max reply length.

## Project layout

```
server/
  index.js       Express API + serves the client
  db.js          SQLite schema and settings
  openrouter.js  OpenRouter client (streaming, JSON, usage logging, model prices)
  lorebook.js    Document parsing, chunking, AI/quick compile, keyword activation
  engine.js      Character generation and import, world ticks, thread replies
  chat.js        DMs, real-life scenes, rolling summaries, continuity tracking
  worldstate.js  Storylines, relationships, memories, follows, likes, notifications
  director.js    Out-of-character Director chat and its actions
  canon.js       Characters and knowledge from the lorebook
  communities.js Communities and hashtags
  backup.js      Universe export/import
client/src/
  App.jsx        Layout and navigation
  views/         Feed, Notifications, Chats (DMs + Real Life), Characters, Profile, WorldEditor, Settings, Usage
```
