# Third-party notices

This repository includes data from the following project.

## opencc-data (OpenCC dictionaries)

- Source: <https://github.com/nk2028/opencc-data>, as distributed in
  [`opencc-js`](https://www.npmjs.com/package/opencc-js) 1.4.2
  (`dist/esm-lib/dict/TSCharacters.js`).
- License: Apache License, Version 2.0. A copy is in `licenses/Apache-2.0.txt`.
- Used in: `src/modules/search/fold-data.ts`, the Traditional → Simplified character table
  that search folds text with (docs/SEARCH_DESIGN.md §2).
- Changes: reformatted into code-point pairs, identity entries dropped. Regenerate with
  `scripts/build-search-fold.ts`.
