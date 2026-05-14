# pi-visual

A pi extension that renders LLM responses as interactive visual blocks in a browser — diagrams, charts, choices, diffs, trees, and more.

## Installation

```bash
# Quick test
pi -e /path/to/pi-visual/src/index.ts

# Or install as a package
pi install /path/to/pi-visual
```

## Usage

```
/visual          → toggle visual mode on/off
/visual on       → enable
/visual off      → disable
/visual status   → show current state
```

When visual mode is active, the `visual` tool becomes available to the LLM. It renders structured blocks in a browser window that opens automatically.

## How It Works

1. `/visual` starts an HTTP+WebSocket server on a random port and opens your browser
2. The LLM calls the `visual` tool with structured JSON blocks
3. Blocks are pushed to the browser via WebSocket and rendered with a component library
4. You click choices, type messages, or paste images in the browser — interactions flow back to pi

## Block Types (23 total)

### Structure
- `tree` — Collapsible tree with icons
- `table` — Data table with sortable columns
- `list` — Styled list with badges and icons

### Process
- `flowchart` — Top-down flowchart diagram (D3)
- `steps` — Ordered steps with status indicators
- `state_machine` — State diagram with transitions (D3)

### Comparison
- `comparison` — Side-by-side attribute cards
- `diff` — Code diff with syntax highlighting (Pierre or fallback)
- `pros_cons` — Two-column pros/cons layout

### Data Visualization
- `chart` — Bar, line, pie, radar, scatter (Chart.js)
- `timeline` — Vertical timeline with events
- `heatmap` — Color-coded matrix

### Relationships
- `graph` — Force-directed node graph (D3)
- `mind_map` — Radial mind map (D3)
- `entity_relation` — ER diagram (D3)

### Interaction
- `choice` — Selectable cards (single/multi select)
- `form` — Input fields with submit
- `checklist` — Toggleable items

### Media
- `explanation` — Title + body card
- `image` — Image with caption
- `svg` — Sandboxed SVG renderer
- `code` — Syntax-highlighted code (Shiki)
- `markdown` — Rendered markdown (Marked)

## Interactive Features

- **"Tell me more"** buttons on choice options, graph nodes, table rows, timeline events, and list items
- **"Pros/Cons Analysis"** button auto-generated on choice blocks with 2+ options
- **Persistent text input** at the bottom of the browser — supports text and image paste
- **Reconnection** — auto-reconnects with exponential backoff if connection drops

## Architecture

```
pi extension (TypeScript/jiti)     Browser SPA (vanilla JS)
├── src/                           ├── spa/
│   ├── index.ts    (/visual cmd)  │   ├── index.html
│   ├── server.ts   (HTTP+WS)      │   ├── styles.css
│   ├── protocol.ts (shared types) │   └── app.js (all renderers)
│   └── tool.ts     (visual tool)  │
```

- Extension runs via jiti (no build step)
- SPA uses Tailwind CSS, D3, Chart.js, Shiki, Marked via CDN
- All block renderers inlined in `app.js` (no ES module path issues)

## License

MIT
