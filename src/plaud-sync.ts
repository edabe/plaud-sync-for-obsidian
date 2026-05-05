import type {PlaudApiClient, PlaudFileSummary, PlaudFiletag} from './plaud-api';
import type {NormalizedPlaudDetail} from './plaud-normalizer';
import type {PlaudVaultAdapter, UpsertPlaudNoteResult} from './plaud-vault';
import {extractFolderFromPath, extractFrontmatterFolder, extractFrontmatterFileId} from './plaud-vault';

export interface PlaudSyncSettings {
	syncFolder: string;
	filenamePattern: string;
	updateExisting: boolean;
	excludeWithoutTranscript: boolean;
	lastSyncAtMs: number;
}

export interface PlaudSyncFailure {
	fileId: string;
	message: string;
}

export interface PlaudSyncSummary {
	listed: number;
	selected: number;
	created: number;
	updated: number;
	renamed: number;
	skipped: number;
	failed: number;
	lastSyncAtMsBefore: number;
	lastSyncAtMsAfter: number;
	failures: PlaudSyncFailure[];
}

export interface RunPlaudSyncInput {
	api: PlaudApiClient;
	vault: PlaudVaultAdapter;
	settings: PlaudSyncSettings;
	saveCheckpoint: (nextLastSyncAtMs: number) => Promise<void>;
	normalizeDetail: (raw: unknown) => NormalizedPlaudDetail;
	renderMarkdown: (detail: NormalizedPlaudDetail, folderName?: string) => string;
	upsertNote: (input: {
		vault: PlaudVaultAdapter;
		syncFolder: string;
		filenamePattern: string;
		updateExisting: boolean;
		fileId: string;
		title: string;
		date: string;
		markdown: string;
		folderName?: string;
	}) => Promise<UpsertPlaudNoteResult>;
}

function normalizeTimestampMs(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return 0;
	}

	return Math.floor(value);
}

function normalizeBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'number') {
		return value !== 0;
	}

	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'yes';
	}

	return false;
}

function formatDate(timestampMs: number): string {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return '1970-01-01';
	}

	return new Date(timestampMs).toISOString().slice(0, 10);
}

function resolveFileId(summary: PlaudFileSummary): string {
	const preferred = typeof summary.file_id === 'string' ? summary.file_id.trim() : '';
	return preferred || summary.id;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Unknown sync error.';
}

export function isTrashedFile(summary: PlaudFileSummary): boolean {
	return normalizeBoolean(summary.is_trash);
}

export function shouldSyncFile(summary: PlaudFileSummary, lastSyncAtMs: number): boolean {
	if (isTrashedFile(summary)) {
		return false;
	}

	const checkpoint = normalizeTimestampMs(lastSyncAtMs);
	if (checkpoint === 0) {
		return true;
	}

	// Use edit_time to determine if file has changed
	// edit_time is in seconds, convert to milliseconds
	// This covers both new recordings and transcribed/modified notes
	const editTimeSeconds = normalizeTimestampMs(summary.edit_time);
	if (editTimeSeconds === 0) {
		// If edit_time is missing, sync it to be safe
		return true;
	}

	const editTimeMs = editTimeSeconds * 1000;
	return editTimeMs > checkpoint;
}

function sanitizeFolderName(folderName: string): string {
	// Same sanitization as in plaud-vault.ts
	return folderName
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/\.+$/, '');
}

export async function runPlaudSync(input: RunPlaudSyncInput): Promise<PlaudSyncSummary> {
	const checkpointBefore = normalizeTimestampMs(input.settings.lastSyncAtMs);
	const listed = await input.api.listFiles();

	// Fetch filetags (folders) from API
	let filetagMap: Map<string, string> = new Map();
	try {
		const filetags = await input.api.listFiletags();
		filetagMap = new Map(filetags.map((tag: PlaudFiletag) => [tag.id, tag.name]));
		console.log(`[plaud-sync] Fetched ${filetags.length} folders from Plaud`);
	} catch (error) {
		// If filetags fetch fails, continue without folder support
		console.warn('[plaud-sync] Failed to fetch Plaud folders:', error);
	}

	// Build Plaud's file→folder mapping
	const plaudFolderMap = new Map<string, string>();
	for (const file of listed) {
		const filetagId = Array.isArray(file.filetag_id_list) && file.filetag_id_list.length > 0
			? file.filetag_id_list[0]
			: undefined;
		const folderName = filetagId ? filetagMap.get(filetagId) : undefined;
		const sanitizedFolder = folderName ? sanitizeFolderName(folderName) : '';
		plaudFolderMap.set(file.id, sanitizedFolder);
	}

	// Scan vault for folder mismatches
	const folderMismatchIds = new Set<string>();
	try {
		const vaultFiles = await input.vault.listMarkdownFiles(input.settings.syncFolder);
		console.log(`[plaud-sync] Scanning ${vaultFiles.length} vault files for folder mismatches...`);
		
		for (const path of vaultFiles) {
			try {
				const content = await input.vault.read(path);
				const fileId = extractFrontmatterFileId(content);
				
				if (!fileId) continue; // Skip files without file_id
				
				const currentFolder = extractFolderFromPath(path, input.settings.syncFolder);
				const expectedFolder = plaudFolderMap.get(fileId);
				
				if (expectedFolder !== undefined && currentFolder !== expectedFolder) {
					folderMismatchIds.add(fileId);
					console.log(`[plaud-sync] Folder mismatch for ${fileId}: "${currentFolder}" → "${expectedFolder}"`);
				}
			} catch (error) {
				// Skip files that can't be read
				console.warn(`[plaud-sync] Failed to read file ${path}:`, error);
			}
		}
		
		console.log(`[plaud-sync] Found ${folderMismatchIds.size} files with folder mismatches`);
	} catch (error) {
		console.warn('[plaud-sync] Failed to scan vault for folder mismatches:', error);
	}

	// Combine incremental sync with folder mismatch detection
	const selected = listed.filter((summary) => {
		const fileId = resolveFileId(summary);
		return shouldSyncFile(summary, checkpointBefore) || folderMismatchIds.has(fileId);
	});

	console.log(`[plaud-sync] Selected ${selected.length} files to sync (${selected.length - folderMismatchIds.size} by edit_time, ${folderMismatchIds.size} by folder mismatch)`);

	let created = 0;
	let updated = 0;
	let renamed = 0;
	let skipped = 0;
	let failed = 0;
	let checkpointCandidate = checkpointBefore;
	const failures: PlaudSyncFailure[] = [];

	for (const summary of selected) {
		const fileId = resolveFileId(summary);

		try {
			const detail = await input.api.getFileDetail(fileId);
			const normalized = input.normalizeDetail(detail);
			
			// Skip notes without transcription if the setting is enabled
			if (input.settings.excludeWithoutTranscript && !normalized.transcript.trim()) {
				skipped += 1;
				// Update checkpoint using edit_time
				const editTimeSeconds = normalizeTimestampMs(summary.edit_time);
				if (editTimeSeconds > 0) {
					checkpointCandidate = Math.max(checkpointCandidate, editTimeSeconds * 1000);
				}
				continue;
			}
			
			// Resolve folder name from filetag ID
			const folderName = normalized.filetagId ? filetagMap.get(normalized.filetagId) : undefined;
			
			if (normalized.filetagId && !folderName) {
				console.warn(`[plaud-sync] File ${fileId} has filetag_id ${normalized.filetagId} but folder not found in map`);
			}
			
			const markdown = input.renderMarkdown(normalized, folderName);
			const upsertResult = await input.upsertNote({
				vault: input.vault,
				syncFolder: input.settings.syncFolder,
				filenamePattern: input.settings.filenamePattern,
				updateExisting: input.settings.updateExisting,
				fileId: normalized.fileId,
				title: normalized.title,
				date: formatDate(normalized.startAtMs),
				markdown,
				folderName
			});

			if (upsertResult.action === 'created') {
				created += 1;
			} else if (upsertResult.action === 'updated') {
				updated += 1;
			} else if (upsertResult.action === 'renamed') {
				renamed += 1;
			} else {
				skipped += 1;
			}

			// Update checkpoint using edit_time
			const editTimeSeconds = normalizeTimestampMs(summary.edit_time);
			if (editTimeSeconds > 0) {
				checkpointCandidate = Math.max(checkpointCandidate, editTimeSeconds * 1000);
			}
		} catch (error) {
			failed += 1;
			const errorMsg = toErrorMessage(error);
			failures.push({
				fileId,
				message: errorMsg
			});
			console.error(`[plaud-sync] Failed to sync file ${fileId}:`, errorMsg);
		}
	}

	let checkpointAfter = checkpointBefore;
	// Save checkpoint even if there were failures, as long as we made progress
	if (checkpointCandidate > checkpointBefore) {
		await input.saveCheckpoint(checkpointCandidate);
		checkpointAfter = checkpointCandidate;
		console.log(`[plaud-sync] Checkpoint advanced from ${new Date(checkpointBefore).toISOString()} to ${new Date(checkpointAfter).toISOString()}`);
	}

	return {
		listed: listed.length,
		selected: selected.length,
		created,
		updated,
		renamed,
		skipped,
		failed,
		lastSyncAtMsBefore: checkpointBefore,
		lastSyncAtMsAfter: checkpointAfter,
		failures
	};
}
