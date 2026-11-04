function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function firstString(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}

	return '';
}

function hasTranscript(detail: Record<string, unknown>): boolean {
	if (typeof detail.transcript_text === 'string' && detail.transcript_text.trim()) {
		return true;
	}
	if (typeof detail.full_text === 'string' && detail.full_text.trim()) {
		return true;
	}
	if (Array.isArray(detail.transcript) && detail.transcript.length > 0) {
		return true;
	}

	const transResult = detail.trans_result;
	if (isRecord(transResult)) {
		if (typeof transResult.full_text === 'string' && transResult.full_text.trim()) {
			return true;
		}
		if (Array.isArray(transResult.paragraphs) && transResult.paragraphs.length > 0) {
			return true;
		}
		if (Array.isArray(transResult.sentences) && transResult.sentences.length > 0) {
			return true;
		}
	}

	return false;
}

function hasSummary(detail: Record<string, unknown>): boolean {
	if (typeof detail.summary === 'string' && detail.summary.trim()) {
		return true;
	}

	const aiContent = detail.ai_content;
	if (isRecord(aiContent)) {
		const summary = firstString([
			aiContent.summary,
			aiContent.abstract,
			aiContent.ai_content
		]);
		if (summary) {
			return true;
		}
	}

	return false;
}

function isEmptyContent(content: unknown): boolean {
	if (typeof content === 'string') {
		return content.trim().length === 0;
	}
	if (Array.isArray(content)) {
		return content.length === 0;
	}
	if (isRecord(content)) {
		const segments = content.trans_result ?? content.segments;
		return Array.isArray(segments) && segments.length === 0;
	}

	return content === null || content === undefined;
}

function pickContentLink(detail: Record<string, unknown>, dataType: string): string {
	const contentList = Array.isArray(detail.content_list) ? detail.content_list : [];
	for (const item of contentList) {
		if (!isRecord(item)) {
			continue;
		}

		const type = firstString([item.data_type, item.type, item.label, item.name]).toLowerCase();
		if (type === dataType.toLowerCase()) {
			const link = firstString([item.data_link, item.link, item.url]);
			if (link) {
				return link;
			}
		}
	}

	return '';
}

function parseMaybeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function applySummaryContent(detail: Record<string, unknown>, content: unknown): void {
	if (typeof content === 'string') {
		const parsed = parseMaybeJson(content.trim());
		if (typeof parsed === 'string') {
			detail.summary = parsed;
			return;
		}
		applySummaryContent(detail, parsed);
		return;
	}

	if (!isRecord(content)) {
		return;
	}

	const summary = firstString([
		content.ai_content,
		content.summary,
		content.abstract,
		content.content,
		content.text
	]);
	if (summary) {
		detail.summary = summary;
	}

	if (!isRecord(detail.ai_content)) {
		detail.ai_content = {};
	}

	const aiContent = detail.ai_content as Record<string, unknown>;
	for (const key of ['summary', 'highlights', 'key_points', 'abstract', 'content']) {
		if (key in content && !(key in aiContent)) {
			aiContent[key] = content[key];
		}
	}
}

function applyTranscriptContent(detail: Record<string, unknown>, content: unknown): void {
	if (typeof content === 'string') {
		const trimmed = content.trim();
		if (!trimmed) {
			return;
		}

		const parsed = parseMaybeJson(trimmed);
		if (typeof parsed === 'string') {
			detail.transcript_text = parsed;
			return;
		}
		applyTranscriptContent(detail, parsed);
		return;
	}

	if (Array.isArray(content)) {
		detail.transcript = content;
		return;
	}

	if (!isRecord(content)) {
		return;
	}

	const segments = content.trans_result ?? content.segments;
	if (Array.isArray(segments)) {
		detail.transcript = segments;
		return;
	}

	detail.trans_result = content;
}

export async function hydratePlaudDetailContent(
	rawDetail: Record<string, unknown>,
	fetchContent: (url: string) => Promise<unknown>
): Promise<Record<string, unknown>> {
	const detail: Record<string, unknown> = {...rawDetail};

	// A failed download must fail this recording. Carrying on would overwrite an
	// existing note with an empty summary or transcript.
	if (!hasSummary(detail)) {
		const summaryLink = pickContentLink(detail, 'auto_sum_note');
		if (summaryLink) {
			const content = await fetchContent(summaryLink);
			applySummaryContent(detail, content);
			if (!hasSummary(detail) && !isEmptyContent(content)) {
				throw new Error('Plaud summary content had an unrecognized format.');
			}
		}
	}

	if (!hasTranscript(detail)) {
		const transcriptLink = pickContentLink(detail, 'transaction');
		if (transcriptLink) {
			const content = await fetchContent(transcriptLink);
			applyTranscriptContent(detail, content);
			if (!hasTranscript(detail) && !isEmptyContent(content)) {
				throw new Error('Plaud transcript content had an unrecognized format.');
			}
		}
	}

	return detail;
}
