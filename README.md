# Semantic Planner

An Obsidian plugin that lays notes out on a canvas by semantic similarity, using
embeddings computed locally in the browser. Prototype, under development.

## What it does

- Embeds vault notes with `Xenova/multilingual-e5-small` via `@xenova/transformers`,
  so no note text leaves the machine
- Classifies each note against user-defined anchors, clusters the rest with k-means,
  and writes the result as an Obsidian `.canvas` file
- Caches embeddings in IndexedDB so unchanged notes are not re-embedded between runs

## Performance work

Building a canvas over a 309-note vault (269 of them embedded) took 2-3 minutes.
Rather than guess, I timed each pipeline stage with `performance.now()` and tested
two hypotheses:

| Hypothesis | Result |
| --- | --- |
| The O(n^2) pairwise similarity pass dominates | Rejected: 36,046 pair comparisons took 6-8 ms |
| Model initialisation dominates | Rejected |

Both were wrong. Of a 163.19 s run, **161.94 s was embedding**, and over 99% of that
work re-embedded notes that had not changed since the previous run.

That result is what `cache.ts` exists for: an IndexedDB store keyed on the file's
`mtime` and `size` plus the model ID and pipeline version, so a run only embeds
notes that are actually new or edited.

Re-measurement after the cache landed is still outstanding.

## Build

```
npm install
npm run build     # production bundle to main.js
npm run dev       # watch mode
```

`main.js` is a build artifact and is not committed.

## Status

Not published to the Obsidian community plugin marketplace.
