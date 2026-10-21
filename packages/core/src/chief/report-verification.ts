import { reviewGatesAreCurrent } from "./review-gate-check"
import type { Mission } from "./types"
import { validateGoalVerificationResult } from "./verification"

/** Report gaps from saved checks without treating Actor prose as completion evidence. */
export function verificationIncompleteReasons(mission: Mission): string[] {
  const reasons: string[] = []
  if (!mission.verification) reasons.push("운영자 검증이 아직 기록되지 않았습니다.")
  else if (!mission.verification.ok) reasons.push("운영자 검증을 통과하지 못했습니다.")
  if (!reviewGatesAreCurrent(mission, mission.verification?.fingerprint))
    reasons.push("설정된 추가 검토가 누락되었거나 현재 검증 파일과 일치하지 않습니다.")
  if (mission.verificationMode === "chief" || mission.goalVerification) {
    try {
      if (
        !mission.verificationContract ||
        !mission.goalVerification ||
        !validateGoalVerificationResult(mission.goalVerification, mission.verificationContract).ok
      )
        reasons.push("목표별 실제 파일·테스트 검증이 통과하지 않았습니다.")
    } catch {
      reasons.push("목표별 검증 증거가 고정된 검사 계약과 일치하지 않습니다.")
    }
  }
  return reasons
}
