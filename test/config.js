// The config the tests run against.
// Monday 2 November 2026, 08:00 UTC.
export const NOW = Date.UTC(2026, 10, 2, 8, 0);
const DAY = 86_400_000;

export const ALPHA_TERMS = "Alpha NDA, version 1.\n\nDon't share the build.";

export const TEST_CONFIG = {
  betas: {
    alpha: {
      name: "Alpha closed beta",
      type: "game",
      status: "open",
      maxTesters: 300,
      endsAt: new Date(NOW + 20 * DAY).toISOString(),
      sources: ["list", "discord"],
      questions: [
        { id: "platform", type: "multi", label: "Platforms", options: ["Windows", "Steam Deck"], required: true },
        { id: "why", type: "longtext", label: "Why", max: 100 },
        { id: "hours", type: "number", label: "Hours", min: 0, max: 80 },
      ],
      terms: { text: ALPHA_TERMS, version: "v1" },
      keys: { product: "alpha", edition: "beta", expiresDays: 90 },
    },
    small: { name: "Small beta", type: "app", status: "open", maxTesters: 2, terms: { text: "Small terms", version: "1" } },
    shut: { name: "Shut beta", type: "app", status: "closed", terms: { text: "Shut terms", version: "1" } },
    hidden: { name: "Hidden beta", type: "book", status: "draft", terms: { text: "Hidden terms", version: "1" } },
    book: { name: "Book ARC", type: "book", status: "open", terms: { text: "ARC terms", version: "1" }, reminders: { newBuild: false, unclaimedInvite: false } },
  },
  builds: {
    "a-link": { beta: "alpha", label: "0.4 Windows (link)", source: "link", url: "https://example.com/alpha-0.4.zip" },
    "a-gh": { beta: "alpha", label: "0.4 GitHub", source: "github", repo: "me/alpha-builds", tag: "v0.4.0", asset: "Alpha-0.4.zip", survey: "s1" },
    "a-r2": { beta: "alpha", label: "0.4 R2", source: "r2", key: "builds/alpha-0.4.zip" },
    "a-deck": { beta: "alpha", label: "Deck build", source: "link", url: "https://example.com/deck.zip", groups: ["deck"] },
    "a-later": { beta: "alpha", label: "0.5", source: "link", url: "https://example.com/0.5.zip", availableAt: new Date(NOW + 2 * DAY).toISOString() },
  },
  surveys: {
    s1: {
      questions: [
        { id: "fun", type: "rating", label: "How fun?", required: true },
        { id: "notes", type: "text", label: "Notes" },
      ],
    },
  },
  email: { dailyCap: 90, monthlyCap: 2800 },
  screenshots: { store: "d1", maxBytes: "400KB", perBug: 2, totalCap: "1MB" },
};
