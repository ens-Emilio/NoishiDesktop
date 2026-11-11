import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: ["@noushi/rpc-bridge", "@noushi/noushi-sdk"] })],
		build: {
			lib: { entry: "src/main/index.ts", formats: ["es"] },
			rollupOptions: { input: { index: resolve("src/main/index.ts") } },
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["@noushi/rpc-bridge"] })],
		build: { lib: { entry: "src/preload/index.ts", formats: ["cjs"] } },
	},
	renderer: {
		root: "src/renderer",
		plugins: [react()],
		build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
	},
});
