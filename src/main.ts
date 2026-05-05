import {Notice, Plugin, requestUrl, TFile, TFolder} from 'obsidian';
import {registerPlaudCommands} from './commands';
import {type PlaudPluginSettings, normalizeSettings, toPersistedSettings} from './settings-schema';
import {PlaudSettingTab} from './settings';
import {createPlaudSyncRuntime, type PlaudSyncRuntime, type SyncTrigger} from './sync-runtime';
import {createObsidianPlaudApiClient} from './plaud-api-obsidian';
import {getPlaudToken} from './secret-store';
import {normalizePlaudDetail} from './plaud-normalizer';
import {renderPlaudMarkdown} from './plaud-renderer';
import {isTrashedFile, runPlaudSync, type PlaudSyncSummary} from './plaud-sync';
import {type PlaudVaultAdapter, upsertPlaudNote} from './plaud-vault';
import {PlaudApiError, type PlaudApiClient, type PlaudFileDetail} from './plaud-api';
import {DEFAULT_RETRY_POLICY, sanitizeTelemetryMessage, type RetryTelemetryEvent, withRetry} from './plaud-retry';
import {hydratePlaudDetailContent} from './plaud-content-hydrator';
import {ObsidianProgressReporter} from './obsidian-progress-reporter';
import {NoOpProgressReporter} from './progress-reporter';

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Unknown error';
}

function toActionableMessage(error: unknown): string {
	if (error instanceof PlaudApiError) {
		if (error.category === 'auth') {
			return 'authentication failed. Re-save your Plaud token in settings.';
		}
		if (error.category === 'rate_limit') {
			return 'rate limited by Plaud API. Wait briefly and retry.';
		}
		if (error.category === 'network') {
			return 'network error. Check your connection and retry.';
		}
		if (error.category === 'server') {
			return 'Plaud API is temporarily unavailable. Retry shortly.';
		}
		if (error.category === 'invalid_response') {
			return 'unexpected API response format. Retry and inspect logs if it persists.';
		}
	}

	return sanitizeTelemetryMessage(toErrorMessage(error));
}

function formatSyncSummary(summary: PlaudSyncSummary): string {
	const parts = [`Created ${summary.created}`, `updated ${summary.updated}`];
	if (summary.renamed > 0) {
		parts.push(`renamed ${summary.renamed}`);
	}
	parts.push(`skipped ${summary.skipped}`, `failed ${summary.failed}`);
	return `Plaud sync complete. ${parts.join(', ')}.`;
}

export default class PlaudSyncPlugin extends Plugin {
	settings: PlaudPluginSettings;
	private syncRuntime: PlaudSyncRuntime | null = null;
	private statusBarItem: HTMLElement | null = null;

	async onload(): Promise<void> {
		// Add status bar item for progress display
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('');
		
		console.log('[plaud-sync] Plugin loading...');
		await this.loadSettings();
		this.syncRuntime = createPlaudSyncRuntime({
			isStartupEnabled: () => this.settings.syncOnStartup,
			runSync: async (trigger) => this.runSync(trigger),
			onLocked: (message) => {
				new Notice(message);
			}
		});

		registerPlaudCommands(this);
		this.addSettingTab(new PlaudSettingTab(this.app, this));

		console.log('[plaud-sync] Plugin loaded successfully');
		void this.syncRuntime.runStartupSync();
	}

	async onunload(): Promise<void> {
		console.log('[plaud-sync] Plugin unloading...');
		
		// Cancel any in-flight sync operations
		if (this.syncRuntime) {
			if (this.syncRuntime.isRunning()) {
				console.log('[plaud-sync] Waiting for sync to complete...');
				await this.syncRuntime.cancel();
			}
			this.syncRuntime = null;
		}
		
		// Clear status bar
		if (this.statusBarItem) {
			this.statusBarItem.setText('');
			this.statusBarItem = null;
		}
		
		console.log('[plaud-sync] Plugin unloaded successfully');
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(toPersistedSettings(this.settings));
	}

	async runPlaudSyncNow(): Promise<void> {
		await this.ensureSyncRuntime().runManualSync();
	}

	async validatePlaudToken(): Promise<void> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			new Notice('Plaud token missing. Configure it in settings before validation.');
			return;
		}

		try {
			const api = createObsidianPlaudApiClient({
				apiDomain: this.settings.apiDomain,
				token
			});

			const files = await this.retryApiCall('validate_token.list_files', async () => api.listFiles());
			const activeCount = files.filter((file) => !isTrashedFile(file)).length;
			new Notice(`Plaud token is valid. Active recordings visible: ${activeCount}.`);
		} catch (error) {
			this.logFailure('validate_token_failed', error);
			new Notice(`Plaud token validation failed: ${toActionableMessage(error)}`);
		}
	}

	async deleteEmptyFolders(): Promise<void> {
		const syncFolder = this.settings.syncFolder.replace(/\/+$/, '').trim() || 'Plaud';
		
		try {
			let totalDeleted = 0;
			let deletedInPass = 0;
			
			// Keep iterating until no more empty folders are found
			do {
				deletedInPass = await this.deleteEmptyFoldersPass(syncFolder);
				totalDeleted += deletedInPass;
			} while (deletedInPass > 0);
			
			if (totalDeleted === 0) {
				new Notice('No empty folders found.');
			} else {
				new Notice(`Deleted ${totalDeleted} empty folder${totalDeleted === 1 ? '' : 's'}.`);
			}
		} catch (error) {
			this.logFailure('delete_empty_folders_failed', error);
			new Notice(`Failed to delete empty folders: ${toActionableMessage(error)}`);
		}
	}

	private async deleteEmptyFoldersPass(folderPath: string): Promise<number> {
		let deletedCount = 0;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		
		if (!folder || !(folder instanceof TFolder)) {
			return deletedCount;
		}

		// Collect all subfolders first to avoid iterator issues during deletion
		const subfolders: string[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				subfolders.push(child.path);
			}
		}

		// Process subfolders (depth-first)
		for (const subfolderPath of subfolders) {
			deletedCount += await this.deleteEmptyFoldersPass(subfolderPath);
		}

		// After processing children, check if this folder is now empty
		// Re-fetch the folder to get updated children list
		const updatedFolder = this.app.vault.getAbstractFileByPath(folderPath);
		if (updatedFolder && updatedFolder instanceof TFolder && updatedFolder.children.length === 0) {
			try {
				await this.app.vault.delete(updatedFolder);
				deletedCount++;
			} catch (error) {
				console.warn(`[plaud-sync] Failed to delete empty folder: ${folderPath}`, error);
			}
		}

		return deletedCount;
	}

	private ensureSyncRuntime(): PlaudSyncRuntime {
		if (!this.syncRuntime) {
			this.syncRuntime = createPlaudSyncRuntime({
				isStartupEnabled: () => this.settings.syncOnStartup,
				runSync: async (trigger) => this.runSync(trigger),
				onLocked: (message) => {
					new Notice(message);
				}
			});
		}

		return this.syncRuntime;
	}

	private async runSync(trigger: SyncTrigger): Promise<void> {
		console.log(`[plaud-sync] Starting ${trigger} sync...`);
		try {
			const summary = await this.executeSyncBatch(trigger);
			console.log('[plaud-sync] Sync completed:', {
				listed: summary.listed,
				selected: summary.selected,
				created: summary.created,
				updated: summary.updated,
				renamed: summary.renamed,
				skipped: summary.skipped,
				failed: summary.failed,
				checkpointBefore: new Date(summary.lastSyncAtMsBefore).toISOString(),
				checkpointAfter: new Date(summary.lastSyncAtMsAfter).toISOString()
			});
			if (trigger === 'manual') {
				if (summary.selected === 0 && summary.listed > 0) {
					new Notice(`Plaud sync: No new recordings since last sync (${summary.listed} total recordings).`);
				} else {
					new Notice(formatSyncSummary(summary));
				}
			}
		} catch (error) {
			this.logFailure('sync_failed', error);
			new Notice(`Plaud sync failed: ${toActionableMessage(error)}`);
		}
	}

	private async executeSyncBatch(trigger: SyncTrigger): Promise<PlaudSyncSummary> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			throw new Error('Plaud token missing. Configure it in settings before syncing.');
		}

		const api = createObsidianPlaudApiClient({
			apiDomain: this.settings.apiDomain,
			token
		});
		const resilientApi: PlaudApiClient = {
			listFiles: async () => this.retryApiCall('sync.list_files', async () => api.listFiles()),
			getFileDetail: async (fileId: string) => {
				const detail = await this.retryApiCall(`sync.file_detail.${fileId}`, async () => api.getFileDetail(fileId));
				const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
					return this.retryApiCall(`sync.content_fetch.${fileId}`, async () => this.fetchSignedContent(url));
				});

				if (typeof hydrated.id === 'string' && hydrated.id.trim().length > 0) {
					return hydrated as PlaudFileDetail;
				}

				return detail;
			},
			listFiletags: async () => this.retryApiCall('sync.list_filetags', async () => api.listFiletags())
		};

		// Create progress reporter for all syncs (both manual and startup)
		const progress = new ObsidianProgressReporter('Plaud sync', this.statusBarItem);

		return runPlaudSync({
			api: resilientApi,
			vault: this.createVaultAdapter(),
			settings: {
				syncFolder: this.settings.syncFolder,
				filenamePattern: this.settings.filenamePattern,
				updateExisting: this.settings.updateExisting,
				excludeWithoutTranscript: this.settings.excludeWithoutTranscript,
				lastSyncAtMs: this.settings.lastSyncAtMs
			},
			saveCheckpoint: async (nextLastSyncAtMs) => {
				this.settings.lastSyncAtMs = nextLastSyncAtMs;
				await this.saveSettings();
			},
			normalizeDetail: normalizePlaudDetail,
			renderMarkdown: renderPlaudMarkdown,
			upsertNote: upsertPlaudNote,
			progress
		});
	}

	private async retryApiCall<T>(operation: string, execute: () => Promise<T>): Promise<T> {
		return withRetry(operation, execute, {
			policy: DEFAULT_RETRY_POLICY,
			onRetry: (event) => {
				this.logRetry(event);
			}
		});
	}

	private logRetry(event: RetryTelemetryEvent): void {
		console.warn('[plaud-sync] retry', {
			operation: event.operation,
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			category: event.category ?? 'unknown',
			status: typeof event.status === 'number' ? event.status : null,
			message: event.message
		});
	}

	private logFailure(event: string, error: unknown): void {
		console.warn('[plaud-sync] failure', {
			event,
			category: error instanceof PlaudApiError ? error.category : 'unknown',
			status: error instanceof PlaudApiError && typeof error.status === 'number' ? error.status : null,
			message: sanitizeTelemetryMessage(toErrorMessage(error))
		});
	}

	private async fetchSignedContent(url: string): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'GET',
			throw: false
		});

		if (response.status >= 400) {
			throw new Error(`Signed content fetch failed with HTTP ${response.status}.`);
		}

		const parsedJson: unknown = (response as {json?: unknown}).json;
		if (parsedJson !== null && parsedJson !== undefined) {
			return parsedJson;
		}

		const text = typeof response.text === 'string' ? response.text.trim() : '';
		if (!text) {
			return '';
		}

		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private createVaultAdapter(): PlaudVaultAdapter {
		return {
			ensureFolder: async (folder) => {
				const normalized = folder.replace(/\/+$/, '').trim();
				if (!normalized) {
					return;
				}

				// Check if folder already exists
				const existing = this.app.vault.getAbstractFileByPath(normalized);
				if (existing) {
					// Verify it's actually a folder, not a file
					if (!(existing instanceof TFolder)) {
						throw new Error(`Path exists but is not a folder: ${normalized}`);
					}
					return;
				}

				try {
					await this.app.vault.createFolder(normalized);
				} catch (error) {
					// Double-check if folder was created by another process
					const recheck = this.app.vault.getAbstractFileByPath(normalized);
					if (!recheck || !(recheck instanceof TFolder)) {
						const message = error instanceof Error ? error.message : 'Unknown error';
						throw new Error(`Unable to create folder '${normalized}': ${message}`);
					}
				}
			},
			listMarkdownFiles: (folder) => {
				const normalized = folder.replace(/\/+$/, '');
				const prefix = `${normalized}/`;
				return Promise.resolve(
					this.app.vault
						.getMarkdownFiles()
						.map((file) => file.path)
						.filter((filePath) => filePath.startsWith(prefix))
				);
			},
			read: async (path) => {
				const file = this.requireFile(path);
				try {
					return await this.app.vault.cachedRead(file);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					throw new Error(`Failed to read file '${path}': ${message}`);
				}
			},
			write: async (path, content) => {
				const file = this.requireFile(path);
				
				// Validate content is not empty for safety
				if (typeof content !== 'string') {
					throw new Error(`Invalid content type for write operation: ${typeof content}`);
				}
				
				try {
					await this.app.vault.modify(file, content);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					throw new Error(`Failed to write file '${path}': ${message}`);
				}
			},
			create: async (path, content) => {
				// Validate path doesn't already exist
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing) {
					throw new Error(`Cannot create file, path already exists: ${path}`);
				}
				
				// Validate content
				if (typeof content !== 'string') {
					throw new Error(`Invalid content type for create operation: ${typeof content}`);
				}
				
				// Validate path format
				if (!path.endsWith('.md')) {
					throw new Error(`Invalid file path, must end with .md: ${path}`);
				}
				
				try {
					await this.app.vault.create(path, content);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					throw new Error(`Failed to create file '${path}': ${message}`);
				}
			},
			rename: async (oldPath, newPath) => {
				// Validate source file exists
				const sourceFile = this.requireFile(oldPath);
				
				// Validate target doesn't exist
				const targetExists = this.app.vault.getAbstractFileByPath(newPath);
				if (targetExists) {
					throw new Error(`Cannot rename, target path already exists: ${newPath}`);
				}
				
				// Validate paths are different
				if (oldPath === newPath) {
					throw new Error(`Source and target paths are identical: ${oldPath}`);
				}
				
				// Validate new path format
				if (!newPath.endsWith('.md')) {
					throw new Error(`Invalid target path, must end with .md: ${newPath}`);
				}
				
				try {
					await this.app.vault.rename(sourceFile, newPath);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					throw new Error(`Failed to rename '${oldPath}' to '${newPath}': ${message}`);
				}
			},
			getFrontmatterFileId: (path) => {
				// Use Obsidian's MetadataCache for fast frontmatter access
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					return null;
				}
				
				const cache = this.app.metadataCache.getFileCache(file);
				const fileId = cache?.frontmatter?.file_id;
				
				// Handle both string and quoted string values
				if (typeof fileId === 'string') {
					return fileId.trim() || null;
				}
				
				return null;
			}
		};
	}

	private requireFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`Markdown file not found in vault: ${path}`);
		}

		return file;
	}
}
