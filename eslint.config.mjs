import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { includeIgnoreFile } from "@eslint/compat";
import { fileURLToPath } from "node:url";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));

export default tseslint.config(
	eslint.configs.recommended,
	tseslint.configs.recommended,
	includeIgnoreFile(gitignorePath, "Imported .gitignore patterns"),
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ── Critical async safety rules ──────────────────────────────────
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": ["error", {
				checksVoidReturn: { arguments: false },
			}],
			"prefer-promise-reject-errors": "error",
			// Catch empty catch blocks that silently swallow errors
			"no-empty": ["error", { "allowEmptyCatch": true }],

			// ── Suppress noisy rules that conflict with current patterns ──────
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-unused-vars": ["warn", {
				argsIgnorePattern: "^_",
				varsIgnorePattern: "^_",
			}],
		},
	},
	// Test files: relax rules that conflict with Chai/Mocha patterns
	{
		files: ['client/test/**/*.ts', 'client/test/**/*.test.ts'],
		rules: {
			'no-unused-expressions': 'off',
			'@typescript-eslint/no-unused-expressions': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},
	// Protocol, storage-recovery, and wire-format boundary files: forbid new `any`.
	// Keep these files strict so untrusted payloads stay `unknown` at the edge.
	// (runLedger is exempt: its event envelope intentionally keeps `any` — see the
	// comment on AgentRunEvent.payload.)
	{
		files: [
			'client/shared/protocolValidation.ts',
			'client/extension/ai/chat/webviewProtocol.ts',
			'client/extension/ai/durableStorage.ts',
			'client/extension/ai/orchestrationStore.ts',
			'client/extension/ai/runner/agentHandoff.ts',
		],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
		},
	},
);
