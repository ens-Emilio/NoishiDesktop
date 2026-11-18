/**
 * Voice input: audio clip -> text, without a cloud dependency by default.
 *
 * Two backends, tried in order:
 *  1. `whisper-cli` / `whisper` on PATH (whisper.cpp or openai-whisper), fed a
 *     temporary WAV decoded by ffmpeg.
 *  2. A user-configured HTTP endpoint (`NOISHI_TRANSCRIBE_URL`) that accepts
 *     multipart audio and answers `{ text }` — for people who already run one.
 *
 * When neither exists the call fails with the install hint instead of silently
 * returning an empty prompt.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./deferred.js";

const TIMEOUT_MS = 120_000;

function which(binary: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, binary))) return join(dir, binary);
	}
	return null;
}

function run(command: string, args: string[], timeout = TIMEOUT_MS): Promise<string> {
	const { promise, resolve, reject } = deferred<string>();
	execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
		if (error) reject(new Error((stderr || error.message).trim().slice(0, 400)));
		else resolve(stdout);
	});
	return promise;
}

export type TranscribeResult = { text: string; backend: "whisper-cli" | "whisper" | "endpoint" };

/** Decode any browser audio blob to 16 kHz mono WAV, which whisper expects. */
async function toWav(input: string, output: string): Promise<void> {
	const ffmpeg = which("ffmpeg");
	if (!ffmpeg) throw new Error("ffmpeg não encontrado — instale ffmpeg para converter o áudio");
	await run(ffmpeg, ["-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output]);
}

export async function transcribe(audioBase64: string, mime: string): Promise<TranscribeResult> {
	const dir = mkdtempSync(join(tmpdir(), "noishi-voice-"));
	const extension = mime.includes("ogg") ? "ogg" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
	const source = join(dir, `clip.${extension}`);
	writeFileSync(source, Buffer.from(audioBase64, "base64"));
	try {
		const endpoint = process.env.NOISHI_TRANSCRIBE_URL;
		if (endpoint) {
			const form = new FormData();
			form.append("file", new Blob([Buffer.from(audioBase64, "base64")], { type: mime }), `clip.${extension}`);
			const response = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
			if (!response.ok) throw new Error(`endpoint respondeu ${response.status}`);
			const payload = (await response.json()) as { text?: string };
			return { text: (payload.text ?? "").trim(), backend: "endpoint" };
		}

		const wav = join(dir, "clip.wav");
		await toWav(source, wav);

		const cli = which("whisper-cli");
		if (cli) {
			const out = join(dir, "out");
			const model = process.env.NOISHI_WHISPER_MODEL?.trim();
			const args = [...(model ? ["-m", model] : []), "-f", wav, "-nt", "-otxt", "-of", out];
			await run(cli, args);
			const text = existsSync(`${out}.txt`) ? readFileSync(`${out}.txt`, "utf-8") : "";
			return { text: text.trim(), backend: "whisper-cli" };
		}
		const whisper = which("whisper");
		if (whisper) {
			const out = join(dir, "out");
			await run(whisper, [wav, "--output_format", "txt", "--output_dir", out, "--fp16", "False"]);
			const file = join(out, "clip.txt");
			const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
			return { text: text.trim(), backend: "whisper" };
		}
		throw new Error(
			"nenhum transcritor: instale whisper.cpp (whisper-cli) ou openai-whisper, ou defina NOISHI_TRANSCRIBE_URL",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
