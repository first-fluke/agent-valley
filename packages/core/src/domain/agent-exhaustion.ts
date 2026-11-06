export type AgentExhaustion = "context" | "usage"

/** Recognizes terminal provider exhaustion, excluding transient throttling and local run limits. */
export function classifyAgentExhaustion(reason: string): AgentExhaustion | undefined {
  const normalized = reason.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
  if (
    /\bcontext (?:length|window) (?:is )?(?:exceeded|exhausted|full)|\bcontext (?:length|window) limit|\b(?:maximum|max) context length|\bprompt (?:is )?too long|\btoo many (?:input |prompt )tokens|\btoken budget (?:is )?exhausted\b/i.test(
      normalized,
    )
  )
    return "context"
  if (
    /\busage limit (?:is )?(?:reached|exceeded)|\binsufficient (?:quota|credits?)\b|\b(?:credit balance|credits?) (?:is |are )?(?:too )?(?:low|exhausted|depleted)|\bout of credits\b|\b(?:hit|reached) (?:your |the )?(?:usage |subscription |weekly |monthly |daily )limit\b|\b(?:you(?:'|’)ve|you have) hit your limit\b|\bquota (?:is )?(?:exceeded|exhausted)|\b(?:usage|subscription) allowance (?:is )?(?:exhausted|depleted)\b/i.test(
      normalized,
    )
  )
    return "usage"
  return undefined
}
