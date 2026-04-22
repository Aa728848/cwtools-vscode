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
		rules: {
			// ── P2 Fix: critical async safety rules ──────────────────────────
			// Catches fire-and-forget Promises that silently swallow errors
			"@typescript-eslint/no-floating-promises": "warn",
			// Catches passing async functions where sync callbacks are expected
			"@typescript-eslint/no-misused-promises": ["warn", {
				checksVoidReturn: { arguments: false },  // allow async event handlers
			}],
			// Ensures reject() is called with Error objects, not strings
			"prefer-promise-reject-errors": "warn",

			// ── Suppress noisy rules that conflict with current patterns ──────
			// The AI module uses `any` extensively for provider API compatibility
			"@typescript-eslint/no-explicit-any": "off",
			// Dynamic imports are used intentionally for lazy loading
			"@typescript-eslint/no-require-imports": "off",
			// Unused vars with _ prefix are intentional (e.g. _context, _token)
			"@typescript-eslint/no-unused-vars": ["warn", {
				argsIgnorePattern: "^_",
				varsIgnorePattern: "^_",
			}],
		},
	}
);