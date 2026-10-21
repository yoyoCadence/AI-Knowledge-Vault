/**
 * Search tokenizer (docs/SEARCH_DESIGN.md §2, ADR-009). Traditional Chinese has no spaces
 * between words, so Postgres' own parsers would index a whole sentence as one token. Instead
 * the app tokenizes: CJK runs become overlapping bigrams plus unigrams, Latin/number runs
 * become words, and the result is written as a `tsvector` literal with explicit positions.
 * Query text goes through the same normalization and becomes a `tsquery` string.
 *
 * Lexemes only ever contain `\p{L}`/`\p{N}` characters, so neither output can carry quotes,
 * backslashes or tsquery operators from user input.
 */

/** Bump to re-index everything (`search.reindex_all`). */
export const TOKENIZER_VERSION = 1;
/** Postgres clamps tsvector positions to 1..16383. */
const MAX_POSITION = 16_383;
const MAX_WORD_LENGTH = 64;
const MAX_QUERY_TERMS = 16;
/**
 * Positions skipped between the parts of a tsvector (title, description, source …). Larger
 * than any distance a phrase query can ask for between two of its tokens, so a phrase never
 * matches across two parts.
 */
const PART_GAP = 100;

export type Weight = "A" | "B" | "C" | "D";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

export function normalizeForSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

type Run = { kind: "cjk"; chars: string[] } | { kind: "word"; text: string };

/** Splits normalized text into CJK runs and word runs; anything else separates runs. */
function runsOf(normalized: string): (Run | null)[] {
  const runs: (Run | null)[] = []; // null marks a separator run
  let word = "";
  let cjk: string[] = [];
  const flush = () => {
    // Truncated by code point, so a cut never leaves half a surrogate pair.
    if (word)
      runs.push({ kind: "word", text: Array.from(word).slice(0, MAX_WORD_LENGTH).join("") });
    if (cjk.length > 0) runs.push({ kind: "cjk", chars: cjk });
    word = "";
    cjk = [];
  };
  let separated = false;
  for (const char of normalized) {
    if (CJK.test(char)) {
      if (word) flush();
      cjk.push(char);
      separated = false;
    } else if (WORD.test(char)) {
      if (cjk.length > 0) flush();
      word += char;
      separated = false;
    } else {
      flush();
      if (!separated) runs.push(null);
      separated = true;
    }
  }
  flush();
  return runs;
}

export interface Token {
  lexeme: string;
  position: number;
}

/**
 * Index tokens with positions. One position per CJK character, per word and per separator
 * run, so consecutive bigrams sit at consecutive positions (`<->` matches them) while
 * phrases never match across a separator. A bigram takes its first character's position.
 */
export function indexTokens(text: string, startPosition = 1): Token[] {
  const tokens: Token[] = [];
  let position = startPosition;
  for (const run of runsOf(normalizeForSearch(text))) {
    if (run === null) {
      position += 1;
    } else if (run.kind === "word") {
      tokens.push({ lexeme: run.text, position });
      position += 1;
    } else {
      run.chars.forEach((char, index) => {
        tokens.push({ lexeme: char, position: position + index });
        const next = run.chars[index + 1];
        if (next) tokens.push({ lexeme: char + next, position: position + index });
      });
      position += run.chars.length;
    }
  }
  return tokens;
}

/**
 * A `tsvector` literal for weighted text parts, e.g. `'城市':1A '城':1A …`. Parts are laid
 * out one after another, `PART_GAP` positions apart, so a phrase never spans two parts.
 * Postgres keeps at most 256 positions per lexeme; later repeats of a very frequent lexeme
 * still match single-token queries but not phrases (docs/SEARCH_DESIGN.md §9).
 *
 * Positions end at 16,383. Postgres would clamp later ones all to that value, where no phrase
 * could match, so tokens past it are left out instead: callers put the parts that matter most
 * first, and everything indexed keeps its true position.
 */
export function toTsvector(parts: { text: string; weight: Weight }[]): string {
  const positions = new Map<string, string[]>();
  let start = 1;
  for (const part of parts) {
    if (start > MAX_POSITION) break;
    const tokens = indexTokens(part.text, start);
    for (const token of tokens) {
      if (token.position > MAX_POSITION) continue;
      const list = positions.get(token.lexeme) ?? [];
      list.push(`${token.position}${part.weight}`);
      positions.set(token.lexeme, list);
    }
    start = (tokens.at(-1)?.position ?? start) + PART_GAP;
  }
  return [...positions]
    .map(([lexeme, list]) => `'${lexeme}':${[...new Set(list)].join(",")}`)
    .join(" ");
}

/** The terms of a query, for building the tsquery and for highlighting matches. */
export interface QueryTerm {
  /** Index tokens of the term in order, with their relative positions. */
  tokens: Token[];
  /** Latin single words match as prefixes (`therm` → `thermal`). */
  prefix: boolean;
  /** The normalized text pieces to highlight (CJK runs, words). */
  highlights: string[];
}

/**
 * Parses a user query: quoted parts are phrases; otherwise each CJK run is a phrase of its
 * bigrams and each word is a prefix term. All terms must match (AND). At most 16 terms.
 */
export function parseQuery(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  const pieces = query.split('"');
  pieces.forEach((piece, index) => {
    const quoted = index % 2 === 1 && index < pieces.length - 1;
    const runs = runsOf(normalizeForSearch(piece));
    if (quoted) {
      const tokens = phraseTokens(piece);
      if (tokens.length > 0) {
        terms.push({
          tokens,
          prefix: false,
          highlights: runs.flatMap((run) =>
            run === null ? [] : [run.kind === "word" ? run.text : run.chars.join("")],
          ),
        });
      }
      return;
    }
    for (const run of runs) {
      if (run === null) continue;
      const text = run.kind === "word" ? run.text : run.chars.join("");
      terms.push({ tokens: phraseTokens(text), prefix: run.kind === "word", highlights: [text] });
    }
  });
  return terms.slice(0, MAX_QUERY_TERMS);
}

/**
 * The tokens a phrase must match, in order: words, and for CJK runs their bigrams (a single
 * CJK character is its unigram). Unigrams of longer runs are redundant given the bigrams.
 */
function phraseTokens(text: string): Token[] {
  const all = indexTokens(text);
  const keep: Token[] = [];
  for (const token of all) {
    const chars = [...token.lexeme];
    const isCjk = CJK.test(chars[0] ?? "");
    if (!isCjk) {
      keep.push(token);
    } else if (chars.length === 2) {
      keep.push(token);
    } else {
      // A unigram is kept only when no bigram starts or ends on it (a lone CJK character).
      const covered = all.some(
        (other) =>
          [...other.lexeme].length === 2 &&
          (other.position === token.position || other.position === token.position - 1),
      );
      if (!covered) keep.push(token);
    }
  }
  return keep;
}

/**
 * One `tsquery` per searchable term. The search matches each term on its own and requires
 * every term somewhere in the artifact (any chunk or the metadata document), so terms in
 * different sections, or one in the title and one in the body, still find it.
 */
export function termTsqueries(terms: QueryTerm[]): string[] {
  return terms
    .filter((term) => term.tokens.length > 0)
    .map((term) => {
      const [first, ...rest] = term.tokens;
      let expression = `'${first!.lexeme}'${term.prefix && rest.length === 0 ? ":*" : ""}`;
      let previous = first!.position;
      for (const token of rest) {
        const distance = token.position - previous;
        expression += ` ${distance === 1 ? "<->" : `<${distance}>`} '${token.lexeme}'`;
        previous = token.position;
      }
      return rest.length > 0 ? `(${expression})` : expression;
    });
}

/** All terms in one `tsquery` (`&`), or null when the query has nothing searchable. */
export function toTsquery(terms: QueryTerm[]): string | null {
  const parts = termTsqueries(terms);
  return parts.length > 0 ? parts.join(" & ") : null;
}
