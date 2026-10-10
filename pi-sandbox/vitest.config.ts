import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// This package's real win32 suite rewrites the shared %TEMP% ACL (the first e2e grant
		// eagerly propagates a persistent ACE across the whole tree), and assertions such as
		// diagnose-script that expect "unchanged before and after" also build fixtures under
		// that same tree. File-level parallelism lets grant propagation land between an
		// assertion's before and after (reproduced on the first real-machine run), so run serially.
		fileParallelism: false,
	},
});
