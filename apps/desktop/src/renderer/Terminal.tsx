/**
 * Terminal view: xterm.js bound to the main-process PTY for this window.
 * Reuses the existing main-process PTY on tab switches and restores recent scrollback.
 */

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { currentXtermTheme, observeXtermTheme } from "./xtermTheme.js";

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
			theme: currentXtermTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		termRef.current = term;

		const offTheme = observeXtermTheme((theme) => {
			term.options.theme = theme;
		});
		const offData = window.noishi.pty.onData((data) => term.write(data));
		const offExit = window.noishi.pty.onExit((code) => {
			term.write(`\r\n\x1b[2m[processo encerrado: ${code}]\x1b[0m\r\n`);
		});
		void window.noishi.pty.create(cwd, term.cols, term.rows).then((res) => {
			if (res.reused && res.history) term.write(res.history);
		});
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
			offTheme();
			offData();
			offExit();
			term.dispose();
			termRef.current = null;
		};
	}, [cwd]);

	return <div className="terminal-host" ref={hostRef} />;
}
