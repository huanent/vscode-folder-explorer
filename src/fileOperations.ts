import * as vscode from 'vscode';

export interface FileEntry {
	name: string;
	uri: string;
	type: 'file' | 'directory';
	size: number;
	created: number;
	modified: number;
}

export interface ClipboardState {
	uris: vscode.Uri[];
	operation: 'cut' | 'copy';
}

export interface PasteResult {
	completedUris: vscode.Uri[];
	changed: boolean;
}

export async function sendDirectory(webview: vscode.Webview, rootUri: vscode.Uri, directoryUri: vscode.Uri): Promise<void> {
	const directoryEntries = (await vscode.workspace.fs.readDirectory(directoryUri))
		.filter(([name]) => name !== '.DS_Store');
	const entries = await Promise.all(
		directoryEntries.map(async ([name, fileType]): Promise<FileEntry> => {
			const uri = vscode.Uri.joinPath(directoryUri, name);
			const stat = await vscode.workspace.fs.stat(uri);
			return {
				name,
				uri: uri.toString(),
				type: fileType & vscode.FileType.Directory ? 'directory' : 'file',
				size: stat.size,
				created: stat.ctime,
				modified: stat.mtime
			};
		})
	);

	entries.sort((left, right) => {
		if (left.type !== right.type) {
			return left.type === 'directory' ? -1 : 1;
		}
		return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
	});

	await webview.postMessage({
		type: 'directory',
		rootUri: rootUri.toString(),
		currentUri: directoryUri.toString(),
		entries
	});
}

export async function calculateDirectorySize(directoryUri: vscode.Uri, token: vscode.CancellationToken): Promise<number> {
	const limit = createConcurrencyLimit(16);

	async function visitDirectory(uri: vscode.Uri): Promise<number> {
		throwIfCancelled(token);
		const entries = await limit(() => vscode.workspace.fs.readDirectory(uri));
		throwIfCancelled(token);
		const sizes = await Promise.all(entries.map(async ([name, fileType]) => {
			throwIfCancelled(token);
			if (fileType & vscode.FileType.SymbolicLink) {
				return 0;
			}

			const entryUri = vscode.Uri.joinPath(uri, name);
			if (fileType & vscode.FileType.Directory) {
				return visitDirectory(entryUri);
			}
			const stat = await limit(() => vscode.workspace.fs.stat(entryUri));
			throwIfCancelled(token);
			return stat.size;
		}));

		return sizes.reduce((total, entrySize) => total + entrySize, 0);
	}

	return visitDirectory(directoryUri);
}

function throwIfCancelled(token: vscode.CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
}

function createConcurrencyLimit(maxConcurrency: number) {
	let activeCount = 0;
	const pending: Array<() => void> = [];

	return async function limit<T>(operation: () => PromiseLike<T>): Promise<T> {
		if (activeCount >= maxConcurrency) {
			await new Promise<void>(resolve => pending.push(resolve));
		}
		activeCount++;

		try {
			return await operation();
		} finally {
			activeCount--;
			pending.shift()?.();
		}
	};
}

export async function renameEntry(targetUri: vscode.Uri): Promise<boolean> {
	const currentName = getDisplayName(targetUri);
	const newName = await vscode.window.showInputBox({
		title: 'Rename',
		prompt: 'Enter a new name',
		value: currentName,
		valueSelection: [0, currentName.length],
		validateInput: value => validateEntryName(value)
	});
	if (newName === undefined || newName === currentName) {
		return false;
	}

	const parentUri = vscode.Uri.joinPath(targetUri, '..');
	await vscode.workspace.fs.rename(targetUri, vscode.Uri.joinPath(parentUri, newName), { overwrite: false });
	return true;
}

function validateEntryName(value: string): string | undefined {
	if (!value.trim()) {
		return 'The name cannot be empty.';
	}
	if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
		return 'The name cannot contain path separators.';
	}
	return undefined;
}

export async function deleteEntries(webview: vscode.Webview, targetUris: vscode.Uri[], permanent: boolean): Promise<void> {
	if (targetUris.length === 0) {
		return;
	}
	if (permanent) {
		const label = targetUris.length === 1 ? `"${getDisplayName(targetUris[0])}"` : `${targetUris.length} items`;
		const choice = await vscode.window.showWarningMessage(
			`Permanently delete ${label}?`,
			{ modal: true, detail: 'This action cannot be undone.' },
			'Delete Permanently'
		);
		if (choice !== 'Delete Permanently') {
			return;
		}
	}

	for (const targetUri of targetUris) {
		await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash: !permanent });
	}
	await webview.postMessage({ type: 'deleted' });
}

export async function pasteEntries(clipboardState: ClipboardState, destinationDirectoryUri: vscode.Uri): Promise<PasteResult> {
	const destinationStat = await vscode.workspace.fs.stat(destinationDirectoryUri);
	if (!(destinationStat.type & vscode.FileType.Directory)) {
		throw new Error('Items can only be pasted into a folder.');
	}
	const completedUris: vscode.Uri[] = [];
	let changed = false;
	for (const sourceUri of clipboardState.uris) {
		const result = await pasteEntry(sourceUri, clipboardState.operation, destinationDirectoryUri);
		changed ||= result.changed;
		if (result.completed) {
			completedUris.push(sourceUri);
		}
	}
	return { completedUris, changed };
}

interface PasteEntryResult {
	completed: boolean;
	changed: boolean;
}

async function pasteEntry(sourceUri: vscode.Uri, operation: 'cut' | 'copy', destinationDirectoryUri: vscode.Uri): Promise<PasteEntryResult> {
	const targetUri = vscode.Uri.joinPath(destinationDirectoryUri, getDisplayName(sourceUri));
	const sourceStat = await vscode.workspace.fs.stat(sourceUri);
	if (targetUri.toString() === sourceUri.toString()) {
		if (sourceStat.type & vscode.FileType.Directory) {
			await confirmDirectoryConflict(targetUri);
		} else {
			await confirmOverwrite(targetUri);
		}
		return { completed: false, changed: false };
	}

	const sourcePath = sourceUri.path.endsWith('/') ? sourceUri.path : `${sourceUri.path}/`;
	if ((sourceStat.type & vscode.FileType.Directory) && destinationDirectoryUri.path.startsWith(sourcePath)) {
		throw new Error('A folder cannot be pasted into itself.');
	}

	let overwrite = false;
	try {
		const targetStat = await vscode.workspace.fs.stat(targetUri);
		if ((sourceStat.type & vscode.FileType.Directory) && (targetStat.type & vscode.FileType.Directory)) {
			const choice = await confirmDirectoryConflict(targetUri);
			if (choice === 'merge') {
				return mergeDirectory(sourceUri, targetUri, operation);
			}
			if (choice !== 'replace') {
				return { completed: false, changed: false };
			}
			await vscode.workspace.fs.delete(targetUri, { recursive: true });
		} else {
			if (!(await confirmOverwrite(targetUri))) {
				return { completed: false, changed: false };
			}
			overwrite = true;
		}
	} catch (error) {
		if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
			throw error;
		}
	}

	if (operation === 'cut') {
		await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite });
	} else {
		await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite });
	}
	return { completed: true, changed: true };
}

async function mergeDirectory(sourceUri: vscode.Uri, targetUri: vscode.Uri, operation: 'cut' | 'copy'): Promise<PasteEntryResult> {
	const entries = await vscode.workspace.fs.readDirectory(sourceUri);
	let completed = true;
	let changed = false;
	for (const [name] of entries) {
		const result = await pasteEntry(vscode.Uri.joinPath(sourceUri, name), operation, targetUri);
		completed &&= result.completed;
		changed ||= result.changed;
	}

	if (operation === 'cut' && completed) {
		await vscode.workspace.fs.delete(sourceUri);
		changed = true;
	}
	return { completed, changed };
}

async function confirmDirectoryConflict(targetUri: vscode.Uri): Promise<'merge' | 'replace' | undefined> {
	const choice = await vscode.window.showWarningMessage(
		`A folder named "${getDisplayName(targetUri)}" already exists.`,
		{ modal: true, detail: 'Merge keeps existing items. Replace deletes the existing folder first.' },
		'Merge',
		'Replace'
	);
	if (choice === 'Merge') {
		return 'merge';
	}
	if (choice === 'Replace') {
		return 'replace';
	}
	return undefined;
}

export async function confirmOverwrite(targetUri: vscode.Uri): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		`Replace "${getDisplayName(targetUri)}"?`,
		{ modal: true, detail: 'An item with the same name already exists in the destination folder.' },
		'Replace'
	);
	return choice === 'Replace';
}

export function getDisplayName(uri: vscode.Uri): string {
	const segments = uri.path.split('/').filter(Boolean);
	return decodeURIComponent(segments.at(-1) ?? uri.path);
}