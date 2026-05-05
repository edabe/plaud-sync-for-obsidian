export interface PlaudVaultAdapter {
	ensureFolder(path: string): Promise<void>;
	listMarkdownFiles(folder: string): Promise<string[]>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	create(path: string, content: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
}

export interface BuildFilenameInput {
	filenamePattern: string;
	date: string;
	title: string;
}

export interface UpsertPlaudNoteInput {
	vault: PlaudVaultAdapter;
	syncFolder: string;
	filenamePattern: string;
	updateExisting: boolean;
	fileId: string;
	title: string;
	date: string;
	markdown: string;
	folderName?: string;
}

export interface UpsertPlaudNoteResult {
	action: 'created' | 'updated' | 'skipped' | 'renamed';
	path: string;
	oldPath?: string;
}

function normalizeFolder(folder: string): string {
	return folder.replace(/\/+$/, '').trim() || 'Plaud';
}

function sanitizeFolderName(folderName: string): string {
	// Replace invalid characters for file systems (Windows, macOS, Linux)
	// Invalid: < > : " / \ | ? * and control characters
	return folderName
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '') // Remove leading dots
		.replace(/\.+$/, ''); // Remove trailing dots
}

function slugify(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-');

	return normalized || 'recording';
}

function extractFrontmatter(content: string): string {
	if (!content.startsWith('---\n')) {
		return '';
	}

	const closing = content.indexOf('\n---\n', 4);
	if (closing === -1) {
		return '';
	}

	return content.slice(4, closing);
}

export function extractFrontmatterFileId(content: string): string {
	const frontmatter = extractFrontmatter(content);
	if (!frontmatter) {
		return '';
	}

	const match = frontmatter.match(/^file_id:\s*(.+)$/m);
	const raw = match?.[1]?.trim() ?? '';
	if (!raw) {
		return '';
	}

	const startsWithDouble = raw.startsWith('"');
	const endsWithDouble = raw.endsWith('"');
	if (startsWithDouble && endsWithDouble && raw.length >= 2) {
		return raw.slice(1, -1).trim();
	}

	const startsWithSingle = raw.startsWith("'");
	const endsWithSingle = raw.endsWith("'");
	if (startsWithSingle && endsWithSingle && raw.length >= 2) {
		return raw.slice(1, -1).trim();
	}

	return raw;
}

export function extractFolderFromPath(path: string, baseFolder: string): string {
	// Remove base folder and filename to get the subfolder
	const normalized = path.replace(/\/+$/, '');
	const baseFolderNormalized = baseFolder.replace(/\/+$/, '');
	
	if (!normalized.startsWith(baseFolderNormalized + '/')) {
		return ''; // File is in base folder, no subfolder
	}
	
	const relativePath = normalized.substring(baseFolderNormalized.length + 1);
	const lastSlash = relativePath.lastIndexOf('/');
	
	if (lastSlash === -1) {
		return ''; // File is directly in base folder
	}
	
	return relativePath.substring(0, lastSlash);
}

export function extractFrontmatterFolder(content: string): string {
	const frontmatter = extractFrontmatter(content);
	if (!frontmatter) {
		return '';
	}

	const match = frontmatter.match(/^plaud_folder:\s*(.+)$/m);
	const raw = match?.[1]?.trim() ?? '';
	if (!raw) {
		return '';
	}

	// Remove quotes if present
	const startsWithDouble = raw.startsWith('"');
	const endsWithDouble = raw.endsWith('"');
	if (startsWithDouble && endsWithDouble && raw.length >= 2) {
		return raw.slice(1, -1).trim();
	}

	const startsWithSingle = raw.startsWith("'");
	const endsWithSingle = raw.endsWith("'");
	if (startsWithSingle && endsWithSingle && raw.length >= 2) {
		return raw.slice(1, -1).trim();
	}

	return raw;
}

function joinPath(folder: string, fileName: string): string {
	return `${folder}/${fileName}`;
}

function withCollisionSuffix(fileName: string, suffix: number): string {
	const dotIndex = fileName.lastIndexOf('.');
	if (dotIndex === -1) {
		return `${fileName}-${suffix}`;
	}

	const base = fileName.slice(0, dotIndex);
	const ext = fileName.slice(dotIndex);
	return `${base}-${suffix}${ext}`;
}

export function buildPlaudFilename(input: BuildFilenameInput): string {
	const pattern = input.filenamePattern.trim() || 'plaud-{date}-{title}';
	const replacedDate = pattern.replace(/\{date\}/g, input.date);
	const filled = replacedDate.replace(/\{title\}/g, slugify(input.title));
	const filename = slugify(filled).replace(/^-+|-+$/g, '');
	return `${filename || 'plaud-recording'}.md`;
}

function resolveAvailablePath(folder: string, initialFileName: string, existingPaths: Set<string>): string {
	let candidate = joinPath(folder, initialFileName);
	if (!existingPaths.has(candidate)) {
		return candidate;
	}

	let suffix = 2;
	while (existingPaths.has(candidate)) {
		candidate = joinPath(folder, withCollisionSuffix(initialFileName, suffix));
		suffix += 1;
	}

	return candidate;
}

export async function upsertPlaudNote(input: UpsertPlaudNoteInput): Promise<UpsertPlaudNoteResult> {
	const baseFolder = normalizeFolder(input.syncFolder);
	
	// Determine target folder: base folder + optional subfolder
	// Sanitize folder name to remove invalid characters (like colons)
	const targetFolder = input.folderName && input.folderName.trim()
		? joinPath(baseFolder, sanitizeFolderName(input.folderName.trim()))
		: baseFolder;
	
	await input.vault.ensureFolder(targetFolder);

	// Search for existing file in ALL subfolders of base folder
	const allPaths = await input.vault.listMarkdownFiles(baseFolder);
	const existingSet = new Set(allPaths);

	const desiredFileName = buildPlaudFilename({
		filenamePattern: input.filenamePattern,
		date: input.date,
		title: input.title
	});

	for (const path of allPaths) {
		const fileId = extractFrontmatterFileId(await input.vault.read(path));
		if (fileId === input.fileId) {
			if (!input.updateExisting) {
				return {action: 'skipped', path};
			}

			// Extract current filename and folder from path
			const currentFileName = path.split('/').pop() || '';
			const currentFolder = path.substring(0, path.lastIndexOf('/'));
			
			// Check if file needs to be moved to a different folder or renamed
			const needsMove = currentFolder !== targetFolder;
			const needsRename = currentFileName !== desiredFileName;
			
			if (needsMove || needsRename) {
				// Remove old path from set and add new path
				existingSet.delete(path);
				const newPath = resolveAvailablePath(targetFolder, desiredFileName, existingSet);
				
				// Rename/move the file and update content
				await input.vault.rename(path, newPath);
				await input.vault.write(newPath, input.markdown);
				return {action: 'renamed', path: newPath, oldPath: path};
			}

			// Same location and filename, just update content
			await input.vault.write(path, input.markdown);
			return {action: 'updated', path};
		}
	}

	const path = resolveAvailablePath(targetFolder, desiredFileName, existingSet);

	await input.vault.create(path, input.markdown);
	return {action: 'created', path};
}
