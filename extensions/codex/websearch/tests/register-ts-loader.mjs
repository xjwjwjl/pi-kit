import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-ts-loader.mjs", pathToFileURL("./tests/"));
