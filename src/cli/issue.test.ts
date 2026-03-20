import { describe, it, expect } from "bun:test"
import { parseIssueInput, parseExpandedIssue } from "./issue"

describe("parseIssueInput", () => {
  it("splits title and description on newline", () => {
    const result = parseIssueInput("로그인 기능 추가\nJWT 토큰 발급, bcrypt 검증 포함")
    expect(result.title).toBe("로그인 기능 추가")
    expect(result.description).toBe("JWT 토큰 발급, bcrypt 검증 포함")
  })

  it("uses full text as title when no newline", () => {
    const result = parseIssueInput("로그인 기능 추가")
    expect(result.title).toBe("로그인 기능 추가")
    expect(result.description).toBe("")
  })

  it("trims whitespace", () => {
    const result = parseIssueInput("  제목  \n  설명  ")
    expect(result.title).toBe("제목")
    expect(result.description).toBe("설명")
  })

  it("handles multi-line description", () => {
    const result = parseIssueInput("제목\n줄1\n줄2\n줄3")
    expect(result.title).toBe("제목")
    expect(result.description).toBe("줄1\n줄2\n줄3")
  })

  it("handles empty string", () => {
    const result = parseIssueInput("")
    expect(result.title).toBe("")
    expect(result.description).toBe("")
  })
})

describe("parseExpandedIssue", () => {
  it("parses TITLE and DESCRIPTION from Claude output", () => {
    const output = `TITLE: feat(auth): 로그인 API 엔드포인트 구현
DESCRIPTION:
## Goal
POST /auth/login 엔드포인트를 구현한다.

## Requirements
- JWT 토큰 발급
- bcrypt 비밀번호 검증
- 실패 시 401 응답`

    const result = parseExpandedIssue(output)
    expect(result.title).toBe("feat(auth): 로그인 API 엔드포인트 구현")
    expect(result.description).toContain("## Goal")
    expect(result.description).toContain("JWT 토큰 발급")
  })

  it("handles missing DESCRIPTION", () => {
    const output = "TITLE: fix(server): 서버 크래시 수정"
    const result = parseExpandedIssue(output)
    expect(result.title).toBe("fix(server): 서버 크래시 수정")
    expect(result.description).toBe("")
  })

  it("falls back to first 80 chars when no TITLE marker", () => {
    const output = "그냥 텍스트만 있는 경우"
    const result = parseExpandedIssue(output)
    expect(result.title).toBe("그냥 텍스트만 있는 경우")
  })

  it("truncates fallback title at 80 chars", () => {
    const long = "a".repeat(120)
    const result = parseExpandedIssue(long)
    expect(result.title.length).toBe(80)
  })

  it("handles multiline description with sections", () => {
    const output = `TITLE: feat(api): 사용자 프로필 API
DESCRIPTION:
## Goal
사용자 프로필 CRUD API를 구현한다.

## Requirements
- GET /users/:id
- PATCH /users/:id
- 인증 미들웨어 적용

## Notes
- 기존 User 모델 활용`

    const result = parseExpandedIssue(output)
    expect(result.title).toBe("feat(api): 사용자 프로필 API")
    expect(result.description).toContain("## Goal")
    expect(result.description).toContain("## Requirements")
    expect(result.description).toContain("## Notes")
    expect(result.description).toContain("기존 User 모델 활용")
  })
})
