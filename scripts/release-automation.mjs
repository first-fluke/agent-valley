const releaseBranches = new Set([
  "release-please--branches--main--components--agent-valley",
  "release-please--branches--main",
])
const commitSha = /^[a-f0-9]{40}$/i

function stop(reason, afterMerge = false) {
  const recovery = afterMerge
    ? "The PR is already merged. Rerun the Release workflow to verify current main before creating a tag; do not force or revert the merge."
    : "Let release-please update its PR, then rerun the Release workflow for current main; do not force or bypass the merge."
  throw new Error(`Release automation stopped: ${reason}. ${recovery}`)
}

function repository(context) {
  const { owner, repo } = context?.repo ?? {}
  if (typeof owner !== "string" || !owner || typeof repo !== "string" || !repo) {
    stop("the workflow repository is missing")
  }
  return { owner, repo }
}

function ownsRepository(value, target) {
  return (
    typeof value?.full_name === "string" &&
    value.full_name.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()
  )
}

function permittedPull(pull, target) {
  return (
    pull.state === "open" &&
    pull.merged !== true &&
    pull.draft === false &&
    pull.user?.login === "github-actions[bot]" &&
    pull.user?.type === "Bot" &&
    pull.labels?.some((label) => label.name === "autorelease: pending") &&
    pull.base?.ref === "main" &&
    releaseBranches.has(pull.head?.ref) &&
    ownsRepository(pull.base?.repo, target) &&
    ownsRepository(pull.head?.repo, target)
  )
}

function validSha(value, description, afterMerge = false) {
  if (typeof value !== "string" || !commitSha.test(value)) stop(`${description} is not a full commit SHA`, afterMerge)
  return value
}

function parseVersion(value, path, ref) {
  const match =
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  const prerelease = match?.[4]?.split(".") ?? []
  if (
    !match ||
    match[0] !== value ||
    prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
  ) {
    stop(`${path} at ${ref} must contain a valid SemVer; restore matching project and release-please manifest versions`)
  }
  return { core: match.slice(1, 4), prerelease }
}

function compareIdentifier(left, right) {
  if (left === right) return 0
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left > right ? 1 : -1
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    const difference = compareIdentifier(left.core[i], right.core[i])
    if (difference) return difference
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return Number(!left.prerelease.length) - Number(!right.prerelease.length)
  }
  for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i++) {
    const difference = compareIdentifier(left.prerelease[i], right.prerelease[i])
    if (difference) return difference
  }
  return Math.sign(left.prerelease.length - right.prerelease.length)
}

async function releaseJson(github, target, ref, path) {
  try {
    const { data } = await github.rest.repos.getContent({ ...target, ref, path })
    if (data?.type !== "file" || data.path !== path || data.encoding !== "base64" || typeof data.content !== "string") {
      throw new Error("Expected a JSON file")
    }
    const value = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object")
    return value
  } catch {
    stop(`cannot read valid ${path} at ${ref}; restore this release-please version file and retry`)
  }
}

async function releaseVersion(github, target, ref) {
  const [project, manifest] = await Promise.all([
    releaseJson(github, target, ref, "package.json"),
    releaseJson(github, target, ref, ".release-please-manifest.json"),
  ])
  const version = parseVersion(project.version, "package.json", ref)
  parseVersion(manifest["."], ".release-please-manifest.json", ref)
  if (project.version !== manifest["."]) {
    stop(
      `package.json and .release-please-manifest.json versions disagree at ${ref}; synchronize release-please state before retrying`,
    )
  }
  return { value: project.version, version }
}

async function verifyVersionIncrease(github, target, baseSha, headSha) {
  const [base, candidate] = await Promise.all([
    releaseVersion(github, target, baseSha),
    releaseVersion(github, target, headSha),
  ])
  if (compareVersions(candidate.version, base.version) <= 0) {
    stop(
      `candidate version ${candidate.value} must be greater than current main ${base.value}; correct the release-please version selection before retrying`,
    )
  }
}

async function snapshot(github, target, number, expected) {
  const { data: pull } = await github.rest.pulls.get({ ...target, pull_number: number })
  if (pull.number !== number || !permittedPull(pull, target)) {
    stop(`PR #${number} no longer matches the owned, open release-please PR policy`)
  }
  const headSha = validSha(pull.head.sha, `PR #${number} head`)
  if (expected && (headSha !== expected.headSha || pull.head.ref !== expected.headBranch)) {
    stop(`PR #${number} head changed after verification`)
  }
  const { data: main } = await github.rest.git.getRef({ ...target, ref: "heads/main" })
  const baseSha = validSha(main.object?.sha, "current main")
  if (expected && baseSha !== expected.baseSha) stop("main changed after release verification")
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...target,
    basehead: `${baseSha}...${headSha}`,
  })
  if (comparison.merge_base_commit?.sha !== baseSha) {
    stop(`PR #${number} does not contain current main; its release contents are stale`)
  }
  await verifyVersionIncrease(github, target, baseSha, headSha)
  return { pull, candidate: { number, headSha, headBranch: pull.head.ref, baseSha } }
}

/** Find the current release PR even when release-please omits unchanged PR outputs. */
export async function discoverReleaseCandidate({ github, context }) {
  const target = repository(context)
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...target,
    base: "main",
    state: "open",
    per_page: 100,
  })
  const candidates = pulls.filter((pull) => permittedPull(pull, target))
  if (candidates.length === 0) return null
  if (candidates.length !== 1) stop("multiple owned release-please PRs are open; resolve the duplicate PRs")
  const number = candidates[0].number
  if (!Number.isSafeInteger(number) || number <= 0) stop("the release PR number is invalid")
  return (await snapshot(github, target, number)).candidate
}

/** Merge only the unchanged head that has just passed release verification. */
export async function mergeReleaseCandidate({ github, context, candidate }) {
  const target = repository(context)
  if (!candidate || !Number.isSafeInteger(candidate.number) || candidate.number <= 0) {
    stop("the verified release PR number is missing")
  }
  validSha(candidate.headSha, "verified release head")
  validSha(candidate.baseSha, "verified main")
  if (!releaseBranches.has(candidate.headBranch)) stop("the verified release branch is invalid")
  const { pull } = await snapshot(github, target, candidate.number, candidate)
  if (typeof pull.title !== "string" || !pull.title.trim()) stop("the release PR title is missing")
  const { data: result } = await github.rest.pulls.merge({
    ...target,
    pull_number: candidate.number,
    sha: candidate.headSha,
    merge_method: "squash",
    commit_title: pull.title,
  })
  if (result.merged !== true) {
    stop(`GitHub refused to merge PR #${candidate.number}: ${result.message ?? "merge was not confirmed"}`)
  }
  const mergedSha = validSha(result.sha, "release merge commit", true)
  const [{ data: verifiedCommit }, { data: mergedCommit }] = await Promise.all([
    github.rest.git.getCommit({ ...target, commit_sha: candidate.headSha }),
    github.rest.git.getCommit({ ...target, commit_sha: mergedSha }),
  ])
  const verifiedTree = validSha(verifiedCommit.tree?.sha, "verified release tree", true)
  const mergedTree = validSha(mergedCommit.tree?.sha, "release merge tree", true)
  if (verifiedTree !== mergedTree) {
    stop(`PR #${candidate.number} merged contents differ from the verified release head`, true)
  }
  return mergedSha
}
