import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/resolve-ts-loader.mjs", pathToFileURL("./"));
