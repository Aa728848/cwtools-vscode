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
	}
);