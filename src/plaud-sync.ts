import type {PlaudApiClient, PlaudFileSummary, PlaudFiletag} from './plaud-api';
import type {NormalizedPlaudDetail} from './plaud-normalizer';
import type {PlaudVaultAdapter, UpsertPlaudNoteResult} from './plaud-vault';

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

	const startAtMs = normalizeTimestampMs(summary.start_time);
	if (startAtMs === 0) {
		return true;
	}

	return startAtMs > checkpoint;
}

export async function runPlaudSync(input: RunPlaudSyncInput): Promise<PlaudSyncSummary> {
	const checkpointBefore = normalizeTimestampMs(input.settings.lastSyncAtMs);
	const listed = await input.api.listFiles();
	const selected = listed.filter((summary) => shouldSyncFile(summary, checkpointBefore));

	// Fetch filetags (folders) from API
	let filetagMap: Map<string, string> = new Map();
	try {
		const filetags = await input.api.listFiletags();
		filetagMap = new Map(filetags.map((tag: PlaudFiletag) => [tag.id, tag.name]));
	} catch (error) {
		// If filetags fetch fails, continue without folder support
		console.warn('Failed to fetch Plaud folders:', error);
	}

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
				checkpointCandidate = Math.max(
					checkpointCandidate,
					normalizeTimestampMs(summary.start_time),
					normalizeTimestampMs(normalized.startAtMs)
				);
				continue;
			}
			
			// Resolve folder name from filetag ID
			const folderName = normalized.filetagId ? filetagMap.get(normalized.filetagId) : undefined;
			
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

			checkpointCandidate = Math.max(
				checkpointCandidate,
				normalizeTimestampMs(summary.start_time),
				normalizeTimestampMs(normalized.startAtMs)
			);
		} catch (error) {
			failed += 1;
			failures.push({
				fileId,
				message: toErrorMessage(error)
			});
		}
	}

	let checkpointAfter = checkpointBefore;
	if (failed === 0 && checkpointCandidate > checkpointBefore) {
		await input.saveCheckpoint(checkpointCandidate);
		checkpointAfter = checkpointCandidate;
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
