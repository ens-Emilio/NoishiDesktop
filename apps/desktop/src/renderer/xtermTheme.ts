import type { ITheme } from "@xterm/xterm";

export function currentXtermTheme(): ITheme {
	const light = typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
	if (light) {
		return {
			background: "#f4f1f8",
			foreground: "#1b1722",
			cursor: "#6a4fc0",
			selectionBackground: "rgba(106,79,192,.22)",
			black: "#1b1722",
			red: "#b93a30",
			green: "#127354",
			yellow: "#8a5c17",
			blue: "#1a6f9c",
			magenta: "#6a4fc0",
			cyan: "#127354",
			white: "#faf8fc",
		};
	}
	return {
		background: "#15131b",
		foreground: "#f3f0f7",
		cursor: "#9b84e8",
		selectionBackground: "rgba(155,132,232,.28)",
		black: "#1a1820",
		red: "#f4786e",
		green: "#63d3a6",
		yellow: "#e6b45c",
		blue: "#7fd0ff",
		magenta: "#9b84e8",
		cyan: "#63d3a6",
		white: "#f3f0f7",
	};
}

export function observeXtermTheme(onChange: (theme: ITheme) => void): () => void {
	if (typeof MutationObserver === "undefined") return () => {};
	const observer = new MutationObserver(() => onChange(currentXtermTheme()));
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}
