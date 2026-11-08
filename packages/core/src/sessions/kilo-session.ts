/**
 * KiloSession — Kilo Code CLI (`@kilocode/cli`) with streaming NDJSON output.
 *
 * Mode: kilo run "<prompt>" --format json --auto [--model <provider/model>]
 * Shares the OpenCode CLI protocol (`OpencodeSession`) with `kilo` binary,
 * `~/.local/share/kilo/auth.json` credentials, and Kilo Gateway free/paid
 * model catalog (`kilo/*`).
 */

import { OpencodeSession } from "./opencode-session"

export const KILO_COMMAND = "kilo"

export class KiloSession extends OpencodeSession {
  protected override readonly vendorType = "kilo"
  protected override readonly vendorCommand = KILO_COMMAND
  protected override readonly vendorLabel = "Kilo"
  protected override readonly authCommandHint = "kilo auth"
  protected override readonly authLocationHint = "~/.local/share/kilo/auth.json"
}
