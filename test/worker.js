// The Worker under test: the app and Clock built around the tests' config.
import { makeWorker } from "../src/app.js";
import { clockClass } from "../src/clock.js";
import { TEST_CONFIG } from "./config.js";

export default makeWorker(TEST_CONFIG);
export const Clock = clockClass(TEST_CONFIG);
