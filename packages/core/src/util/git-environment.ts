/** Ignore inherited Git selectors when inspecting an explicitly selected repository. */
export const clearedGitEnvironment = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_LITERAL_PATHSPECS: undefined,
  GIT_GLOB_PATHSPECS: undefined,
  GIT_NOGLOB_PATHSPECS: undefined,
  GIT_ICASE_PATHSPECS: undefined,
}
