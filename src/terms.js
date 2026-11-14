// Terms texts, imported at build time (wrangler.jsonc "rules" bundles .md
// files as text). Add one line per terms file that beta.json names; the key
// is the path beta.json uses in "terms.file".
import hollowLanternNda from "../terms/hollow-lantern-nda.md";
import arc from "../terms/arc.md";

export default {
  "terms/hollow-lantern-nda.md": hollowLanternNda,
  "terms/arc.md": arc,
};
