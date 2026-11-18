import { useEffect, useRef } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse } from "@noishi/rpc-bridge";

export function DialogLayer({
	dialog,
	onAnswer,
}: {
	dialog: ExtensionUiRequest;
	onAnswer: (response: ExtensionUiResponse) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				onAnswer({ id: dialog.id, cancelled: true });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dialog.id, onAnswer]);

	const options = "options" in dialog ? dialog.options : undefined;
	const placeholder = "placeholder" in dialog ? dialog.placeholder : undefined;
	const prefill = "prefill" in dialog ? dialog.prefill : undefined;
	const title = "title" in dialog ? dialog.title ?? "Aprovação" : "Aprovação";

	return (
		<div className="dialog-layer">
			<div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
				<h4 className="dialog-title">{title}</h4>
				{"message" in dialog && dialog.message ? <p className="dialog-message">{dialog.message}</p> : null}
				{options?.length ? (
					<div className="dialog-chips">
						{options.map((option) => (
							<button key={option} className="chip chip--mono" type="button" onClick={() => onAnswer({ id: dialog.id, value: option })}>
								{option}
							</button>
						))}
					</div>
				) : null}
				{dialog.method === "input" ? (
					<input
						ref={inputRef}
						className="field"
						autoFocus
						defaultValue={placeholder && !placeholder.startsWith("/") && !placeholder.startsWith("~") && !placeholder.startsWith("ex.") ? "" : undefined}
						placeholder={placeholder ?? ""}
						aria-label={title}
						onKeyDown={(e) => {
							if (e.key !== "Enter") return;
							const value = e.currentTarget.value.trim();
							if (value) onAnswer({ id: dialog.id, value });
						}}
					/>
				) : null}
				{dialog.method === "editor" ? (
					<textarea
						ref={textareaRef}
						autoFocus
						defaultValue={prefill ?? ""}
						aria-label={title}
						onKeyDown={(e) => {
							const value = e.currentTarget.value.trim();
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value) onAnswer({ id: dialog.id, value });
						}}
					/>
				) : null}
				<div className="dialog-actions">
					{dialog.method === "confirm" ? (
						<>
							<button className="btn" type="button" onClick={() => onAnswer({ id: dialog.id, confirmed: false })}>Recusar</button>
							<button className="btn btn--primary" type="button" onClick={() => onAnswer({ id: dialog.id, confirmed: true })}>Aprovar</button>
						</>
					) : dialog.method === "editor" ? (
						<>
							<button className="btn" type="button" onClick={() => onAnswer({ id: dialog.id, cancelled: true })}>Cancelar</button>
							<button
								className="btn btn--primary"
								type="button"
								onClick={() => {
									const value = textareaRef.current?.value.trim();
									if (value) onAnswer({ id: dialog.id, value });
								}}
							>
								Salvar e reenviar
							</button>
						</>
					) : dialog.method === "input" ? (
						<>
							<button className="btn" type="button" onClick={() => onAnswer({ id: dialog.id, cancelled: true })}>Cancelar</button>
							<button
								className="btn btn--primary"
								type="button"
								onClick={() => {
									const value = inputRef.current?.value.trim();
									if (value) onAnswer({ id: dialog.id, value });
								}}
							>
								Salvar
							</button>
						</>
					) : (
						<button className="btn" type="button" onClick={() => onAnswer({ id: dialog.id, cancelled: true })}>Cancelar</button>
					)}
				</div>
			</div>
		</div>
	);
}
