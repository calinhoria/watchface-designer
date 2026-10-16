# vendor/

Third-party browser libraries that ship with the app (the packaged build only
includes the files listed in `package.json` → `build.files`, so runtime assets
live here rather than in `node_modules`).

- **Sortable.min.js** — [SortableJS](https://github.com/SortableJS/Sortable)
  v1.15.7, MIT. Drag-to-reorder for the Layers list and the image-list dialog.
  Installed with `npm i -D sortablejs`; copy the file here after upgrading:
  `cp node_modules/sortablejs/Sortable.min.js vendor/Sortable.min.js`

The editor uses `forceFallback: true` (pointer-driven instead of the browser's
native HTML5 drag) and relies on `.sortable-fallback { pointer-events: none }`
in `styles-src.css` — without it the drag clone follows the cursor and swallows
the drop, so the drop resolves against nothing and the reorder silently does
nothing.
