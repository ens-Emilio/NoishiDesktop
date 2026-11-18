import React, { useEffect, useMemo, useRef, useState } from "react";

export type ArtifactRevision = {
	version: string;
	content: string;
	timestamp: number;
};

export type ArtifactSandboxProps = {
	title: string;
	kind: "html" | "svg" | "mermaid" | "react";
	revisions: ArtifactRevision[];
	onFixError?: (errorMessage: string) => void;
};

function buildSandboxHtml(kind: ArtifactSandboxProps["kind"], content: string): string {
	const errorBridge = `<script>
window.onerror = function(msg, src, line, col, err) {
  window.parent.postMessage({ type: "artifact-error", message: (err && err.stack) ? err.stack : String(msg) + " (" + line + ":" + col + ")" }, "*");
};
window.addEventListener("unhandledrejection", function(e) {
  window.parent.postMessage({ type: "artifact-error", message: e.reason && e.reason.stack ? e.reason.stack : String(e.reason) }, "*");
});
</script>`;

	if (kind === "svg") {
		return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;"></head><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;">${errorBridge}${content}</body></html>`;
	}

	return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;"></head><body>${errorBridge}${content}</body></html>`;
}

export function ArtifactSandbox({ title, kind, revisions, onFixError }: ArtifactSandboxProps): React.JSX.Element {
	const [selectedIdx, setSelectedIdx] = useState(Math.max(0, revisions.length - 1));
	const [showDiff, setShowDiff] = useState(false);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	const current = revisions[selectedIdx] ?? { version: "v1", content: "", timestamp: Date.now() };
	const previous = selectedIdx > 0 ? revisions[selectedIdx - 1] : null;

	const srcDoc = useMemo(() => buildSandboxHtml(kind, current.content), [kind, current.content]);

	useEffect(() => {
		setRuntimeError(null);
	}, [selectedIdx, current.content]);

	useEffect(() => {
		const handler = (event: MessageEvent): void => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			const data = event.data as { type?: string; message?: string } | null;
			if (data?.type === "artifact-error" && data.message) {
				setRuntimeError(data.message);
			}
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, []);

	return (
		<div className="artifact-sandbox" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
				<strong>{title}</strong>
				<select
					aria-label="Versão do Artifact"
					value={selectedIdx}
					onChange={(e) => setSelectedIdx(Number(e.target.value))}
				>
					{revisions.map((rev, idx) => (
						<option key={rev.version} value={idx}>
							{rev.version}
						</option>
					))}
				</select>
				{previous && (
					<button type="button" onClick={() => setShowDiff((d) => !d)}>
						{showDiff ? "Preview" : "Diff"}
					</button>
				)}
			</div>

			{runtimeError && (
				<div role="alert" style={{ padding: "8px 12px", background: "var(--danger-bg, #3b1219)", color: "#ffb4b4", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
					<pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{runtimeError}</pre>
					{onFixError && (
						<button type="button" onClick={() => onFixError(runtimeError)}>
							Corrigir erro com Noishi
						</button>
					)}
				</div>
			)}

			{showDiff && previous ? (
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 12, overflow: "auto", flex: 1 }}>
					<pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{previous.content}</pre>
					<pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{current.content}</pre>
				</div>
			) : (
				<iframe
					ref={iframeRef}
					title={title}
					sandbox="allow-scripts"
					srcDoc={srcDoc}
					style={{ border: 0, width: "100%", flex: 1, background: "#fff" }}
				/>
			)}
		</div>
	);
}
