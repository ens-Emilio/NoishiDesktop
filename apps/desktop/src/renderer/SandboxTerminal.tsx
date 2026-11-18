/**
 * Sandbox terminal: xterm.js bound to the VM's serial console through the
 * sandboxTty bridge (feature 41). Unlike the host terminal there is no PTY
 * resize: the guest serial line has a fixed geometry, so the view only fits
 * the font.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function SandboxTerminal({ booted }: { booted: boolean }) {
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !booted) return;
		const term = new XTerm({
			fontFamily: '"JetBrains Mono", ui-monospace, monospace',
			fontSize: 12.5,
			lineHeight: 1.5,
			cursorBlink: true,
			theme: {
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
			},
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		const offData = window.noishi.sandboxTty.onData((data) => term.write(data));
		void window.noishi.sandboxTty.open(term.cols, term.rows).then((result) => {
			if (!result.ok) term.write(`\r\n\x1b[31m${result.error ?? "tty indisponível"}\x1b[0m\r\n`);
		});
		term.onData((data) => window.noishi.sandboxTty.write(data));
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host);
		term.focus();
		return () => {
			observer.disconnect();
			offData();
			window.noishi.sandboxTty.close();
			term.dispose();
		};
	}, [booted]);

	if (!booted) return <div className="sandbox-empty">Ligue a VM para abrir o terminal.</div>;
	return <div className="terminal-host" ref={hostRef} />;
}
