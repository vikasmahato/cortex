# C.O.R.T.E.X — Plan

**C**ontinuous **O**bservation, **R**ecall & **T**hought **EX**traction — a local-first second brain that watches your Claude Code work, files it by category, and lets you browse it, search it, and ask it questions. The UI is one 3D brain whose regions light up according to what Claude is doing right now.

---

## 1. How it captures your Claude activity

Two complementary sources, both local:

| Source | What it gives | Role |
|---|---|---|
| **Claude Code hooks** (global `~/.claude/settings.json`) | Real-time events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd` | Drives the **live neuron firing** and the incremental log |
| **Transcript JSONL** (`~/.claude/projects/**/*.jsonl`) | Full authoritative history: prompts, replies, tool calls/results, thinking, cwd, git branch, timestamps | Source of truth; **backfills** past sessions; recovers anything a hook missed |

Flow:

```
Claude Code ──hook──▶ cortex-hook (tiny CLI, <50ms, never blocks Claude)
                         │ POST localhost:7777/ingest   (fallback: append to ~/.cortex/spool.ndjson)
                         ▼
                    Cortex daemon ── normalize ─▶ redact secrets ─▶ SQLite (events)
                         │                                     │
                         │ on Stop / SessionEnd                ▼
                         │   summarize + categorize + embed  (Claude Haiku + local embeddings)
                         ▼
                    memories, entities, graph edges ──▶ WebSocket ──▶ 3D brain UI
```

Rules: hooks are fire-and-forget and always exit 0 so they can never slow or break Claude. A file watcher tails the transcripts as a safety net, and events are de-duplicated by `(session_id, uuid)`. A one-command installer (`cortex install`) merges the hooks into your settings without touching your existing ones.

**Honest limits:** hooks and transcripts cover **Claude Code** (CLI, IDE extensions, desktop Code sessions). They do **not** cover claude.ai web chats or Claude Desktop plain chat. Phase 4 adds import of the claude.ai data export, and optionally a browser extension.

**Privacy:** everything stays on your machine. Regex and entropy redaction of keys/tokens/`.env` content runs before anything is stored or sent to an LLM. Per-project ignore list and a global pause switch. Only short, redacted summaries go to the Claude API.

---

## 2. Categories and brain regions

Each captured session/turn is classified into a **category** (for browsing) and a **brain region** (for the visual). The region follows the *kind of work*, live, from the tool being used:

| Brain region | Meaning | Lights up when |
|---|---|---|
| **Prefrontal cortex** | Planning, reasoning, decisions | Plan mode, extended thinking, architecture discussion, `TodoWrite` |
| **Occipital / visual** | Perception, reading | `Read`, `Grep`, `Glob`, viewing images/screenshots |
| **Motor cortex** | Action, building | `Edit`, `Write`, `Bash` that changes things |
| **Parietal** | Search & integration | `WebSearch`, `WebFetch`, MCP lookups |
| **Temporal (language)** | Communication, writing | Long replies, docs, explanations |
| **Hippocampus** | Memory formation & recall | Stop/SessionEnd consolidation, `PreCompact`, memory writes, and **your Ask-Cortex queries** |
| **Cerebellum** | Refinement, debug loops | Tests, builds, lint, repeated fix/run cycles |
| **Amygdala** | Alarm | Tool errors, failed tests, rejected permissions |

Retention is shown by decay: recently active regions glow bright and fade over time; consolidated (summarized) memories become persistent, dim "long-term" neurons.

Content categories (browse tabs): Coding · Debugging · Architecture/Planning · Research · Writing/Docs · DevOps/Shell · Data · Learning · Ideas · Misc — plus auto-detected **projects** and **entities** (files, libraries, concepts, decisions).

---

## 3. Feature list

**Capture**
- Live hook ingestion + transcript backfill + one-command install/uninstall
- Secret redaction, per-project opt-out, pause toggle
- Session reconstruction (prompt → tools → outcome)

**Understanding**
- Auto-summaries per turn, session, day
- Auto-categorization, tags, project detection
- Extraction of **decisions, learnings, TODOs, files touched, commands run**
- Knowledge graph linking sessions ↔ projects ↔ files ↔ concepts

**Recall**
- **Ask Cortex**: natural-language Q&A with citations ("how did I fix the CORS issue last week?", "what did I decide about auth?") — hybrid search (FTS5 keyword + vector) then Claude answers from retrieved memories
- Command palette (`Ctrl+K`) for instant search
- "Resurface": related past work shown when you start something similar (optional context injection via `UserPromptSubmit`)

**Glance**
- Today / week timeline with activity heatmap
- Per-region activity gauges and category breakdown
- Daily digest ("what I did today") auto-generated at end of day
- Streaks, time-in-project, most-touched files

**The Brain (hero UI)**
- One 3D brain, ~15–25k glowing neurons, synaptic connections with traveling pulses
- Live firing in the region matching the current tool; ripples spread along pathways
- Click a region to filter the memory list; hover a neuron to see a memory
- Idle "breathing" state, replay mode (scrub the day and watch the brain re-fire)
- Ask-Cortex triggers a hippocampal recall wave, then lights the regions the answer came from

**Platform**
- Local-first, exportable (Markdown/JSON), optional Obsidian vault export
- Later: Tauri desktop app with tray icon, MCP server so Claude itself can query Cortex

---

## 4. Design direction (from research)

- **Visual language:** dark "neural-tech" — near-black background, cyan/violet/magenta emissive neurons, HDR bloom, glass panels with subtle borders and blur, mono/geometric type (e.g. Geist + Geist Mono). Light-blue/white glassmorphism was the other recurring "futuristic" look; we go dark because bloom needs contrast.
- **3D technique:** instanced points/meshes for neurons, line segments with a time-uniform shader for traveling pulses, **selective bloom** via `@react-three/postprocessing` with emissive HDR output (the standard approach for firing effects).
- **UX lesson from the research:** a graph/visual is only part of the value of a second brain — retrieval quality matters more. So Ask-Cortex and search are first-class, not an afterthought. One review of Cloudflare's Second Brain also noted dashboards that "feel like a database" are the failure mode — the brain-as-home-screen avoids that.
- **Layout:** full-bleed brain center; left rail (categories/projects), right drawer (memory detail / Ask panel), bottom timeline scrubber. Panels float over the brain, not beside it.

---

## 5. Tech stack

- **Monorepo:** pnpm + Turborepo, TypeScript strict, Biome (lint/format), Vitest, Playwright
- **UI (`apps/web`):** Next.js (App Router) + React 19, Tailwind CSS v4, shadcn/ui, Motion, React Three Fiber + drei + postprocessing, Zustand, TanStack Query
- **Daemon (`apps/daemon`):** Node 22 + Hono, WebSocket, chokidar (transcript watcher), Zod-validated events
- **Storage (`packages/db`):** SQLite (better-sqlite3) + Drizzle ORM, FTS5 for keyword, sqlite-vec for vectors — single file in `~/.cortex/`, no server to run
- **Embeddings:** local model via transformers.js (bge-small class) — keeps raw text off the network
- **LLM:** Claude API — Haiku-class for summarize/classify (cheap, batched at Stop), Sonnet-class for Ask-Cortex
- **Hook CLI (`packages/hook`):** zero-dependency Node script, compiled small for fast startup
- **Later:** Tauri 2 shell

```
Cortex/
  apps/web        # 3D brain + dashboards
  apps/daemon     # ingest, pipeline, API, WS
  packages/hook   # cortex-hook + `cortex install`
  packages/core   # shared types, event schemas, region mapping
  packages/db     # schema, migrations, search
```

---

## 6. Implementation phases

1. **Foundations (capture end-to-end):** monorepo, event schema, hook CLI + installer, daemon ingest, SQLite, transcript backfill. *Done when:* a Claude Code session shows up as rows in the DB.
2. **Intelligence:** redaction, tool→region mapper, summarize/categorize pipeline, embeddings, hybrid search, Ask-Cortex endpoint with citations.
3. **The Brain:** brain mesh + neuron/synapse generation, region segmentation, pulse shaders + bloom, WebSocket-driven live firing, decay/retention, idle animation.
4. **Dashboards & recall UX:** category/project browsing, timeline + heatmap, daily digest, Ctrl+K palette, Ask panel, replay mode, claude.ai export import.
5. **Polish:** settings/privacy controls, tests, perf tuning for low-end GPUs (LOD, fewer neurons), export, Tauri packaging, MCP server.

Key risks: (a) brain asset — need an openly licensed brain mesh, or generate a procedural one (fallback: sample a parametric two-hemisphere shape); (b) transcript JSONL format is undocumented and can change, so the parser is isolated and tolerant; (c) hook latency — mitigated by spool fallback.

---

## Sources
- [Claude Code hooks reference](https://docs.claude.com/en/docs/claude-code/hooks)
- [React Three Fiber examples](https://docs.pmnd.rs/react-three-fiber/getting-started/examples)
- [Best second brain apps 2026 (Tana)](https://tana.inc/blog/best-second-brain-apps-2026)
- [Cloudflare Second Brain redesign (Product Hunt)](https://www.producthunt.com/p/second-brain-cloudflare/we-made-second-brain-feel-more-like-a-brain)
