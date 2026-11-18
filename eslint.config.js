// ESLint flat config for the desktop app and shared packages.
//
// Scope is typed TypeScript only. The rules enabled here are the ones the repo
// actually enforces (no `any`, no dynamic imports, no dropped promises, type-only
// imports). Type-aware rules that would flag correct code at the RPC boundary —
// where values are `unknown` and narrowed at the edge — stay off on purpose.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/node_modules/**",
			"**/out/**",
			"**/dist/**",
			"apps/desktop/extension/**",
			"apps/desktop/native-host/**",
			"apps/desktop/build/**",
			"probe/**",
			"eslint.config.js",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"@typescript-eslint/no-require-imports": "error",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"prefer-const": "error",
			eqeqeq: ["error", "smart"],
		},
	},
	{
		// The renderer's event handlers narrow `unknown` RPC payloads with
		// readString(); the base-to-string rule cannot see through that.
		files: ["apps/desktop/src/renderer/**/*.tsx"],
		rules: {
			"@typescript-eslint/no-base-to-string": "off",
		},
	},
);
