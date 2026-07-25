import { defineConfig } from 'vitest/config';

// Scope vitest's root-level discovery to project tests only.
// `data/` holds the user's agent scratch workspaces (gitignored) which can
// contain nested projects with their own test suites; vitest does not respect
// .gitignore, so we must exclude explicitly.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**', '.claude/**', '.worktrees/**'],
  },
});
