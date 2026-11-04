export type PlaudApiErrorCategory = 'auth' | 'rate_limit' | 'server' | 'network' | 'invalid_response';

export class PlaudApiError extends Error {
	category: PlaudApiErrorCategory;
	status?: number;
	cause?: unknown;

	constructor(category: PlaudApiErrorCategory, message: string, options?: {status?: number; cause?: unknown}) {
		super(message);
		this.name = 'PlaudApiError';
		this.category = category;
		this.status = options?.status;
		this.cause = options?.cause;
	}
}

export interface PlaudFileSummary {
	id: string;
	file_id?: string;
	is_trash?: boolean;
	start_time?: number;
	edit_time?: number;
	folder_name?: string;
}

export interface PlaudFileDetail {
	id: string;
	file_id?: string;
	[key: string]: unknown;
}

export type PlaudRequest = {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	throw?: boolean;
};

export type PlaudRequestResult = {status: number; json: unknown};
export type PlaudRequestFn = (request: PlaudRequest) => Promise<PlaudRequestResult>;

export interface PlaudApiClient {
	listFiles(): Promise<PlaudFileSummary[]>;
	getFileDetail(fileId: string): Promise<PlaudFileDetail>;
}

export interface CreatePlaudApiClientOptions {
	apiDomain: string;
	token: string;
	request: PlaudRequestFn;
}

const V4_BASE_PATH = '/file-app/v4';
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 1000;
const LEGACY_ID_PATTERN = /^[0-9a-f]{32}$/;

// Plaud answers these with HTTP 200, so they need mapping to the auth category.
const AUTH_ERROR_STATUSES = new Set([-3900, -420, -419]);
const REGION_REDIRECT_STATUS = -302;

function normalizeDomain(domain: string): string {
	return domain.trim().replace(/\/+$/, '');
}

function normalizeToken(token: string): string {
	const trimmed = token.trim();
	return trimmed.replace(/^bearer\s+/i, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSuccessStatus(status: unknown): boolean {
	if (typeof status === 'number') {
		return status === 0 || status === 200;
	}

	if (typeof status === 'string') {
		const normalized = status.trim().toLowerCase();
		return normalized === '0' || normalized === '200' || normalized === 'ok' || normalized === 'success';
	}

	return false;
}

function toErrorMessage(msg: unknown, fallback: string): string {
	return typeof msg === 'string' && msg.trim().length > 0 ? msg : fallback;
}

function extractStatus(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}

	const maybeStatus = (error as {status?: unknown}).status;
	return typeof maybeStatus === 'number' ? maybeStatus : undefined;
}

function mapStatusCategory(status: number): PlaudApiErrorCategory {
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (status === 429) {
		return 'rate_limit';
	}
	if (status >= 500) {
		return 'server';
	}
	return 'network';
}

function regionRedirectMessage(envelope: Record<string, unknown>): string {
	const data = isRecord(envelope.data) ? envelope.data : {};
	const domains = isRecord(data.domains) ? data.domains : {};
	const api = typeof domains.api === 'string' ? domains.api.trim() : '';
	return api
		? `Your Plaud account is in another region. Set API domain to ${api} in settings.`
		: 'Your Plaud account is in another region. Update API domain in settings.';
}

function assertSuccessStatus(envelope: Record<string, unknown>): void {
	const status = envelope.status;
	if (isSuccessStatus(status)) {
		return;
	}

	if (status === REGION_REDIRECT_STATUS) {
		throw new PlaudApiError('invalid_response', regionRedirectMessage(envelope));
	}

	const message = toErrorMessage(envelope.msg, 'Plaud API returned non-success status.');
	const category = typeof status === 'number' && AUTH_ERROR_STATUSES.has(status) ? 'auth' : 'invalid_response';
	throw new PlaudApiError(category, message);
}

async function requestJson(
	request: PlaudRequestFn,
	requestParam: PlaudRequest
): Promise<unknown> {
	let response: PlaudRequestResult;

	try {
		response = await request(requestParam);
	} catch (error) {
		const status = extractStatus(error);
		if (status !== undefined) {
			throw new PlaudApiError(mapStatusCategory(status), `Plaud request failed with HTTP ${status}.`, {status, cause: error});
		}

		throw new PlaudApiError('network', 'Plaud request failed due to network/transport error.', {cause: error});
	}

	if (response.status >= 400) {
		throw new PlaudApiError(mapStatusCategory(response.status), `Plaud request failed with HTTP ${response.status}.`, {
			status: response.status
		});
	}

	return response.json;
}

// Recordings made before the 4.0 migration are `of_<legacy id>`. Notes keep the
// legacy id in frontmatter, so it stays the plugin's identifier for them.
function toNoteFileId(v4FileId: string): string {
	return v4FileId.replace(/^of_/, '');
}

function toV4FileId(noteFileId: string): string {
	return LEGACY_ID_PATTERN.test(noteFileId) ? `of_${noteFileId}` : noteFileId;
}

function readNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function unwrapData(json: unknown, malformedMessage: string): Record<string, unknown> {
	if (!isRecord(json)) {
		throw new PlaudApiError('invalid_response', malformedMessage);
	}

	assertSuccessStatus(json);

	if (!isRecord(json.data)) {
		throw new PlaudApiError('invalid_response', malformedMessage);
	}

	return json.data;
}

function readUserFolderName(parentFolder: unknown): string | undefined {
	// Recordings outside a user folder sit in a system folder such as Recordings.
	if (!isRecord(parentFolder) || parentFolder.system_folder_type) {
		return undefined;
	}

	return readString(parentFolder.name) || undefined;
}

// Each recording sits in its own hidden container folder. parent_folder normally
// skips it, except when the container's name differs from the recording's, such
// as "Name (1)". Only then does parent_id match parent_folder.
function hiddenContainerId(item: Record<string, unknown>): string {
	const parentFolder = item.parent_folder;
	if (!isRecord(parentFolder) || parentFolder.system_folder_type) {
		return '';
	}

	const folderId = readString(parentFolder.folder_id);
	return folderId && folderId === readString(item.parent_id) ? folderId : '';
}

function readFolderNameAboveContainer(json: unknown, containerId: string): string | undefined {
	const data = unwrapData(json, 'Plaud file detail payload is malformed.');
	const node = isRecord(data.node) ? data.node : {};
	const breadcrumbs: unknown[] = Array.isArray(node.breadcrumbs) ? node.breadcrumbs : [];
	const containerIndex = breadcrumbs.findIndex((crumb) => isRecord(crumb) && crumb.node_id === containerId);

	return containerIndex > 0 ? readUserFolderName(breadcrumbs[containerIndex - 1]) : undefined;
}

function toFileSummary(item: unknown): PlaudFileSummary | null {
	if (!isRecord(item)) {
		return null;
	}

	const v4FileId = readString(item.file_id);
	if (!v4FileId) {
		return null;
	}

	const id = toNoteFileId(v4FileId);
	const editedAtMs = Math.max(readNumber(item.updated_at_show_ms), readNumber(item.version_ms));

	return {
		id,
		file_id: id,
		// recordings/all leaves out trashed recordings.
		is_trash: false,
		start_time: readNumber(item.created_at_show_ms),
		edit_time: Math.ceil(editedAtMs / 1000),
		folder_name: readUserFolderName(item.parent_folder)
	};
}

function isFinishedContent(object: Record<string, unknown>): boolean {
	const taskStatus = object.task_status;
	return Boolean(readString(object.content_url)) && (taskStatus === null || taskStatus === undefined || taskStatus === 1);
}

function toContentList(objects: unknown): Array<{data_type: string; data_link: string}> {
	const dataTypes: Record<string, string> = {
		TRANSCRIPT: 'transaction',
		SUMMARY: 'auto_sum_note'
	};
	const contentList: Array<{data_type: string; data_link: string}> = [];

	for (const object of Array.isArray(objects) ? objects : []) {
		if (!isRecord(object) || !isFinishedContent(object)) {
			continue;
		}

		const dataType = dataTypes[readString(object.object_type)];
		if (dataType) {
			contentList.push({data_type: dataType, data_link: readString(object.content_url)});
		}
	}

	return contentList;
}

function toFileDetail(json: unknown): PlaudFileDetail {
	const malformedMessage = 'Plaud file detail payload is malformed.';
	const data = unwrapData(json, malformedMessage);
	const node = isRecord(data.node) ? data.node : {};
	const meta = isRecord(data.meta) ? data.meta : {};

	const v4FileId = readString(meta.file_id);
	if (!v4FileId) {
		throw new PlaudApiError('invalid_response', malformedMessage);
	}

	const id = toNoteFileId(v4FileId);
	return {
		id,
		file_id: id,
		file_name: readString(node.name),
		start_time: readNumber(meta.start_time),
		duration: readNumber(meta.duration),
		content_list: toContentList(data.objects)
	};
}

export function createPlaudApiClient(options: CreatePlaudApiClientOptions): PlaudApiClient {
	const request = options.request;
	const apiDomain = normalizeDomain(options.apiDomain);
	const token = normalizeToken(options.token);

	const getJson = (path: string): Promise<unknown> => requestJson(request, {
		url: `${apiDomain}${V4_BASE_PATH}${path}`,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		},
		throw: false
	});

	return {
		async listFiles(): Promise<PlaudFileSummary[]> {
			const files: PlaudFileSummary[] = [];
			let cursor = '';

			for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
				const params = new URLSearchParams({
					sort_by: 'created',
					sort_order: 'desc',
					page_size: String(LIST_PAGE_SIZE)
				});
				if (cursor) {
					params.set('cursor', cursor);
				}

				const data = unwrapData(
					await getJson(`/recordings/all?${params.toString()}`),
					'Plaud file list payload is malformed.'
				);
				if (!Array.isArray(data.items)) {
					throw new PlaudApiError('invalid_response', 'Plaud file list payload must include items.');
				}

				for (const item of data.items) {
					const summary = toFileSummary(item);
					if (!summary) {
						continue;
					}

					const containerId = hiddenContainerId(item as Record<string, unknown>);
					if (containerId) {
						const v4FileId = readString((item as Record<string, unknown>).file_id);
						summary.folder_name = readFolderNameAboveContainer(
							await getJson(`/files/detail/${encodeURIComponent(v4FileId)}`),
							containerId
						);
					}

					files.push(summary);
				}

				cursor = readString(data.next_cursor);
				if (!cursor) {
					return files;
				}
			}

			throw new PlaudApiError('invalid_response', 'Plaud file list did not end. Refusing a partial list.');
		},

		async getFileDetail(fileId: string): Promise<PlaudFileDetail> {
			return toFileDetail(await getJson(`/files/detail/${encodeURIComponent(toV4FileId(fileId))}`));
		}
	};
}
