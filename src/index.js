// perchlight-beta: a private beta and advance-reader portal on Cloudflare
// Workers + D1 + one small Durable Object (Clock). Your betas, builds and
// surveys are in beta.json at the repo root; terms texts are listed in
// src/terms.js. There is no cron trigger (docs/SDD.md, "Clock").
import config from "../beta.json";
import terms from "./terms.js";
import { makeWorker } from "./app.js";
import { clockClass } from "./clock.js";

export default makeWorker(config, terms);
export const Clock = clockClass(config, terms);
