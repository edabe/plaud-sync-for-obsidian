// Secret IDs may only contain lowercase letters, numbers and dashes.
export const PLAUD_TOKEN_SECRET_KEY = 'plaud-sync-token';
const PLAUD_TOKEN_FALLBACK_KEY = 'plaud-sync.token.fallback';

type SecretStorageLike = {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
};

// Older Obsidian versions have no secretStorage, or no local storage API.
export type SecretStoreHost = {
	secretStorage?: SecretStorageLike;
	loadLocalStorage?: (key: string) => unknown;
	saveLocalStorage?: (key: string, data: unknown) => void;
};

function normalizeToken(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function loadFallbackToken(host: SecretStoreHost): string | null {
	return normalizeToken(host.loadLocalStorage?.(PLAUD_TOKEN_FALLBACK_KEY));
}

function clearFallbackToken(host: SecretStoreHost): void {
	host.saveLocalStorage?.(PLAUD_TOKEN_FALLBACK_KEY, null);
}

function migrateFallbackToken(host: SecretStoreHost, storage: SecretStorageLike, token: string): void {
	try {
		storage.setSecret(PLAUD_TOKEN_SECRET_KEY, token);
		clearFallbackToken(host);
	} catch (error) {
		// Keep the fallback copy so the token still works, and retry on the next read.
		console.warn('[plaud-sync] Failed to move token to secret storage:', error);
	}
}

export async function getPlaudToken(host: SecretStoreHost): Promise<string | null> {
	const storage = host.secretStorage;
	if (!storage) {
		return loadFallbackToken(host);
	}

	const secret = normalizeToken(storage.getSecret(PLAUD_TOKEN_SECRET_KEY));
	if (secret) {
		return secret;
	}

	const fallbackToken = loadFallbackToken(host);
	if (fallbackToken) {
		migrateFallbackToken(host, storage, fallbackToken);
	}

	return fallbackToken;
}

export async function setPlaudToken(host: SecretStoreHost, token: string): Promise<void> {
	const normalizedToken = normalizeToken(token);
	if (!normalizedToken) {
		throw new Error('Plaud token cannot be empty. Paste a valid token string.');
	}

	if (host.secretStorage) {
		host.secretStorage.setSecret(PLAUD_TOKEN_SECRET_KEY, normalizedToken);
		clearFallbackToken(host);
		return;
	}

	if (host.saveLocalStorage) {
		host.saveLocalStorage(PLAUD_TOKEN_FALLBACK_KEY, normalizedToken);
		return;
	}

	throw new Error('No secret storage API is available in this Obsidian runtime.');
}

export async function clearPlaudToken(host: SecretStoreHost): Promise<void> {
	// Secret storage has no delete method, so overwrite the value instead.
	host.secretStorage?.setSecret(PLAUD_TOKEN_SECRET_KEY, '');
	clearFallbackToken(host);
}
