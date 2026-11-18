/**
 * Deferred promise. `Promise.withResolvers` needs ES2024 lib; the desktop
 * targets ES2023, so the three call sites that need an external resolver share
 * this instead of hand-rolling the executor each time.
 */

export type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
};

export function deferred<T>(): Deferred<T> {
	let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
	let reject: (reason?: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
