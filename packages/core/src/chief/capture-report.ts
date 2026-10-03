import type { Mission } from "./types"

/** Capture status and hashes come from actual local artifacts, never the model narrative. */
export function captureReportLines(mission: Mission): string[] {
  const capture = mission.capture
  if (!capture) return []
  const videos = capture.attachments.filter((file) => file.mimeType === "video/mp4")
  return [
    `상태: ${capture.status} / 실제 화면 캡처 ${capture.frames}장 / 실제 MP4 ${videos.length}개`,
    `기록 기간: ${capture.startedAt} → ${capture.finishedAt}`,
    "Aside에서 일정 간격으로 찍은 화면입니다. MP4가 있으면 실제 캡처 시각 간격으로 합친 무음 영상이며, 브라우저의 연속 full-motion 녹화가 아닙니다.",
    "외부 첨부 전송 여부는 별도 delivery 결과로 확인해야 합니다.",
    ...capture.attachments.map(
      (file) => `${file.name} / ${file.mimeType} / ${file.sizeBytes} bytes / SHA256 ${file.sha256}`,
    ),
    ...capture.errors.map((error) => `캡처 오류: ${error}`),
  ]
}
