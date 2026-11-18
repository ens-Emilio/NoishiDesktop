import { useSyncExternalStore } from "react";

export type Store<T> = {
	getState: () => T;
	setState: (updater: Partial<T> | ((prev: T) => T)) => void;
	subscribe: (listener: () => void) => () => void;
};

export function createStore<T extends object>(initial: T): Store<T> {
	let state = initial;
	const listeners = new Set<() => void>();

	const getState = (): T => state;

	const setState = (updater: Partial<T> | ((prev: T) => T)): void => {
		const next = typeof updater === "function" ? updater(state) : { ...state, ...updater };
		if (Object.is(next, state)) return;
		state = next;
		for (const listener of listeners) listener();
	};

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	return { getState, setState, subscribe };
}

export function useStore<T extends object, S = T>(
	store: Store<T>,
	selector: (state: T) => S = (s) => s as unknown as S,
): S {
	return useSyncExternalStore(
		store.subscribe,
		() => selector(store.getState()),
		() => selector(store.getState()),
	);
}
