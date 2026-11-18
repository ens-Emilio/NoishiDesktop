import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { currentXtermTheme, observeXtermTheme } from "./xtermTheme.js";

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
			theme: currentXtermTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		const offTheme = observeXtermTheme((theme) => {
			term.options.theme = theme;
		});
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
			offTheme();
			offData();
			window.noishi.sandboxTty.close();
			term.dispose();
		};
	}, [booted]);

	if (!booted) return <div className="sandbox-empty">Ligue a VM para abrir o terminal.</div>;
	return <div className="terminal-host" ref={hostRef} />;
}
