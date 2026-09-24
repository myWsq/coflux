import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_LIBRARY,
  clearHistory,
  isBookmarked,
  parseLibrary,
  rankSuggestions,
  readLibrary,
  recordVisit,
  serializeLibrary,
  setBookmarksBarVisible,
  toggleBookmark,
  updateHistoryTitle,
  writeLibrary,
  type BrowserLibrary,
} from "./browser-library";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("a visit moves the page to the front and counts it; non-web URLs are not remembered", () => {
  let library: BrowserLibrary = EMPTY_LIBRARY;
  library = recordVisit(library, { url: "http://localhost:5173/", title: "" }, NOW);
  library = recordVisit(library, { url: "https://example.com/", title: "Example" }, NOW + 1);
  library = recordVisit(library, { url: "http://localhost:5173/", title: "Vite App" }, NOW + 2);
  assert.deepEqual(
    library.history.map((entry) => [entry.url, entry.title, entry.visitCount]),
    [
      ["http://localhost:5173/", "Vite App", 2],
      ["https://example.com/", "Example", 1],
    ],
  );
  assert.equal(recordVisit(library, { url: "about:blank", title: "" }, NOW), library);
  assert.equal(recordVisit(library, { url: "file:///etc/hosts", title: "" }, NOW), library);
  // A late title fills in; an empty one keeps what is known.
  library = updateHistoryTitle(library, "https://example.com/", "Example Domain");
  assert.equal(library.history[1]!.title, "Example Domain");
  assert.equal(updateHistoryTitle(library, "https://example.com/", ""), library);
  library = recordVisit(library, { url: "https://example.com/", title: "" }, NOW + 3);
  assert.equal(library.history[0]!.title, "Example Domain");
});

test("history is capped by dropping the oldest visits", () => {
  let library: BrowserLibrary = EMPTY_LIBRARY;
  for (let index = 0; index < 5; index++) library = recordVisit(library, { url: `https://site${index}.com/`, title: "" }, NOW + index, 3);
  assert.deepEqual(
    library.history.map((entry) => entry.url),
    ["https://site4.com/", "https://site3.com/", "https://site2.com/"],
  );
  assert.equal(clearHistory(library).history.length, 0);
});

test("☆ toggles a bookmark; the bar toggle is remembered", () => {
  let library = toggleBookmark(EMPTY_LIBRARY, { url: "http://localhost:3000/", title: "App" }, NOW);
  assert.equal(isBookmarked(library, "http://localhost:3000/"), true);
  library = toggleBookmark(library, { url: "http://localhost:3000/", title: "App" }, NOW);
  assert.equal(isBookmarked(library, "http://localhost:3000/"), false);
  assert.equal(toggleBookmark(library, { url: "about:blank", title: "" }, NOW), library);
  library = setBookmarksBarVisible(library, true);
  assert.equal(parseLibrary(serializeLibrary(library)).bookmarksBarVisible, true);
});

test("storage round-trips, and missing or corrupt storage reads as an empty library", () => {
  let library = recordVisit(EMPTY_LIBRARY, { url: "https://example.com/", title: "Example" }, NOW);
  library = toggleBookmark(library, { url: "https://docs.example.com/", title: "Docs" }, NOW);
  const storage = memoryStorage();
  assert.ok(writeLibrary({ storage, key: "lib" }, library));
  assert.deepEqual(readLibrary({ storage, key: "lib" }), library);

  assert.deepEqual(readLibrary({ storage: memoryStorage(), key: "lib" }), EMPTY_LIBRARY);
  assert.deepEqual(parseLibrary("{not json"), EMPTY_LIBRARY);
  assert.deepEqual(parseLibrary(JSON.stringify({ version: 99, history: [] })), EMPTY_LIBRARY);
  assert.deepEqual(parseLibrary(JSON.stringify([1, 2, 3])), EMPTY_LIBRARY);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(readLibrary({ storage: throwing, key: "lib" }), EMPTY_LIBRARY);
  assert.equal(writeLibrary({ storage: throwing, key: "lib" }, library), false);

  // Bad entries are skipped one by one, duplicates collapse, bad counts repair.
  const partial = parseLibrary(
    JSON.stringify({
      version: 1,
      history: [
        { url: "https://a.com/", title: "A", visitCount: 3, lastVisitedAt: NOW },
        { url: "javascript:alert(1)", title: "x" },
        "junk",
        { url: "https://a.com/", title: "dup" },
        { url: "https://b.com/", title: 42, visitCount: -1, lastVisitedAt: "soon" },
      ],
      bookmarks: [{ url: "https://c.com/" }, { url: 7 }],
      bookmarksBarVisible: "yes",
    }),
  );
  assert.deepEqual(
    partial.history.map((entry) => [entry.url, entry.title, entry.visitCount]),
    [
      ["https://a.com/", "A", 3],
      ["https://b.com/", "", 1],
    ],
  );
  assert.deepEqual(partial.bookmarks.map((bookmark) => bookmark.url), ["https://c.com/"]);
  assert.equal(partial.bookmarksBarVisible, false);
});

test("suggestions rank URL-prefix matches first, bookmarks over history, frequent and recent pages higher", () => {
  let library: BrowserLibrary = EMPTY_LIBRARY;
  library = recordVisit(library, { url: "https://github.com/coflux/coflux", title: "coflux repo" }, NOW - 30 * DAY);
  library = recordVisit(library, { url: "https://docs.github.com/", title: "GitHub Docs" }, NOW - 30 * DAY);
  library = recordVisit(library, { url: "https://example.com/about-github", title: "About" }, NOW - 30 * DAY);
  for (let index = 0; index < 4; index++) library = recordVisit(library, { url: "https://gist.github.com/", title: "Gists" }, NOW - DAY / 2);
  library = toggleBookmark(library, { url: "https://github.com/", title: "GitHub" }, NOW);

  const ranked = rankSuggestions(library, "git", NOW).map((suggestion) => suggestion.url);
  // Prefix of the typed form: the bookmark first, then the history entry with the same match.
  assert.equal(ranked[0], "https://github.com/");
  assert.equal(ranked[1], "https://github.com/coflux/coflux");
  // Host label prefix, frequent and recent, ranks above an older one with the same match.
  assert.ok(ranked.indexOf("https://gist.github.com/") < ranked.indexOf("https://docs.github.com/"));
  // A substring match ranks last.
  assert.equal(ranked[ranked.length - 1], "https://example.com/about-github");
  // Every URL once; a bookmarked page is suggested as the bookmark.
  assert.equal(new Set(ranked).size, ranked.length);
  assert.equal(rankSuggestions(library, "github.com", NOW)[0]!.source, "bookmark");

  // Title words, multi-word queries, no match, empty query and the limit.
  assert.deepEqual(
    rankSuggestions(library, "coflux repo", NOW).map((suggestion) => suggestion.url),
    ["https://github.com/coflux/coflux"],
  );
  assert.deepEqual(rankSuggestions(library, "zzz", NOW), []);
  assert.deepEqual(rankSuggestions(library, "  ", NOW), []);
  assert.equal(rankSuggestions(library, "git", NOW, 2).length, 2);
  // Scheme and www. are ignored when matching what is typed.
  const www = recordVisit(EMPTY_LIBRARY, { url: "https://www.example.org/", title: "" }, NOW);
  assert.equal(rankSuggestions(www, "example.org", NOW)[0]!.url, "https://www.example.org/");
});
