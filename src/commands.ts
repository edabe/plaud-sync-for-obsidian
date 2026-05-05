export interface PlaudCommandHost {
	addCommand(command: {id: string; name: string; callback: () => void}): void;
	runPlaudSyncNow(): Promise<void>;
	validatePlaudToken(): Promise<void>;
	deleteEmptyFolders(): Promise<void>;
}

export function registerPlaudCommands(plugin: PlaudCommandHost): void {
	plugin.addCommand({
		id: 'sync-now',
		name: 'Sync now',
		callback: () => {
			void plugin.runPlaudSyncNow();
		}
	});

	plugin.addCommand({
		id: 'validate-token',
		name: 'Validate token',
		callback: () => {
			void plugin.validatePlaudToken();
		}
	});

	plugin.addCommand({
		id: 'delete-empty-folders',
		name: 'Delete empty folders',
		callback: () => {
			void plugin.deleteEmptyFolders();
		}
	});
}
