/**
 * Terminal view: xterm.js bound to the main-process PTY for this window.
 * Mounted only while the Terminal tab is active; unmounting keeps the PTY
 * alive (the main process owns it) so switching tabs doesn't kill the shell.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ cwd }: { cwd: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
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
		termRef.current = term;

		const offData = window.noishi.pty.onData((data) => term.write(data));
		const offExit = window.noishi.pty.onExit((code) => {
			term.write(`\r\n\x1b[2m[processo encerrado: ${code}]\x1b[0m\r\n`);
		});
		void window.noishi.pty.create(cwd, term.cols, term.rows);
		term.onData((data) => window.noishi.pty.write(data));

		const onResize = (): void => {
			fit.fit();
			window.noishi.pty.resize(term.cols, term.rows);
		};
		const observer = new ResizeObserver(onResize);
		observer.observe(host);
		term.focus();

		return () => {
			observer.disconnect();
			offData();
			offExit();
			term.dispose();
			termRef.current = null;
		};
	}, [cwd]);

	return <div className="terminal-host" ref={hostRef} />;
}
