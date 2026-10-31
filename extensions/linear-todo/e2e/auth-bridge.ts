import { readFileSync, unlinkSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ENV = "LINEAR_TODO_EVAL_AUTH_PROVIDER";
const CREDENTIAL_FILE_ENV = "LINEAR_TODO_EVAL_AUTH_CREDENTIAL_FILE";

/**
 * E2E-only auth bridge.
 *
 * The parent runner resolves a refreshed credential with `pi auth check` and hands it to this
 * isolated agent directory as a short-lived file. The file is read once and deleted before any
 * model or shell tool can run, so the credential never lives in the child environment (where the
 * agent's bash tool inherits it) and never reaches the artifacts.
 */
export default function linearTodoEvalAuthBridge(pi: ExtensionAPI): void {
  const provider = process.env[PROVIDER_ENV]?.trim();
  const credentialFile = process.env[CREDENTIAL_FILE_ENV]?.trim();
  if (!provider || !credentialFile) {
    throw new Error(`Missing ${PROVIDER_ENV} or ${CREDENTIAL_FILE_ENV} for model evaluation.`);
  }

  const credential = readFileSync(credentialFile, "utf8").trim();
  try {
    // Delete the handshake file immediately: the run itself must not be able to read it back.
    unlinkSync(credentialFile);
  } catch {
    // A concurrent restart may have consumed it already.
  }
  if (!credential) throw new Error(`Empty credential file for model evaluation: ${credentialFile}`);

  // `$` starts an environment reference in provider config values, so a literal `$` must be doubled.
  // The replacer function is required: a `$$` replacement string would collapse back to `$`.
  pi.registerProvider(provider, { apiKey: credential.replaceAll("$", () => "$$") });
}
