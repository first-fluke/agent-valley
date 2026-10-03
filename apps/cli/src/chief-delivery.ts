import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { recordMissionOrganizationOutcome } from "@agent-valley/core/chief/organization"
import { dispatchMissionReport } from "@agent-valley/core/chief/report-delivery"
import { fallbackReport, renderReport } from "@agent-valley/core/chief/reports"
import type { Mission } from "@agent-valley/core/chief/types"
import { mergeChiefConfig } from "@agent-valley/core/config/chief-schema"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"

/** Delivery errors do not invalidate verified work or trigger another Actor run. */
export async function saveAndDeliverMissionReport(mission: Mission, root: string): Promise<void> {
  const repository = mission.repositoryRoot ?? root
  const directory = join(root, ".agent-valley/reports")
  const reportPath = join(directory, `${mission.id}.md`)
  const report = renderReport(mission)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(reportPath, report, { mode: 0o600 })
  const explanation =
    mission.status === "completed" ? (mission.report ?? fallbackReport(mission)) : fallbackReport(mission)
  console.log(`Report: ${reportPath}\n${explanation.eli5}`)
  if (mission.operatingPolicy?.memory && ["completed", "failed"].includes(mission.status)) {
    await recordMissionOrganizationOutcome(repository, mission).catch((error: unknown) => {
      console.error(`Organization outcome was not stored: ${error instanceof Error ? error.message : "Storage failed"}`)
    })
  }
  try {
    const config = mergeChiefConfig(loadGlobalConfig()?.chief, loadProjectConfig(root)?.chief)
    const attachments = [...(mission.capture?.attachments ?? [])]
    const artifactRoot = join(repository, ".agent-valley/captures")
    if (config.reporting?.destinations.length) {
      const bytes = Buffer.from(report)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const reportDirectory = join(artifactRoot, mission.id)
      const attachmentPath = join(reportDirectory, `report-${sha256}.md`)
      await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
      await writeFile(attachmentPath, bytes, { mode: 0o600 })
      attachments.push({
        path: attachmentPath,
        name: `report-${mission.id}.md`,
        mimeType: "text/markdown",
        sizeBytes: bytes.length,
        sha256,
      })
    }
    const receipts = await dispatchMissionReport(
      mission,
      report,
      reportPath,
      config.reporting,
      join(repository, ".agent-valley"),
      {
        attachments,
        artifactRoot,
      },
    )
    for (const receipt of receipts)
      console.log(
        `Report ${receipt.destinationId}: ${receipt.status}${receipt.status === "delivered" ? "" : ` — ${receipt.message}. Retry with av reports retry.`}`,
      )
  } catch (error) {
    console.error(
      `Report delivery requires attention: ${error instanceof Error ? error.message : "Delivery failed"}. Run av reports retry after fixing reporting configuration.`,
    )
  }
}
