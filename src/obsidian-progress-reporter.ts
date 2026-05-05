import {Notice} from 'obsidian';
import type {ProgressReporter} from './progress-reporter';

/**
 * Obsidian-specific progress reporter that uses status bar only.
 * No notice popups during progress to avoid distraction.
 */
export class ObsidianProgressReporter implements ProgressReporter {
	private readonly operation: string;
	private statusBarItem: HTMLElement | null;

	constructor(operation: string, statusBarItem: HTMLElement | null) {
		this.operation = operation;
		this.statusBarItem = statusBarItem;
	}

	report(current: number, total: number, message?: string): void {
		const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
		const statusText = message
			? `${this.operation}: ${message}`
			: `${this.operation}: ${current}/${total} (${percentage}%)`;

		// Update status bar only (no notices during progress)
		if (this.statusBarItem) {
			this.statusBarItem.setText(statusText);
		}
	}

	complete(message?: string): void {
		const statusText = message || `${this.operation} complete`;

		// Clear status bar
		if (this.statusBarItem) {
			this.statusBarItem.setText('');
		}

		// Show completion notice (auto-hide after 4 seconds)
		new Notice(statusText, 4000);
	}

	error(message: string): void {
		// Clear status bar
		if (this.statusBarItem) {
			this.statusBarItem.setText('');
		}

		// Show error notice (auto-hide after 6 seconds)
		new Notice(`${this.operation} error: ${message}`, 6000);

		console.error(`[${this.operation}] Error: ${message}`);
	}
}

// Made with Bob
